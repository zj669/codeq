import { hasGlobSyntax, literalFragment } from "./find-glob.js";
import { neighborhood, spanLines } from "./graph-map.js";
import {
  CALLEE_CAP,
  CALLER_CAP,
  CONTEXT_CAP,
  COUNT_SCAN_CAP,
  FIND_CAP,
  GREP_CAP,
  MATCH_TEXT_CHARS,
  RANK_WINDOW,
} from "./limits.js";

const GREP_READ_WINDOW = 5;
import { identifierAt, rankFindResults, rankGrepHits } from "./path-tier.js";
import {
  grepExcerptWindow,
  sidecarTailLine,
  writeSidecar,
} from "./sidecar.js";

export const MCP_INSTRUCTIONS = `codeq is local find, grep, and graph for one repository at a time. Indexes are created automatically on first use. Unused on-disk indexes are pruned later; a later search may rebuild. Never ask the user to init, never write a .codegraph directory into the project, and never merge results across repositories.

Choose the tool by what you are holding: find takes a path fragment or file name (one call where host Glob or shell ls/find would scan), grep takes a token or literal/regex, and graph takes one symbol — a name you already have, or a how-it-works / where-defined / who-calls question about it. A "who calls X" or "how does X work" question goes to graph first, not grep.

Indexing starts on tools/call, never on initialize or tools/list. Prefer roots/list when the client gives a real project folder (not $HOME or /); otherwise use process.cwd() if that is a project. If the server was spawned from $HOME, pass path or root on the call. Each call uses exactly one root.

path only narrows this call inside the selected root; it never builds or switches an index. Pass root for another repository, checkout, or worktree.

Every reply's first line names the resolved absolute root and via (root argument, path argument, or cwd-derived). Read that line. When the root is not the repository you asked about — the usual cause is omitting root while working across two repositories — retry the same call with root set to that repository instead of interpreting the result.

Query one repository at a time. A burst across several roots at once saturates the live pool: those replies carry pool busy in the first line and poolBusy in structuredContent. When you see it, wait for the current root's status to reach ready, or pass root to aim the next call at the one repository you need — do not fan out to more roots or switch to host grep.

A successful identifier grep or exact graph already located. Do not find those basenames, do not Read whole files for neighbor lines, and do not grep or graph the same identifier again. Neighbor lines = grep context:N (cap 3). Host Read only the span, and only when locator or neighbors are not enough.

When truncated is true the page is partial and the omitted hits are real work you have not seen. Re-issue the same tool once with structuredContent.truncation.retry merged into the arguments — it is the continuation, already computed. Do not re-run the query unchanged and do not re-check with host tools instead.`;

export const EMPTY_TOOL_MENU = `codeq needs find.query, grep.pattern, or graph.query — do not call with {}.
find: file name or path fragment (not a glob, not "a or b") — results are repo-relative paths for host Read.
grep: token; regex true for a regexp, false for a literal.
graph: one identifier (callers/callees/how-it-works). Then Read only those spans, not whole files; skip Read if span + neighbors suffice.
grep hits carry read:{path,offset,limit} for the host Read tool.`;

export const GREP_REGEX_REQUIRED =
  "grep needs regex: true for a regexp or false for a literal.";

export const IDENTIFIER_GREP_LOCATED =
  "located. do not find these basenames; do not Read the whole file; each hit carries read:{path,offset,limit} for the host Read tool; neighbor lines = context:N (cap 3).";

export const GRAPH_LOCATED = [
  "located. Read at most the entry span, not the whole file.",
  "do not find these files; do not grep or graph this identifier again unless this map is wrong.",
];

// A truncated page is a partial answer, not a final one — the evidence is that
// agents read the flag and move on. So every truncated reply also carries
// structuredContent.truncation.retry: arguments ready to merge into the same
// tool's arguments and re-issue once, verbatim. The text line states the rule;
// retry is the executable form of it.
export const TRUNCATED_CONTINUE =
  "truncated — continue once now: re-call the same tool with truncation.retry merged into the arguments";

// path: also scopes the entry, so it only narrows the neighbourhood at or above
// the definition's own directory; graphing an omitted name is the other lever.
// truncation.retry already holds the first one — query: for an omitted symbol,
// path: when only scoping is left — so the text line points there rather than
// leaving the agent to pick a name itself.
export const GRAPH_REFINE =
  "more exist — continue once now: re-call graph with truncation.retry merged into the arguments (an omitted name, or path: under the entry's own directory); do not re-run graph on this identifier unchanged.";

export function giantSpanNote(entry, memberState) {
  const lines = spanLines(entry.startLine, entry.definitionEndLine);
  const kind = entry.kind ? `${entry.kind} ` : "";
  const head = `${kind}body spans ${entry.startLine}-${entry.definitionEndLine} (${lines} lines)`;
  if (memberState === "shown") {
    return `${head} — too big to read; use the entry points below`;
  }
  if (memberState === "omitted") {
    return `${head} — too big to read; its entry points are in the omitted methods below`;
  }
  return `${head} — too big to read whole; the span above is its head, Read on only if that is not enough`;
}

// Which member locators live inside this entry's full definition, so a capped
// entry with no members of its own does not advertise entry points that belong
// to a different entry. The shown and omitted pools are checked separately: an
// entry whose every member was capped still has entry points, they are just in
// the "+N methods omitted" line rather than the list.
function entryMemberState(entry, members, hiddenMembers) {
  const inside = (member) =>
    member.path === entry.path &&
    member.line > entry.startLine &&
    member.line <= (entry.definitionEndLine || entry.endLine);
  if (members.some(inside)) return "shown";
  if (hiddenMembers.some(inside)) return "omitted";
  return "none";
}

export const FIND_CONFIRM =
  "paths are repo-relative to the root on the first line: join to root for host Read, or pass to grep path: as-is; do not find to confirm";

export function identifierGraphHook(name) {
  return `callers/callees: graph ${String(name).trim()} — once, only if you still need callers/callees`;
}

export function requireGrepRegex(value) {
  if (typeof value !== "boolean") {
    throw new Error(GREP_REGEX_REQUIRED);
  }
  return value;
}

// The index status travels in structuredContent.status, but a bare "0 matches"
// or "NO exact hit" body still reads as a true miss. A result served while the
// index is building (or degraded) is provisional, so say so once and mark it
// machine-readable: indexReady false is "retry later", absent/true is settled.
export const INDEX_NOT_READY_NOTE =
  "index still building — matches may be incomplete; retry this query once status is ready";

export function indexReady(result = {}) {
  return result.status !== "indexing" && result.status !== "degraded";
}

export function rootOrigin(result = {}) {
  if (result.rootSource === "root") return "root argument";
  if (result.rootSource === "path") return "path argument";
  if (result.rootSource !== "cwd") return null;
  return result.cwdSource ? `cwd:${result.cwdSource}` : "cwd";
}

function scopeNote(result) {
  const note = result.rootNote;
  if (!note) return "";
  const file = note.match(/root named a file[\s\S]*?narrowed to (\S+)/);
  if (file) {
    return `; scope ${file[1].replace(/;$/, "")} (file-as-root; use path)`;
  }
  const sub = note.match(/root named a subdirectory[\s\S]*?narrowed to (\S+)/);
  if (sub) {
    return `; scope ${sub[1].replace(/;$/, "")} (subdir-as-root; use path)`;
  }
  return `; ${note}`;
}

export function freshnessLine(result = {}) {
  const status = result.status || "unknown";
  const parts = [`[${status}]${result.mode === "fuzzy" ? "[fuzzy]" : ""}`];
  if (result.root) {
    const origin = rootOrigin(result);
    parts.push(
      `root ${result.root}${origin ? ` via ${origin}` : ""}${scopeNote(result)}`,
    );
  }
  if (status === "degraded" || status === "indexing") {
    if (result.lastSuccessfulSync) {
      parts.push(`lastSuccessfulSync ${result.lastSuccessfulSync}`);
    }
    if (result.fffWarning) parts.push(`warning ${result.fffWarning}`);
    if (result.graphWarning) parts.push(`warning ${result.graphWarning}`);
  }
  if (Array.isArray(result.stalePaths) && result.stalePaths.length > 0) {
    parts.push(
      `stale ${result.stalePaths.length} file${
        result.stalePaths.length === 1 ? "" : "s"
      } changed since graph index`,
    );
  }
  if (result.poolBusy) {
    parts.push(
      "pool busy — several roots are being indexed at once; this reply is for one root only, retry or pass root to narrow",
    );
  }
  return parts.join(" ");
}

function uniquePaths(values) {
  const seen = new Set();
  const paths = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    paths.push(value);
  }
  return paths;
}

function locatorFields(result, truncated) {
  return {
    status: result.status ?? null,
    root: result.root ?? null,
    truncated: Boolean(truncated),
    indexReady: indexReady(result),
    ...(result.poolBusy ? { poolBusy: true } : {}),
    ...(Array.isArray(result.stalePaths) && result.stalePaths.length > 0
      ? { stalePaths: result.stalePaths }
      : {}),
  };
}

function markStaleHits(hits, result) {
  if (!Array.isArray(result.stalePaths) || result.stalePaths.length === 0) {
    return;
  }
  const stale = new Set(result.stalePaths);
  for (const hit of hits) {
    if (stale.has(hit.path)) hit.stale = true;
  }
}

function clampText(text) {
  const trimmed = String(text ?? "").trimStart().trimEnd();
  if (trimmed.length <= MATCH_TEXT_CHARS) return trimmed;
  return `${trimmed.slice(0, MATCH_TEXT_CHARS)}…`;
}

function countFiles(items) {
  return new Set(items.map((item) => item.path)).size;
}

const UNESCAPED_ALTERNATION_OR_GROUP = /(?:^|[^\\])(?:\\\\)*[|()]/;

function hasUnescapedAlternationOrGroup(pattern) {
  return UNESCAPED_ALTERNATION_OR_GROUP.test(String(pattern || ""));
}

function looksLikeRegexWildcards(pattern) {
  const text = String(pattern || "");
  return /\.\*|\.\+/.test(text) || hasUnescapedAlternationOrGroup(text);
}

function isIdentifierPattern(pattern) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(pattern || "").trim());
}

function findBooleanOrHint(query) {
  const text = String(query ?? "");
  if (!/\bor\b/.test(text)) return null;
  const parts = text
    .split(/\bor\b/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) {
    return 'find is not boolean; use two find calls, not "a or b".';
  }
  return `find is not boolean; search ${parts
    .map((part) => `"${part}"`)
    .join(" and ")} as two find calls.`;
}

function orderGrepHits(hits, pattern, preserveOrder) {
  if (preserveOrder) return hits;
  return rankGrepHits(hits, pattern);
}

function fuzzyNames(hits, pattern) {
  const names = [];
  const seen = new Set();
  for (const hit of hits) {
    const name = identifierAt(hit.text, hit.column);
    if (!name || name === pattern || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length === 3) break;
  }
  return names;
}

function orderFindResults(results, preserveOrder) {
  if (preserveOrder) return results || [];
  return rankFindResults(results);
}

function shortFindFragment(query) {
  const text = String(query ?? "").trim();
  return text.length > 0 && !/[\s./]/.test(text);
}

function queryLooksLikeFilename(query) {
  const text = String(query ?? "").trim();
  return /\.[A-Za-z0-9]{1,10}(?:$|[^A-Za-z0-9])/.test(text);
}

function findBasename(path) {
  const text = String(path || "").replace(/\\/g, "/");
  const parts = text.split("/");
  return parts[parts.length - 1] || "";
}

function findConfirmation(query, results) {
  if (!results.length) return false;
  const text = String(query ?? "").trim();
  if (queryLooksLikeFilename(text)) return true;
  return results.some((item) => findBasename(item.path) === text);
}

function pageCapped(result, truncated) {
  const requested = result.requestedLimit;
  const pageCap = result.pageCap ?? RANK_WINDOW;
  return Boolean(truncated && requested != null && requested > pageCap);
}

// Every truncated reply carries the same machine-readable signal: how many
// matched, how many are on this page, and the concrete call that continues.
// Without it an agent cannot tell "16 of 20" from "16 of 2000" and falls back
// to re-searching with host tools. retry is that call as ready-to-spread
// arguments for the same tool; next is its one-line description.
function truncationInfo(result, { shown, matched, next, retry }) {
  const total = Number.isSafeInteger(matched) ? matched : null;
  return {
    shown,
    ...(total !== null ? { total } : {}),
    ...(total !== null ? { remaining: Math.max(0, total - shown) } : {}),
    next,
    ...(retry ? { retry } : {}),
  };
}

// The directory a locator lives in, expressed as the path: argument that
// narrows a follow-up call. Only emitted when it is a real subdirectory — a
// top-level file narrows to itself, which filters the file rather than the
// neighbourhood.
function locatorDir(path) {
  const text = String(path || "").replace(/\\/g, "/");
  const slash = text.lastIndexOf("/");
  if (slash <= 0) return null;
  return text.slice(0, slash);
}

// Arguments that continue a truncated find, ready to merge into the next call.
// While the shown page is below the cap the lever is a larger page; at the cap
// the lever is a narrower scope — a directory that already holds hits — and
// only when one is known, otherwise there is no executable retry and the text
// line carries the only advice.
function findRetry(results, { shown, pageCap }) {
  if (shown < pageCap) return { limit: pageCap };
  const dir = results.map((item) => locatorDir(item.path)).find(Boolean);
  return dir ? { path: dir } : null;
}

// Arguments that re-scope a grep, ready to merge into the next call. Prefers a
// directory that already holds hits; the glob is a fallback when hits are
// flat. Returns null when nothing narrower is known — the caller then leaves
// retry off and the text line carries the only advice.
function grepScopeRetry(hits = []) {
  const dir = hits.map((item) => locatorDir(item.path)).find(Boolean);
  if (dir) return { path: dir };
  const exts = [
    ...new Set(
      hits
        .map((item) => String(item.path || "").match(/\.[A-Za-z0-9]{1,10}$/)?.[0])
        .filter(Boolean),
    ),
  ];
  if (exts.length === 1) return { glob: `**/*${exts[0]}` };
  return null;
}

// Arguments that continue a truncated graph, ready to merge into the next
// call. The omitted members/callees/callers are themselves identifiers the
// agent wanted, so graphing the first omitted name is the direct continuation.
// Only when every omitted item lacks a name does the retry fall back to
// narrowing path: to the entry's own directory.
function graphRetry({ hiddenMembers, hiddenCallees, hiddenCallers, entries, query }) {
  const omitted = [...hiddenMembers, ...hiddenCallees, ...hiddenCallers];
  const name = omitted.map((item) => item?.name).find(Boolean);
  if (name && name !== query) return { query: name };
  const dir = entries.map((entry) => locatorDir(entry.path)).find(Boolean);
  return dir ? { path: dir } : null;
}

function formatFind(result) {
  const results = orderFindResults(result.results, result.preserveOrder);
  const query = result.query ?? "";
  const shown = results.length;
  const matched = result.total ?? shown;
  const truncated = shown < matched;
  const capped = pageCapped(result, truncated);
  const pageCap = result.pageCap ?? RANK_WINDOW;
  const lines = [];

  lines.push(
    truncated
      ? `find ${query} — ${shown}/${matched} matches`
      : `find ${query} — ${shown} match${shown === 1 ? "" : "es"}`,
  );
  if (shown > 0) {
    lines.push("");
    for (const item of results) lines.push(item.path);
  }
  if (truncated) {
    lines.push(
      "",
      capped ? `capped at ${pageCap}; ${TRUNCATED_CONTINUE}` : TRUNCATED_CONTINUE,
    );
    if (shortFindFragment(query)) {
      lines.push(
        "find is a path fragment, not a glob; a short token matches widely — use a filename with extension, a directory, or host Glob",
      );
    }
  }
  if (result.globFallback) {
    lines.push(
      "",
      `query looked like a glob; searched "${result.globFallback.to}"`,
    );
  } else if (hasGlobSyntax(query) && shown === 0) {
    lines.push(
      "",
      `find uses path fragments, not globs; try "${literalFragment(query) || "the name"}".`,
    );
  }
  if (shown === 0) {
    const orHint = findBooleanOrHint(query);
    if (orHint) lines.push("", orHint);
  }
  if (findConfirmation(query, results)) {
    lines.push("", FIND_CONFIRM);
  }

  return {
    lines,
    truncated,
    sidecarExcerpts: [],
    structured: {
      paths: uniquePaths(results.map((item) => item.path)),
      ...(result.globFallback ? { globFallback: result.globFallback } : {}),
      ...(truncated
        ? {
            truncation: truncationInfo(result, {
              shown,
              matched,
              next:
                shown < pageCap
                  ? `raise limit toward ${pageCap}, or narrow with path`
                  : "narrow with path (limit is at the page cap)",
              retry: findRetry(results, { shown, pageCap }),
            }),
          }
        : {}),
    },
  };
}

function appendHitBlock(lines, hit, context) {
  const staleMark = hit.stale ? " (file changed after index; line may drift)" : "";
  if (context > 0) {
    const before = hit.contextBefore || [];
    const startLine = hit.line - before.length;
    for (let index = 0; index < before.length; index += 1) {
      lines.push(`${hit.path}:${startLine + index} ${clampText(before[index])}`);
    }
    lines.push(`${hit.path}:${hit.line} ${clampText(hit.text)}${staleMark}`);
    const after = hit.contextAfter || [];
    for (let index = 0; index < after.length; index += 1) {
      lines.push(`${hit.path}:${hit.line + 1 + index} ${clampText(after[index])}`);
    }
    return;
  }
  lines.push(`${hit.path}:${hit.line} ${clampText(hit.text)}${staleMark}`);
}

function appendHits(lines, hits, context = 0) {
  for (let index = 0; index < hits.length; index += 1) {
    if (index > 0 && context > 0) lines.push("");
    appendHitBlock(lines, hits[index], context);
  }
}

function formatGrepCount(result) {
  const pattern = result.pattern ?? "";
  const matchCount = result.matchCount ?? 0;
  const fileCount = result.fileCount ?? 0;
  const truncated = Boolean(result.countTruncated);
  const fileWord = fileCount === 1 ? "file" : "files";
  const matchWord = matchCount === 1 ? "match" : "matches";
  const lines = truncated
    ? [
        `grep ${pattern} — ≥${COUNT_SCAN_CAP} matches in ${fileCount} ${fileWord}, more remain`,
        "count stopped early; narrow with path/glob for an exact count",
      ]
    : [`grep ${pattern} — ${matchCount} ${matchWord} in ${fileCount} ${fileWord}`];
  return {
    lines,
    truncated,
    sidecarExcerpts: [],
    structured: {
      hits: [],
      matchCount,
      fileCount,
      ...(truncated
        ? {
            truncation: truncationInfo(result, {
              shown: matchCount,
              matched: null,
              next: "narrow with path/glob for an exact count",
              retry: grepScopeRetry(),
            }),
          }
        : {}),
    },
  };
}

function formatGrep(result) {
  if (result.count) return formatGrepCount(result);

  const hits = result.results || [];
  markStaleHits(hits, result);
  const pattern = result.pattern ?? "";
  const mode = result.mode ?? "plain";
  const fuzzy = mode === "fuzzy";
  const nextCursor = result.nextCursor || null;
  const truncated = Boolean(nextCursor);
  const preserveOrder = Boolean(result.preserveOrder);
  const display = orderGrepHits(hits, pattern, preserveOrder);
  const staleShown = display.filter((hit) => hit.stale).length;
  const context = Number.isSafeInteger(result.context) ? result.context : 0;
  const lines = [];

  if (fuzzy) {
    lines.push(
      `grep ${pattern} — 0 exact matches; ${hits.length} fuzzy match${
        hits.length === 1 ? "" : "es"
      }, DIFFERENT identifiers`,
    );
  } else if (hits.length === 0) {
    lines.push(`grep ${pattern} — 0 matches`);
  } else if (truncated) {
    // result.total is the ranked pool fetched so far — a lower bound while the
    // engine still has hits, the exact total once it does not.
    const matched =
      result.rankedExhausted && Number.isSafeInteger(result.total)
        ? result.total
        : null;
    lines.push(
      matched !== null
        ? `grep ${pattern} — ${hits.length}/${matched} shown, more remain`
        : `grep ${pattern} — ${hits.length}/? shown, more remain`,
    );
  } else {
    lines.push(
      `grep ${pattern} — ${hits.length} match${hits.length === 1 ? "" : "es"} in ${countFiles(
        hits,
      )} file${countFiles(hits) === 1 ? "" : "s"}`,
    );
  }

  if (result.contextCapped) {
    lines.push(`context capped at ${CONTEXT_CAP}`);
  }

  if (display.length > 0) {
    lines.push("");
    appendHits(lines, display, context);
  }

  if (fuzzy) {
    const names = fuzzyNames(hits, pattern);
    lines.push(
      "",
      names.length > 0
        ? `matched name: ${names.join(", ")} (not ${pattern}). confirm the spelling before concluding.`
        : `these are approximate matches, not ${pattern}. confirm the spelling before concluding.`,
    );
  } else if (hits.length === 0) {
    lines.push("");
    if (result.fuzzyRequested) {
      lines.push("check root above");
    } else {
      lines.push(
        "check root above; fuzzy:true only for approximate/different identifiers",
      );
    }
    if (looksLikeRegexWildcards(pattern) && !result.regex) {
      lines.push(
        "regex:true if this was a regular expression; this grep was literal",
      );
    }
  } else if (truncated) {
    lines.push("", TRUNCATED_CONTINUE);
  }

  if (staleShown > 0) {
    lines.push(
      "",
      `${staleShown} hit${staleShown === 1 ? "" : "s"} in file${
        staleShown === 1 ? "" : "s"
      } changed after the index — line numbers there may have drifted; Read the file to confirm before citing`,
    );
  }

  if (
    hits.length > 0 &&
    !fuzzy &&
    mode !== "regex" &&
    !result.regex &&
    isIdentifierPattern(pattern)
  ) {
    lines.push(IDENTIFIER_GREP_LOCATED);
    lines.push(identifierGraphHook(pattern));
  }

  const sidecarExcerpts =
    hits.length > 0 && !result.count
      ? display.map((hit) => grepExcerptWindow(hit)).filter(Boolean)
      : [];

  return {
    lines,
    truncated,
    sidecarExcerpts,
    structured: {
      hits: display.map((hit) => {
        const item = {
          path: hit.path,
          line: hit.line,
          column: hit.column,
          text: clampText(hit.text),
          read: {
            path: hit.path,
            offset: Math.max(1, hit.line - GREP_READ_WINDOW),
            limit: GREP_READ_WINDOW * 2 + 1,
          },
        };
        if (hit.stale) item.stale = true;
        if (context > 0) {
          item.before = (hit.contextBefore || []).map(clampText);
          item.after = (hit.contextAfter || []).map(clampText);
        }
        return item;
      }),
      ...(nextCursor ? { nextCursor } : {}),
      ...(truncated
        ? {
            truncation: truncationInfo(result, {
              shown: hits.length,
              matched:
                result.rankedExhausted && Number.isSafeInteger(result.total)
                  ? result.total
                  : null,
              next: "pass nextCursor as cursor",
              retry: nextCursor ? { cursor: nextCursor } : grepScopeRetry(hits),
            }),
          }
        : {}),
    },
  };
}

function spanRange(start, end) {
  return end && end !== start ? `${start}-${end}` : `${start}`;
}

function formatLocator(path, start, end, name) {
  return `${path}:${spanRange(start, end)} ${name}`;
}

function uniqueSymbols(entries) {
  const names = [];
  const seen = new Set();
  for (const entry of entries) {
    const key = String(entry.symbol).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(entry.symbol);
  }
  return names;
}

function appendLocators(lines, items, nameOf) {
  for (const item of items) {
    const stale = item.stale ? " (file changed after index; line may drift)" : "";
    lines.push(
      `${formatLocator(
        item.path,
        item.line ?? item.startLine,
        item.endLine || item.line || item.startLine,
        nameOf(item),
      )}${stale}`,
    );
  }
}

function markStaleLocators(items, result) {
  if (!Array.isArray(result.stalePaths) || result.stalePaths.length === 0) {
    return;
  }
  const stale = new Set(result.stalePaths);
  for (const item of items) {
    if (stale.has(item.path)) item.stale = true;
  }
}

function formatGraph(result) {
  const map = neighborhood(result);
  const {
    identifiersShown,
    entries,
    callees,
    callers,
    members,
    hiddenMembers,
    hiddenCallees,
    hiddenCallers,
  } = map;
  for (const items of [entries, callees, callers, members]) {
    markStaleLocators(items, result);
  }
  const query = result.query ?? "";
  const truncated =
    hiddenCallees.length > 0 ||
    hiddenCallers.length > 0 ||
    hiddenMembers.length > 0;
  const lines = [];

  if (entries.length > 0) {
    const exactNames = uniqueSymbols(entries);
    lines.push(`graph "${query}" — exact ${exactNames.join(", ")}`);
    const unmatched = identifiersShown.filter(
      (name) =>
        !exactNames.some(
          (symbol) => symbol.toLowerCase() === name.toLowerCase(),
        ),
    );
    // A lone leftover is usually a question word ("who calls X"). Several
    // unmatched names with a neighborhood-free entry mean the pin may be
    // incidental to the query — say so instead of presenting it as the answer.
    const barePin =
      entries.length === 1 &&
      callees.length === 0 &&
      callers.length === 0 &&
      members.length === 0;
    if (unmatched.length >= 2 && barePin) {
      lines.push(
        `no symbol named ${unmatched.join(", ")} — the match above is for ${exactNames.join(", ")} alone; check it is the name you meant`,
      );
    }
    lines.push("");
    appendLocators(lines, entries, (entry) => entry.symbol);
    for (const entry of entries) {
      if (!entry.spanCapped) continue;
      lines.push(
        giantSpanNote(
          entry,
          entryMemberState(entry, members, hiddenMembers),
        ),
      );
    }
    if (members.length > 0) {
      lines.push("", "entry points");
      appendLocators(lines, members, (member) => member.name);
      if (hiddenMembers.length > 0) {
        lines.push(`+${hiddenMembers.length} methods omitted`);
      }
    }
    if (callees.length > 0) {
      lines.push("", "callees");
      appendLocators(lines, callees, (callee) => callee.name);
      if (hiddenCallees.length > 0) {
        lines.push(`+${hiddenCallees.length} callees omitted`);
      }
    }
    if (callers.length > 0) {
      lines.push("", "callers");
      appendLocators(lines, callers, (caller) => caller.name);
      if (hiddenCallers.length > 0) {
        lines.push(`+${hiddenCallers.length} callers omitted`);
      }
    }
    const staleLocators = [...entries, ...members, ...callees, ...callers].filter(
      (item) => item.stale,
    ).length;
    if (staleLocators > 0) {
      lines.push(
        "",
        `${staleLocators} locator${staleLocators === 1 ? "" : "s"} in file${
          staleLocators === 1 ? "" : "s"
        } changed after the index — lines may have drifted; Read the file to confirm`,
      );
    }
    lines.push("", ...GRAPH_LOCATED);
    if (truncated) lines.push(GRAPH_REFINE);
  } else if (identifiersShown.length > 0) {
    lines.push(
      `graph "${query}" — NO exact hit on ${identifiersShown.join(", ")}`,
    );
    lines.push(
      identifiersShown.length === 1
        ? `next: grep ${identifiersShown[0]}; narrow path if needed`
        : `next: grep one of these names (e.g. ${identifiersShown[0]}); narrow path if needed`,
    );
  } else {
    lines.push(`graph "${query}" — NO exact hit`);
    lines.push(`next: query an identifier or "how does X work"`);
  }

  const sidecarExcerpts =
    entries.length > 0
      ? entries.map((entry) => ({
          path: entry.path,
          start: entry.startLine,
          end: entry.endLine || entry.startLine,
        }))
      : [];

  return {
    lines,
    truncated,
    sidecarExcerpts,
    structured: {
      entries: entries.map((entry) => ({
        symbol: entry.symbol,
        path: entry.path,
        startLine: entry.startLine,
        endLine: entry.endLine || entry.startLine,
        ...(entry.stale ? { stale: true } : {}),
        ...(entry.kind ? { kind: entry.kind } : {}),
        ...(entry.spanCapped
          ? {
              spanCapped: true,
              definitionEndLine: entry.definitionEndLine,
              definitionLines: spanLines(
                entry.startLine,
                entry.definitionEndLine,
              ),
            }
          : {}),
      })),
      members: members.map((member) => ({
        name: member.name,
        path: member.path,
        line: member.line,
        ...(member.stale ? { stale: true } : {}),
        ...(member.endLine ? { endLine: member.endLine } : {}),
      })),
      callees: callees.map((callee) => ({
        name: callee.name,
        path: callee.path,
        line: callee.line,
        ...(callee.stale ? { stale: true } : {}),
        ...(callee.endLine ? { endLine: callee.endLine } : {}),
      })),
      callers: callers.map((caller) => ({
        name: caller.name,
        path: caller.path,
        line: caller.line,
        ...(caller.stale ? { stale: true } : {}),
        ...(caller.endLine ? { endLine: caller.endLine } : {}),
      })),
      ...(truncated
        ? {
            truncation: {
              shown:
                members.length + callees.length + callers.length,
              remaining:
                hiddenMembers.length +
                hiddenCallees.length +
                hiddenCallers.length,
              omitted: {
                ...(hiddenMembers.length > 0
                  ? { members: hiddenMembers.length }
                  : {}),
                ...(hiddenCallees.length > 0
                  ? { callees: hiddenCallees.length }
                  : {}),
                ...(hiddenCallers.length > 0
                  ? { callers: hiddenCallers.length }
                  : {}),
              },
              next: "graph an omitted name, or add path: under the entry's own directory",
              retry: graphRetry({
                hiddenMembers,
                hiddenCallees,
                hiddenCallers,
                entries,
                query,
              }),
            },
          }
        : {}),
    },
  };
}

export function formatMcpToolResult(command, result) {
  const formatted =
    command === "find"
      ? formatFind(result)
      : command === "grep"
        ? formatGrep(result)
        : formatGraph(result);

  const sidecar = appendSidecar(command, result, formatted);
  if (sidecar) formatted.lines.push(sidecarTailLine(sidecar));
  if (!indexReady(result)) formatted.lines.push("", INDEX_NOT_READY_NOTE);

  const first = freshnessLine(result);
  return {
    firstLine: first,
    map: formatted.lines.join("\n"),
    text: `${first}\n${formatted.lines.join("\n")}`,
    structuredContent: {
      ...locatorFields(result, formatted.truncated),
      ...formatted.structured,
    },
  };
}

function appendSidecar(command, result, formatted) {
  const excerpts = formatted.sidecarExcerpts || [];
  if (excerpts.length === 0 || !result?.root) return null;
  if (command === "find") return null;
  if (command === "grep" && result.count) return null;
  try {
    return writeSidecar({
      command,
      root: result.root,
      query: result.query ?? result.pattern ?? "",
      fuzzy: result.mode === "fuzzy",
      excerpts,
    });
  } catch {
    return null;
  }
}

export { CALLEE_CAP, CALLER_CAP, FIND_CAP, GREP_CAP };
