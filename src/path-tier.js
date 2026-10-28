import { FIND_CAP, GREP_CAP, RANK_WINDOW, pageLimit } from "./limits.js";
import { isConfigPath, isDocsPath, pathTier } from "./path-class.js";

export { isConfigPath, isDocsPath, pathTier };

export function identifierAt(text, column) {
  const line = String(text ?? "");
  const index = Math.max(0, Math.min(line.length - 1, (column || 1) - 1));
  if (!/[A-Za-z0-9_$]/.test(line[index] || "")) return null;
  let start = index;
  let end = index;
  while (start > 0 && /[A-Za-z0-9_$]/.test(line[start - 1])) start -= 1;
  while (end < line.length - 1 && /[A-Za-z0-9_$]/.test(line[end + 1])) end += 1;
  return line.slice(start, end + 1);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The identifier a grep pattern is really asking about: the pattern itself for
// a bare name, else the trailing identifier of 'class Foo' / 'def foo'.
function patternName(pattern) {
  const matches = String(pattern ?? "").match(/[A-Za-z_$][\w$]*/g);
  return matches ? matches[matches.length - 1] : null;
}

// How strongly a hit line names the pattern: 3 = defines the exact name,
// 2 = binds or imports the exact name, 1 = defines/binds a wider identifier
// the pattern merely sits inside, 0 = mention only. The weight doubles as the
// cross-file ordering signal: a file that defines the name outranks files that
// only use it.
export function preferredHitWeight(hit, pattern) {
  const raw = String(hit.text ?? "");
  const text = raw.trim();
  const pname = patternName(pattern);
  const names = new Set(
    [pname, identifierAt(raw, hit.column)].filter(Boolean),
  );
  let weight = 0;
  for (const name of names) {
    const escaped = escapeRegExp(name);
    // Grep matches smartCase by default, so exactness ignores case too.
    const exact = pname != null && name.toLowerCase() === pname.toLowerCase() ? 2 : 0;
    if (
      new RegExp(
        `(?:^|\\s)(?:async\\s+)?(?:def|function|func|fn|fun|class|interface|struct|trait|type|enum|const|let|var|val)\\s+${escaped}\\b`,
        "i",
      ).test(text)
    ) {
      weight = Math.max(weight, 1 + exact);
    } else if (
      new RegExp(`(?:^|[^\\w$])${escaped}\\s*=(?![=>])`, "i").test(text) ||
      new RegExp(`(?:^|[^\\w$])${escaped}\\s*:(?!:)`, "i").test(text) ||
      new RegExp(`\\bimport\\b[^\\n]*[^\\w$]${escaped}\\b`, "i").test(text)
    ) {
      weight = Math.max(weight, exact || 1);
    }
  }
  if (names.size === 0 && weight === 0) {
    return /^(?:export\s+)?(?:async\s+)?(?:def|function|func|fn|class|const|let|var|val|interface|struct|type|enum)\b/.test(
      text,
    )
      ? 1
      : 0;
  }
  return weight;
}

export function isPreferredHit(hit, pattern) {
  return preferredHitWeight(hit, pattern) > 0;
}

export function isExactFindMatch(matchType) {
  return matchType === "exact" || matchType === "exact_filename";
}

export function rankFindResults(results) {
  const items = (results || []).map((item, index) => ({ item, index }));
  items.sort((a, b) => {
    const aTier = pathTier(a.item.path);
    const bTier = pathTier(b.item.path);
    if (aTier !== bTier) return aTier - bTier;
    const aPin = aTier === 0 && isExactFindMatch(a.item.matchType) ? 0 : 1;
    const bPin = bTier === 0 && isExactFindMatch(b.item.matchType) ? 0 : 1;
    if (aPin !== bPin) return aPin - bPin;
    return a.index - b.index;
  });
  return items.map((entry) => entry.item);
}

function orderHitsInFile(hits, pattern) {
  return hits
    .map((hit) => ({ hit, weight: preferredHitWeight(hit, pattern) }))
    .sort((a, b) => b.weight - a.weight || a.hit.line - b.hit.line)
    .map((entry) => entry.hit);
}

function roundRobinFiles(groups) {
  const queues = groups.map((group) => [...group.hits]);
  const ordered = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const queue of queues) {
      if (queue.length === 0) continue;
      ordered.push(queue.shift());
      progressed = true;
    }
  }
  return ordered;
}

export function rankGrepHits(hits, pattern) {
  const groups = [];
  const firstSeen = new Map();
  for (const hit of hits || []) {
    if (!firstSeen.has(hit.path)) {
      firstSeen.set(hit.path, groups.length);
      groups.push({ path: hit.path, hits: [] });
    }
    groups[firstSeen.get(hit.path)].hits.push(hit);
  }
  for (const group of groups) {
    group.hits = orderHitsInFile(group.hits, pattern);
    group.tier = pathTier(group.path);
    // orderHitsInFile puts the strongest hit first, so hits[0] is this file's
    // best claim on the pattern: a definition outranks files that only
    // mention it.
    group.weight =
      group.hits.length > 0 ? preferredHitWeight(group.hits[0], pattern) : 0;
  }
  groups.sort((a, b) => {
    const tier = a.tier - b.tier;
    if (tier) return tier;
    if (a.weight !== b.weight) return b.weight - a.weight;
    return firstSeen.get(a.path) - firstSeen.get(b.path);
  });
  const ordered = [];
  let index = 0;
  while (index < groups.length) {
    let end = index + 1;
    while (end < groups.length && groups[end].tier === groups[index].tier) {
      end += 1;
    }
    ordered.push(...roundRobinFiles(groups.slice(index, end)));
    index = end;
  }
  return ordered;
}

export function applyFindWindow(results, limit) {
  return rankFindResults(results).slice(
    0,
    pageLimit(limit, RANK_WINDOW, FIND_CAP),
  );
}

export function applyGrepWindow(hits, pattern, limit, offset = 0) {
  const ranked = rankGrepHits(hits, pattern);
  const cap = pageLimit(limit, RANK_WINDOW, GREP_CAP);
  const start = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
  return {
    ranked,
    page: ranked.slice(start, start + cap),
  };
}
