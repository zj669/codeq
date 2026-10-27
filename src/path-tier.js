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

export function isPreferredHit(hit, pattern) {
  const raw = String(hit.text ?? "");
  const text = raw.trim();
  const at = identifierAt(raw, hit.column);
  const ident = at || (!/[.*+?^${}()|[\]\\]/.test(pattern) ? pattern : null);
  if (!ident) {
    return /^(?:export\s+)?(?:async\s+)?(?:def|function|func|fn|class|const|let|var|val|interface|struct|type|enum)\b/.test(
      text,
    );
  }
  const name = escapeRegExp(ident);
  if (
    new RegExp(
      `(?:^|\\s)(?:async\\s+)?(?:def|function|func|fn|fun|class|interface|struct|trait|type|enum|const|let|var|val)\\s+${name}\\b`,
    ).test(text)
  ) {
    return true;
  }
  if (new RegExp(`(?:^|[^\\w$])${name}\\s*=(?!=)`).test(text)) return true;
  if (new RegExp(`(?:^|[^\\w$])${name}\\s*:(?!:)`).test(text)) return true;
  return false;
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
  const preferred = hits
    .filter((hit) => isPreferredHit(hit, pattern))
    .sort((a, b) => a.line - b.line);
  const rest = hits
    .filter((hit) => !isPreferredHit(hit, pattern))
    .sort((a, b) => a.line - b.line);
  return [...preferred, ...rest];
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
  }
  groups.sort((a, b) => {
    const tier = a.tier - b.tier;
    if (tier) return tier;
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
