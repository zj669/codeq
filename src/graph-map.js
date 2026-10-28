import {
  CALLEE_CAP,
  CALLER_CAP,
  ENTRY_CAP,
  GIANT_HEAD_LINES,
  GIANT_SPAN_LINES,
  MEMBER_CAP,
} from "./limits.js";
import { callerTier } from "./path-class.js";

const FILE_SECTION = /^\*\*`([^`]+)`\*\*(?:\s+—\s+(.*))?$/;
const BLAST_LINE = /^- `([^`]+)`\s+\(([^()]+?):(\d+)\)\s+—\s+(.*)$/;
const SUMMARY_LINE = /^Found (\d+) symbols? across (\d+) files?\.$/;
const POINTER_HEADER = "**Not shown above";
const POINTER_LINE = /^- ([^\s:]+):\s+(.+)$/;
const FENCE = /^```/;
const NUMBERED = /^(\d+)\t/;

// Edge kinds CodeGraph puts in a file-section header when a symbol got there by
// relationship rather than definition. The suffix answers "why is this name
// here", which never changes which file to open next, so layer 0 drops it.
const RELATION_KINDS = new Set([
  "calls",
  "called",
  "references",
  "extends",
  "implements",
  "overrides",
  "instantiates",
  "returns",
  "type_of",
  "decorates",
  "imports",
  "exports",
  "import",
  "export",
  "contains",
]);

export const DEFINITION_KINDS = new Set([
  "function",
  "method",
  "class",
  "struct",
  "interface",
  "trait",
  "protocol",
  "enum",
  "type_alias",
  "constant",
  "variable",
  "component",
]);

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "by",
  "call",
  "called",
  "calls",
  "can",
  "do",
  "does",
  "flow",
  "for",
  "from",
  "get",
  "how",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "path",
  "the",
  "this",
  "to",
  "use",
  "used",
  "uses",
  "what",
  "when",
  "where",
  "which",
  "why",
  "with",
  "work",
  "works",
]);

export function kindRank(kind) {
  if (kind === "function" || kind === "method") return 0;
  if (kind === "class") return 1;
  return 2;
}

export function inPathScope(filePath, constraint) {
  if (!constraint) return true;
  const path = String(filePath || "").replace(/\\/g, "/");
  const scope = String(constraint).replace(/\\/g, "/").replace(/\/$/, "");
  if (!scope || scope === ".") return true;
  return path === scope || path.startsWith(`${scope}/`);
}

// Question scaffolding is stripped so "how does render_widget work" resolves
// render_widget, but the words themselves are also real symbol names across
// languages — Python `class Path`, TS `class Into`, JS `function flow`, Go
// `const Work`. queryIdentifierParts returns both tiers: primary drives the
// explore-skip gate; secondary names still resolve so a bare "Path" or "who
// calls Path" pins the symbol instead of answering with nothing.
export function queryIdentifierParts(query) {
  const tokens = String(query || "").match(/[A-Za-z_][A-Za-z0-9_$]*/g) || [];
  const seen = new Set();
  const primary = [];
  const secondary = [];
  for (const token of tokens) {
    if (token.length < 3) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    (STOP_WORDS.has(key) ? secondary : primary).push(token);
  }
  return { primary, secondary };
}

export function queryIdentifiers(query) {
  return queryIdentifierParts(query).primary;
}

function parseSymbols(suffix) {
  if (!suffix) return { symbols: [], total: 0 };
  const head = suffix.split(" · ")[0];
  const more = head.match(/,\s*\+(\d+)\s+more\s*$/);
  const extra = more ? Number(more[1]) : 0;
  const listed = (more ? head.slice(0, more.index) : head)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const symbols = [];
  const byName = new Map();
  for (const entry of listed) {
    const match = entry.match(/^(.+?)\(([^()]+)\)$/);
    const name = match ? match[1].trim() : entry;
    const kind = match ? match[2].trim() : null;
    if (kind && name === kind) continue;
    const seen = byName.get(name);
    if (seen) {
      // The engine can list one name twice, once per edge kind. Keep the
      // definition kind: it is the one that says what the symbol is.
      if (seen.kind && RELATION_KINDS.has(seen.kind) && kind && !RELATION_KINDS.has(kind)) {
        seen.kind = kind;
      }
      continue;
    }
    const symbol = { name, kind };
    byName.set(name, symbol);
    symbols.push(symbol);
  }
  return { symbols, total: listed.length + extra };
}

export function symbolLabel(symbol) {
  if (!symbol.kind || RELATION_KINDS.has(symbol.kind)) return symbol.name;
  return `${symbol.name}(${symbol.kind})`;
}

export function parseExploreDump(text) {
  const lines = String(text || "").split("\n");
  const dump = {
    symbolCount: null,
    fileCount: null,
    blast: [],
    files: [],
    pointers: [],
    verbatimNote: null,
  };
  let section = null;
  let inPointers = false;
  let fence = null;

  for (const line of lines) {
    if (fence !== null) {
      if (FENCE.test(line)) {
        fence = null;
        continue;
      }
      section?.source.push(line);
      const numbered = line.match(NUMBERED);
      if (numbered && section) {
        const number = Number(numbered[1]);
        if (section.renderedLines === null) section.renderedLines = [number, number];
        else section.renderedLines[1] = number;
      }
      continue;
    }

    if (line.startsWith("> The code below")) {
      dump.verbatimNote = line;
      continue;
    }

    const summary = line.match(SUMMARY_LINE);
    if (summary) {
      dump.symbolCount = Number(summary[1]);
      dump.fileCount = Number(summary[2]);
      continue;
    }

    const file = line.match(FILE_SECTION);
    if (file) {
      const { symbols, total } = parseSymbols(file[2]);
      section = {
        path: file[1],
        header: line,
        symbols,
        symbolCount: total,
        renderedLines: null,
        language: "",
        source: [],
      };
      dump.files.push(section);
      inPointers = false;
      continue;
    }

    if (line.startsWith(POINTER_HEADER)) {
      inPointers = true;
      section = null;
      continue;
    }

    if (FENCE.test(line) && section) {
      section.language = line.slice(3).trim();
      fence = section;
      continue;
    }

    if (inPointers) {
      const pointer = line.match(POINTER_LINE);
      if (pointer) dump.pointers.push({ path: pointer[1], symbols: pointer[2] });
      continue;
    }

    const blast = line.match(BLAST_LINE);
    if (blast && dump.files.length === 0) {
      dump.blast.push({
        name: blast[1],
        path: blast[2],
        line: Number(blast[3]),
        detail: blast[4].replace(/`/g, ""),
      });
    }
  }

  return dump;
}

const PATH_IN_TEXT = /(?:[\w.@+-]+\/)+[\w.@+-]+\.\w+/g;

// The engine seeds its search by splitting format_chat_details into format, chat
// and details, so its render order puts whatever matched a short token first.
// Layer 0 ranks by the identifier that was actually asked for: its definition
// site, then the files the blast radius ties to it, then everything else.
export function rankFiles(dump, hits, identifiers) {
  const wanted = new Set(identifiers.map((name) => name.toLowerCase()));
  const rendered = new Map(dump.files.map((file) => [file.path, file]));
  const files = [];
  const taken = new Set();
  const add = (file) => {
    if (!file || taken.has(file.path)) return;
    taken.add(file.path);
    files.push(file);
  };

  for (const hit of hits) {
    if (!hit.path) continue;
    // The engine can name a definition site it never rendered a section for.
    // It is still the first file to open.
    add(
      rendered.get(hit.path) || {
        path: hit.path,
        header: null,
        symbols: [{ name: hit.symbol, kind: null }],
        symbolCount: 1,
        renderedLines: null,
        language: "",
        source: [],
      },
    );
  }
  for (const file of dump.files) {
    if (file.symbols.some((symbol) => wanted.has(symbol.name.toLowerCase()))) add(file);
  }
  if (files.length === 0) return { files: dump.files, folded: [] };

  const linked = new Set();
  for (const entry of dump.blast) {
    if (!wanted.has(entry.name.toLowerCase())) continue;
    for (const path of entry.detail.match(PATH_IN_TEXT) || []) linked.add(path);
  }
  for (const file of dump.files) {
    if (linked.has(file.path)) add(file);
  }
  return { files, folded: dump.files.filter((file) => !taken.has(file.path)) };
}

export function exactHits(dump, identifiers, cap = ENTRY_CAP) {
  const wanted = new Map(identifiers.map((name) => [name.toLowerCase(), name]));
  const hits = [];
  const seen = new Set();
  const add = (name, path, line) => {
    const key = name.toLowerCase();
    if (!wanted.has(key) || seen.has(key)) return;
    seen.add(key);
    hits.push({ symbol: name, path, line });
  };
  for (const entry of dump.blast) add(entry.name, entry.path, entry.line);
  for (const file of dump.files) {
    for (const symbol of file.symbols) add(symbol.name, file.path, null);
  }
  return hits.slice(0, cap);
}

export function applyOrder(items, order, keyOf) {
  if (!Array.isArray(order) || order.length === 0) return items;
  const remaining = [...items];
  const out = [];
  for (const key of order) {
    const index = remaining.findIndex((item) => keyOf(item) === key);
    if (index < 0) continue;
    out.push(remaining.splice(index, 1)[0]);
  }
  out.push(...remaining);
  return out;
}

function entryKey(entry) {
  return `${entry.symbol}\0${entry.path}\0${entry.startLine}`;
}

function matchSpan(symbols, hit) {
  const key = String(hit.symbol || "").toLowerCase();
  const matches = (symbols || []).filter(
    (span) => span?.name && span.name.toLowerCase() === key,
  );
  if (matches.length === 0) return null;
  if (hit.path && hit.line) {
    const exact = matches.find(
      (span) => span.path === hit.path && span.startLine === hit.line,
    );
    if (exact) return exact;
    const containing = matches
      .filter(
        (span) =>
          span.path === hit.path &&
          span.startLine <= hit.line &&
          (span.endLine || span.startLine) >= hit.line,
      )
      .sort(
        (a, b) =>
          (a.endLine || a.startLine) -
          a.startLine -
          ((b.endLine || b.startLine) - b.startLine),
      );
    if (containing[0]) return containing[0];
  }
  if (hit.path) {
    const byPath = matches.find((span) => span.path === hit.path);
    if (byPath) return byPath;
  }
  return matches[0];
}

function toEntry(span, hit = null) {
  const symbol = span?.name || hit?.symbol;
  const path = span?.path || hit?.path;
  const startLine = span?.startLine || hit?.line;
  return {
    symbol,
    path,
    startLine,
    endLine: span?.endLine || span?.startLine || hit?.line,
    kind: span?.kind || null,
    pinned: true,
    callees: span?.callees || [],
    callers: span?.callers || [],
    members: span?.members || [],
  };
}

// Extra same-name definitions compete for ENTRY_CAP slots, so they sort by the
// same tier order as callers: a docs snippet or CI mention is never a better
// definition than the production source the query asked about.
function extraDefinitionRank(a, b) {
  const tier = callerTier(a.path) - callerTier(b.path);
  if (tier) return tier;
  const byKind = kindRank(a.kind) - kindRank(b.kind);
  if (byKind) return byKind;
  const byPath = String(a.path).localeCompare(String(b.path));
  if (byPath) return byPath;
  return (a.startLine || 0) - (b.startLine || 0);
}

export function resolveEntries(dump, identifiers, symbols = [], constraint = null) {
  const hits = exactHits(dump, identifiers, ENTRY_CAP);
  const entries = [];
  const seen = new Set();
  const used = new Set();
  const push = (entry, span) => {
    if (!inPathScope(entry.path, constraint)) return;
    if (!entry?.path || !entry.startLine) return;
    const key = entryKey(entry);
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
    if (span) used.add(span);
  };

  for (const hit of hits) {
    const span = matchSpan(symbols, hit);
    push(toEntry(span, hit), span);
  }

  const wanted = new Set(identifiers.map((name) => name.toLowerCase()));
  const extras = [];
  for (const span of symbols || []) {
    if (!span?.name || used.has(span)) continue;
    if (!wanted.has(span.name.toLowerCase())) continue;
    if (!DEFINITION_KINDS.has(span.kind)) continue;
    if (!inPathScope(span.path, constraint)) continue;
    extras.push(span);
  }
  extras.sort(extraDefinitionRank);
  for (const span of extras) {
    if (entries.length >= ENTRY_CAP) break;
    push(toEntry(span), span);
  }
  return entries.slice(0, ENTRY_CAP);
}

function collectLocators(entries, field) {
  const seen = new Set();
  const items = [];
  for (const entry of entries) {
    for (const item of entry[field] || []) {
      if (!item?.name || !item.path || !item.line) continue;
      const key = `${item.name}\0${item.path}\0${item.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        name: item.name,
        path: item.path,
        line: item.line,
        endLine: item.endLine,
      });
    }
  }
  return items;
}

function capLocators(items, cap) {
  return { shown: items.slice(0, cap), hidden: items.slice(cap) };
}

export function callerRank(a, b) {
  const tier = callerTier(a.path) - callerTier(b.path);
  if (tier) return tier;
  const byPath = String(a.path).localeCompare(String(b.path));
  if (byPath) return byPath;
  const byLine = (a.line || 0) - (b.line || 0);
  if (byLine) return byLine;
  return String(a.name).localeCompare(String(b.name));
}

export function spanLines(start, end) {
  const from = Number(start) || 0;
  const to = Number(end) || from;
  if (!from) return 0;
  return Math.max(1, to - from + 1);
}

export function isGiantSpan(start, end) {
  return spanLines(start, end) > GIANT_SPAN_LINES;
}

// The head of a giant definition is the part that actually identifies it: the
// declaration plus whatever precedes the first member. Everything after that is
// the body, which the member locators index instead.
export function headEnd(entry) {
  const start = entry.startLine;
  const end = entry.endLine || start;
  const members = entry.members || [];
  let limit = start + GIANT_HEAD_LINES - 1;
  const first = members
    .map((member) => member.line)
    .filter((line) => Number.isFinite(line) && line > start)
    .sort((a, b) => a - b)[0];
  if (first) limit = Math.min(limit, first - 1);
  return Math.max(start, Math.min(end, limit));
}

function memberRank(a, b) {
  const byCallers = (b.callerCount || 0) - (a.callerCount || 0);
  if (byCallers) return byCallers;
  return (a.line || 0) - (b.line || 0);
}

// Members the engine reports for a nested definition (a decorator closure
// inside a method) describe the body of another member, not an entry point into
// the class, so only top-level members are offered.
function topLevelMembers(members) {
  return (members || []).filter((member) => {
    if (!member?.name || !member.path || !member.line) return false;
    return !members.some(
      (other) =>
        other !== member &&
        other.path === member.path &&
        other.line < member.line &&
        (other.endLine || other.line) >= (member.endLine || member.line),
    );
  });
}

export function collectMembers(entries, cap = MEMBER_CAP) {
  const seen = new Set();
  const items = [];
  for (const entry of entries) {
    if (!entry.spanCapped) continue;
    for (const member of topLevelMembers(entry.members)) {
      const key = `${member.name}\0${member.path}\0${member.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(member);
    }
  }
  items.sort(memberRank);
  return capLocators(items, cap);
}

// A multi-thousand-line class must never be handed over as one "read this span"
// instruction, so the presented span is clipped to the head and the body is
// reached through member locators instead.
function capGiantEntries(entries) {
  return entries.map((entry) => {
    const end = entry.endLine || entry.startLine;
    if (!isGiantSpan(entry.startLine, end)) return entry;
    const capped = { ...entry, spanCapped: true, definitionEndLine: end };
    capped.endLine = headEnd(capped);
    return capped;
  });
}

function inScope(items, constraint) {
  if (!constraint) return items;
  return items.filter((item) => inPathScope(item.path, constraint));
}

export function collectCallees(entries, cap = CALLEE_CAP, constraint = null) {
  return capLocators(
    inScope(collectLocators(entries, "callees"), constraint),
    cap,
  );
}

export function collectCallers(entries, cap = CALLER_CAP, constraint = null) {
  return capLocators(
    inScope(collectLocators(entries, "callers"), constraint).sort(callerRank),
    cap,
  );
}

export function neighborhood(result) {
  const dump = parseExploreDump(result.result);
  // Ranking wants every name-shaped token, secondary included: "who calls Path"
  // pins Path from the blast radius even though Path reads as a stop word.
  const parts = queryIdentifierParts(result.query);
  const identifiers = [...parts.primary, ...parts.secondary];
  const resolved = resolveEntries(
    dump,
    identifiers,
    result.symbols,
    result.constraint,
  );
  const entries = capGiantEntries(
    applyOrder(
      resolved,
      result.entryOrder,
      (entry) => `${entry.path}:${entry.startLine}`,
    ),
  );
  // path: narrows this call, so it has to narrow the neighbourhood too —
  // otherwise the reply tells the agent to pass path: and nothing changes.
  const collectedMembers = collectMembers(entries);
  const collectedCallees = collectCallees(
    entries,
    CALLEE_CAP,
    result.constraint,
  );
  const collectedCallers = collectCallers(
    entries,
    CALLER_CAP,
    result.constraint,
  );
  const callees = applyOrder(
    collectedCallees.shown,
    result.calleeOrder,
    (callee) => `${callee.path}:${callee.line}`,
  );
  const callers = applyOrder(
    collectedCallers.shown,
    result.callerOrder,
    (caller) => `${caller.path}:${caller.line}`,
  );
  return {
    dump,
    identifiers,
    // The miss line names the tokens the caller can grep: the primary set. A
    // lone stop-word token was clearly meant as a name ("Path"), so it is
    // worth a grep suggestion; an all-prose query ("how does this work") has
    // no grep-able name at all and gets the generic hint instead.
    identifiersShown:
      parts.primary.length > 0
        ? parts.primary
        : parts.secondary.length === 1
          ? parts.secondary
          : [],
    hits: exactHits(dump, identifiers),
    entries,
    callees,
    callers,
    members: collectedMembers.shown,
    hiddenMembers: collectedMembers.hidden,
    hiddenCallees: collectedCallees.hidden,
    hiddenCallers: collectedCallers.hidden,
    extraFiles: Math.max(0, dump.files.length - entries.length),
  };
}
