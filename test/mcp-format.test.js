import assert from "node:assert/strict";
import test from "node:test";
import {
  formatMcpToolResult,
  freshnessLine,
  GREP_REGEX_REQUIRED,
  INDEX_NOT_READY_NOTE,
  requireGrepRegex,
  rootOrigin,
  CALLEE_CAP,
  CALLER_CAP,
  EMPTY_TOOL_MENU,
  MCP_INSTRUCTIONS,
  IDENTIFIER_GREP_LOCATED,
  identifierGraphHook,
  FIND_CONFIRM,
  GRAPH_LOCATED,
} from "../src/mcp-format.js";
import { parseExploreDump, queryIdentifiers } from "../src/graph-map.js";
import { GIANT_SPAN_LINES, MEMBER_CAP } from "../src/limits.js";

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("grep regex must be a boolean; omit is not a literal default", () => {
  assert.equal(requireGrepRegex(true), true);
  assert.equal(requireGrepRegex(false), false);
  for (const value of [undefined, null, "true", "false", 1, 0]) {
    assert.throws(() => requireGrepRegex(value), {
      message: GREP_REGEX_REQUIRED,
    });
  }
  assert.equal(GREP_REGEX_REQUIRED.includes("fuzzy"), false);
  assert.equal(GREP_REGEX_REQUIRED.includes("codeq needs"), false);
});

const stale = {
  status: "degraded",
  fffWarning: "FFF watcher is not covering this root",
  graphWarning: null,
  lastSuccessfulSync: "2026-09-21T10:00:00.000Z",
  root: "/repo",
  rootSource: "cwd",
  cwdSource: "roots/list",
};

function exploreDump(files = 2) {
  const section = (path, symbols, first) =>
    [
      `**\`${path}\`** — ${symbols}`,
      "",
      "```javascript",
      ...Array.from({ length: 20 }, (_, i) => `${first + i}\tconst line${i} = ${i};`),
      "```",
      "",
    ].join("\n");
  return [
    "**Exploration: how does createSession work**",
    "",
    `Found 43 symbols across ${files} files.`,
    "",
    "**Blast radius — what depends on these (update/verify before editing)**",
    "",
    "- `createSession` (src/session.ts:12) — 3 callers in `src/app.ts`; tests: `test/session.test.js`",
    "- `TOOLS` (src/app.ts:52) — 2 callers in `src/app.ts`; tested via callers: `test/app.test.js`",
    "",
    "**Source Code**",
    "",
    "> The code below is the **verbatim, current on-disk source** of these files. Treat each block as a Read you have already performed: do not Read a file shown here.",
    "",
    section("src/session.ts", "createSession(function), TOOLS(constant), send(calls), imports(imports), +5 more", 1),
    section("src/app.ts", "send(calls), positiveInteger(calls), jsonRpcError(calls), +24 more", 252),
    ...(files > 2
      ? [section("lib/extra.ts", "helper(function), +2 more", 1)]
      : []),
    "**Not shown above — explore these names for their source**",
    "",
    "- src/other.ts: helper:4, widget:9",
    "",
    "> Some file sections were trimmed for size. For a specific symbol you still need, run another `codegraph_explore` (or `codegraph_node`) with its exact name.",
  ].join("\n");
}

const graphResult = {
  ...stale,
  status: "ready",
  fffWarning: null,
  graphWarning: null,
  query: "how does createSession work",
  result: exploreDump(),
  symbols: [
    {
      name: "createSession",
      kind: "function",
      path: "src/session.ts",
      startLine: 12,
      endLine: 40,
      callees: [
        { name: "send", path: "src/app.ts", line: 252, endLine: 270 },
        { name: "send", path: "src/app.ts", line: 252, endLine: 270 },
        {
          name: "ready",
          path: "src/session.ts",
          line: 4,
          endLine: 4,
          text: "function ready() { return true; }",
        },
      ],
      callers: [
        { name: "boot", path: "src/main.ts", line: 8, endLine: 12 },
      ],
    },
  ],
};

test("freshness line leads every MCP reply", () => {
  const formatted = formatMcpToolResult("find", {
    ...stale,
    query: "app",
    total: 1,
    results: [{ path: "src/app.ts", size: 12 }],
  });
  assert.match(
    formatted.text,
    /^\[degraded\] root \/repo via cwd:roots\/list lastSuccessfulSync /,
  );
  assert.match(formatted.text, /warning FFF watcher/);
  const payload = formatted.structuredContent;
  assert.equal(payload.status, "degraded");
  assert.equal(payload.root, "/repo");
  assert.equal(payload.truncated, false);
  assert.equal("rootSource" in payload, false);
  assert.equal("command" in payload, false);
  assert.deepEqual(payload.paths, ["src/app.ts"]);
});

test("ready replies omit lastSuccessfulSync from the first line", () => {
  const formatted = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    lastSuccessfulSync: "2026-09-21T10:00:00.000Z",
    query: "app",
    results: [{ path: "src/app.ts" }],
  });
  assert.equal(formatted.text.split("\n")[0], "[ready] root /repo");
});

test("the text channel is a map, never the payload serialized again", () => {
  for (const command of ["find", "grep", "graph"]) {
    const formatted = formatMcpToolResult(command, {
      ...graphResult,
      query: "how does createSession work",
      pattern: "createSession",
      results: [{ path: "src/app.ts", line: 1, column: 1, text: "x" }],
    });
    assert.equal(formatted.text.includes('"status": "ready"'), false);
    assert.equal(formatted.text.includes('"rootSource"'), false);
    assert.throws(() => JSON.parse(formatted.text.split("\n").slice(1).join("\n")));
  }
});

test("every reply says which argument selected the root", () => {
  assert.equal(rootOrigin({ rootSource: "root" }), "root argument");
  assert.equal(rootOrigin({ rootSource: "path" }), "path argument");
  assert.equal(
    rootOrigin({ rootSource: "cwd", cwdSource: "spawn cwd" }),
    "cwd:spawn cwd",
  );
  assert.equal(rootOrigin({}), null);

  for (const command of ["find", "grep", "graph"]) {
    const explicit = formatMcpToolResult(command, {
      status: "ready",
      root: "/other/repo",
      rootSource: "root",
      cwdSource: "spawn cwd",
      results: [],
      result: exploreDump(),
    });
    assert.equal(
      explicit.text.split("\n")[0],
      "[ready] root /other/repo via root argument",
    );
    assert.equal(explicit.structuredContent.root, "/other/repo");
    assert.equal("rootSource" in explicit.structuredContent, false);
  }
});

test("graph is a locator map: no source, no engine self-description", () => {
  const formatted = formatMcpToolResult("graph", graphResult);
  const text = formatted.text;

  assert.equal(text.includes("```"), false);
  assert.equal(/verbatim/i.test(text), false);
  assert.equal(/already performed/i.test(text), false);
  assert.equal(text.includes("codegraph_explore"), false);
  assert.equal(text.includes("detail:\"full\""), false);

  assert.match(text, /graph "how does createSession work" — exact createSession/);
  assert.equal(text.includes("43 symbols"), false);
  assert.equal(text.includes("hit:"), false);
  assert.equal(text.includes("open these files"), false);
  assert.match(text, /^src\/session\.ts:12-40 createSession$/m);
  assert.equal(text.includes("createSession(function)"), false);
  assert.match(text, /^callees$/m);
  assert.match(text, /^src\/app\.ts:252-270 send$/m);
  assert.equal(text.split("src/app.ts:252-270 send").length - 1, 1);
  assert.match(text, /^src\/session\.ts:4 ready$/m);
  assert.equal(text.includes("function ready()"), false);
  assert.ok(text.indexOf("\ncallees\n") < text.indexOf("\ncallers\n"), text);
  assert.match(text, /^callers$/m);
  assert.match(text, /^src\/main\.ts:8-12 boot$/m);
  assert.doesNotMatch(text, /^callers:/m);
  for (const line of GRAPH_LOCATED) assert.equal(text.includes(line), true);
  assert.equal(text.includes("next: Read"), false);

  const payload = formatted.structuredContent;
  assert.equal(payload.truncated, false);
  assert.deepEqual(payload.entries[0], {
    symbol: "createSession",
    path: "src/session.ts",
    startLine: 12,
    endLine: 40,
    kind: "function",
  });
  assert.deepEqual(
    payload.callees.map((callee) => callee.name),
    ["send", "ready"],
  );
  assert.deepEqual(
    payload.callers.map((caller) => caller.name),
    ["boot"],
  );
});

test("graph anchored miss does not list a fake entry", () => {
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    query: "how does format_chat_details work",
  });
  assert.match(formatted.text, /NO exact hit on format_chat_details/);
  assert.match(
    formatted.text,
    /next: grep format_chat_details; narrow path if needed/,
  );
  assert.equal(formatted.text.includes("located."), false);
  assert.equal(formatted.text.includes("hit:"), false);
  assert.equal(formatted.text.includes("open these files"), false);
  assert.equal(formatted.text.includes("engine ranked these instead"), false);
  assert.deepEqual(formatted.structuredContent.entries, []);
  assert.deepEqual(formatted.structuredContent.callees, []);
  assert.deepEqual(formatted.structuredContent.callers, []);
  assert.equal(formatted.structuredContent.truncated, false);
});

test("graph opens the query identifier's span first", () => {
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    query: "how does format_chat_details work",
    result: [
      "Found 61 symbols across 4 files.",
      "",
      "- `format_chat_details` (src/pkg/generator.py:317) — 5 callers",
      "",
      "**`src/pkg/openai.py`** — format_prompt(function)",
      "",
      "```python",
      "1\tdef format_prompt():",
      "```",
      "",
      "**`src/pkg/generator.py`** — format_chat_details(function)",
      "",
      "```python",
      "317\tdef format_chat_details():",
      "```",
    ].join("\n"),
    symbols: [
      {
        name: "format_chat_details",
        kind: "function",
        path: "src/pkg/generator.py",
        startLine: 317,
        endLine: 340,
        callees: [
          { name: "get_scores", path: "src/pkg/bm25.py", line: 4, endLine: 9 },
        ],
      },
    ],
  });
  assert.match(formatted.text, /exact format_chat_details/);
  assert.match(formatted.text, /^src\/pkg\/generator\.py:317-340 format_chat_details$/m);
  assert.equal(formatted.text.includes("hit:"), false);
  assert.equal(formatted.structuredContent.entries[0].path, "src/pkg/generator.py");
  assert.match(formatted.text, /^src\/pkg\/bm25\.py:4-9 get_scores$/m);
});

test("graph caps the callee list and keeps multi-line bodies out", () => {
  const callees = Array.from({ length: 9 }, (_, i) => ({
    name: `step${i}`,
    path: `src/pkg/step${i}.py`,
    line: i + 1,
    endLine: i + 4,
    text: "return step",
  }));
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    symbols: [
      {
        name: "createSession",
        kind: "function",
        path: "src/session.ts",
        startLine: 12,
        endLine: 40,
        callees,
      },
    ],
  });
  assert.match(formatted.text, /^src\/pkg\/step0\.py:1-4 step0$/m);
  assert.match(formatted.text, /^src\/pkg\/step3\.py:4-7 step3$/m);
  assert.equal(formatted.text.includes("step4"), false);
  assert.equal(formatted.text.includes("step8"), false);
  assert.equal(formatted.text.includes("return step"), false);
  assert.equal(formatted.structuredContent.truncated, true);
  assert.match(formatted.text, /\+5 callees omitted/);
  assert.equal(formatted.text.includes("bounded neighborhood"), false);
});

test("graph miss without identifiers does not invent a locator", () => {
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    query: "how does this work",
  });
  assert.match(formatted.text, /NO exact hit/);
  assert.match(formatted.text, /next: query an identifier or "how does X work"/);
  assert.equal(formatted.text.includes("located."), false);
  assert.deepEqual(formatted.structuredContent.entries, []);
  assert.deepEqual(formatted.structuredContent.callees, []);
  assert.deepEqual(formatted.structuredContent.callers, []);
});

test("graph does not coach a wider map in the reply", () => {
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    query: "regression benchmark replay",
  });
  assert.equal(formatted.text.includes("this query names"), false);
  assert.equal(formatted.text.includes("wider than one symbol"), false);
});

test("grep groups hits by file, prefers definitions, and does not fold the rest", () => {
  const hits = [
    { path: "src/pkg/view.py", line: 2, column: 12, text: "    return status" },
    { path: "src/pkg/view.py", line: 4, column: 12, text: "    print(status)" },
    { path: "src/pkg/widget.py", line: 8, column: 16, text: "    color = paint(status)" },
    { path: "src/pkg/widget.py", line: 3, column: 1, text: 'STATUS = "idle"' },
    { path: "src/pkg/widget.py", line: 14, column: 5, text: "    status = color" },
    { path: "src/pkg/widget.py", line: 10, column: 20, text: "def render_widget(status, items):" },
    { path: "src/pkg/view.py", line: 6, column: 1, text: 'status = "shown"' },
  ];
  const formatted = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "status",
    mode: "plain",
    results: hits,
  });
  const text = formatted.text;
  assert.match(text, /^src\/pkg\/widget\.py:3 STATUS = "idle"$/m);
  assert.equal(text.includes("src/pkg/widget.py:3:1"), false);
  assert.equal(text.includes("\nsrc/pkg/widget.py\n"), false);
  assert.match(text, /return status/);
  assert.equal(text.includes("detail:\"full\""), false);
  assert.equal(formatted.structuredContent.hits.length, 7);
  assert.equal(formatted.structuredContent.truncated, false);
});

test("grep formatter ranks production files before README without undoing Jev", () => {
  const formatted = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "foo",
    mode: "plain",
    results: [
      { path: "README.md", line: 2, column: 1, text: "foo in docs" },
      { path: "src/pkg/foo.py", line: 8, column: 1, text: "    return foo" },
      { path: "src/pkg/foo.py", line: 1, column: 5, text: "def foo():" },
    ],
  });
  const paths = formatted.structuredContent.hits.map(
    (hit) => `${hit.path}:${hit.line}`,
  );
  assert.deepEqual(paths, [
    "src/pkg/foo.py:1",
    "src/pkg/foo.py:8",
    "README.md:2",
  ]);

  const jev = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "foo",
    mode: "plain",
    preserveOrder: true,
    results: [
      { path: "README.md", line: 2, column: 1, text: "foo in docs" },
      { path: "src/pkg/foo.py", line: 1, column: 5, text: "def foo():" },
    ],
  });
  assert.deepEqual(
    jev.structuredContent.hits.map((hit) => hit.path),
    ["README.md", "src/pkg/foo.py"],
  );
});

test("grep is exact by default and never labels itself fuzzy", () => {
  const formatted = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "createSession",
    mode: "plain",
    results: [
      {
        path: "src/app.ts",
        line: 4,
        column: 1,
        text: "  export function createSession() {}",
      },
    ],
  });
  assert.equal(formatted.text.includes("[fuzzy]"), false);
  assert.match(formatted.text, /grep createSession — 1 match in 1 file/);
  assert.deepEqual(formatted.structuredContent.hits[0], {
    path: "src/app.ts",
    line: 4,
    column: 1,
    text: "export function createSession() {}",
    read: { path: "src/app.ts", offset: 1, limit: 11 },
  });
});

test("grep zero hits check root first and hint regex for .* . + unescaped | or groups", () => {
  const formatted = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "PG_DATABASE_URL",
    mode: "plain",
    fuzzyRequested: false,
    results: [],
  });
  assert.match(formatted.text, /grep PG_DATABASE_URL — 0 matches/);
  assert.match(formatted.text, /check root above/);
  assert.match(formatted.text, /fuzzy:true only for approximate\/different identifiers/);
  assert.equal(formatted.text.includes("regex"), false);
  assert.equal(formatted.text.includes("callers/callees"), false);
  assert.deepEqual(formatted.structuredContent.hits, []);

  const regexShaped = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "createSess.*",
    mode: "plain",
    fuzzyRequested: false,
    results: [],
  });
  assert.match(
    regexShaped.text,
    /regex:true if this was a regular expression; this grep was literal/,
  );
  assert.match(regexShaped.text, /grep createSess\.\* — 0 matches/);
});

test("grep fuzzy is labelled on the first line and names what it matched", () => {
  const formatted = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "GRAPH_SUMMERY_CHARS",
    mode: "fuzzy",
    fuzzyRequested: true,
    results: [
      {
        path: "src/mcp-format.js",
        line: 1,
        column: 7,
        text: "const GRAPH_SUMMARY_CHARS = 4_000;",
      },
    ],
  });
  assert.equal(formatted.text.split("\n")[0], "[ready][fuzzy] root /repo");
  assert.match(formatted.text, /matched name: GRAPH_SUMMARY_CHARS/);
});

test("grep reports a real nextCursor instead of a fake total", () => {
  const formatted = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "reply_success",
    mode: "plain",
    nextCursor: "abc",
    results: Array.from({ length: 16 }, (_, i) => ({
      path: `src/file${i}.ts`,
      line: i + 1,
      column: 1,
      text: "reply_success()",
    })),
  });
  assert.match(formatted.text, /grep reply_success — 16\/\? shown, more remain/);
  assert.match(formatted.text, /truncated — continue once now/);
  assert.equal(formatted.text.includes("cursor=abc"), false);
  assert.equal(formatted.structuredContent.truncated, true);
  assert.equal(formatted.structuredContent.nextCursor, "abc");
  assert.deepEqual(formatted.structuredContent.truncation, {
    shown: 16,
    next: "pass nextCursor as cursor",
    retry: { cursor: "abc" },
  });
});

test("truncated replies carry a machine-readable way to continue", () => {
  // find: total known, continuation = raise the page toward the cap.
  const find = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "test",
    total: 40,
    results: Array.from({ length: 16 }, (_, i) => ({
      path: `tests/t${i}.py`,
    })),
    requestedLimit: null,
    pageCap: 48,
  });
  assert.match(find.text, /find test — 16\/40 matches/);
  assert.match(find.text, /truncated — continue once now/);
  assert.deepEqual(find.structuredContent.truncation, {
    shown: 16,
    total: 40,
    remaining: 24,
    next: "raise limit toward 48, or narrow with path",
    retry: { limit: 48 },
  });

  // find with the page cap already hit: the lever is scoping path: to a
  // directory that already holds hits.
  const findCapped = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "test",
    total: 100,
    results: Array.from({ length: 48 }, (_, i) => ({
      path: `tests/t${i}.py`,
    })),
    requestedLimit: 100,
    pageCap: 48,
  });
  assert.match(findCapped.text, /capped at 48; truncated — continue once now/);
  assert.equal(findCapped.structuredContent.truncation.next, "narrow with path (limit is at the page cap)");
  assert.deepEqual(findCapped.structuredContent.truncation.retry, {
    path: "tests",
  });

  // grep: pool exhausted under the cap — the total is exact, the retry is the
  // opaque cursor.
  const grepExact = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "status_code",
    mode: "plain",
    nextCursor: "abc",
    total: 20,
    rankedExhausted: true,
    results: Array.from({ length: 16 }, (_, i) => ({
      path: `src/f${i}.py`,
      line: i + 1,
      column: 1,
      text: "status_code",
    })),
  });
  assert.match(grepExact.text, /grep status_code — 16\/20 shown, more remain/);
  assert.deepEqual(grepExact.structuredContent.truncation, {
    shown: 16,
    total: 20,
    remaining: 4,
    next: "pass nextCursor as cursor",
    retry: { cursor: "abc" },
  });

  // graph: hidden neighborhood sections carry their counts, and the retry is
  // the first omitted name — itself a directly graphable identifier.
  const callees = Array.from({ length: 8 }, (_, i) => ({
    name: `step${i}`,
    path: `src/step${i}.py`,
    line: i + 1,
  }));
  const graph = formatMcpToolResult("graph", {
    ...graphResult,
    symbols: [
      {
        name: "createSession",
        kind: "function",
        path: "src/session.ts",
        startLine: 12,
        endLine: 40,
        callees,
      },
    ],
  });
  assert.equal(graph.structuredContent.truncated, true);
  assert.match(graph.text, /\+4 callees omitted/);
  assert.deepEqual(graph.structuredContent.truncation, {
    shown: 4,
    remaining: 4,
    omitted: { callees: 4 },
    next: "graph an omitted name, or add path: under the entry's own directory",
    retry: { query: "step4" },
  });
});

test("truncated replies without a computable retry do not promise one", () => {
  // find: at the page cap with every hit at the top level — no subdirectory
  // exists to narrow into, so retry is absent and the text must not send the
  // agent after it.
  const findFlat = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "t",
    total: 100,
    results: Array.from({ length: 48 }, (_, i) => ({ path: `t${i}.py` })),
    requestedLimit: 100,
    pageCap: 48,
  });
  assert.equal("retry" in findFlat.structuredContent.truncation, false);
  assert.equal(findFlat.text.includes("truncation.retry"), false);
  assert.match(findFlat.text, /follow truncation\.next/);
  assert.equal(
    findFlat.structuredContent.truncation.next,
    "narrow with path (limit is at the page cap)",
  );

  // grep count: the scan stopped at the cap and returns no hits, so nothing
  // narrower is known — the count sentence already names the fallback.
  const counted = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "token",
    mode: "plain",
    count: true,
    countTruncated: true,
    matchCount: 4096,
    fileCount: 90,
    results: [],
  });
  assert.equal("retry" in counted.structuredContent.truncation, false);
  assert.equal(counted.text.includes("truncation.retry"), false);
  assert.match(counted.text, /narrow with path\/glob for an exact count/);

  // graph: a recursive entry whose callees all name the queried symbol leaves
  // no omitted name to re-query, and a top-level path leaves no directory to
  // narrow into — the line falls back instead of promising truncation.retry.
  const graphFlat = formatMcpToolResult("graph", {
    ...graphResult,
    query: "rec",
    symbols: [
      {
        name: "rec",
        kind: "function",
        path: "rec.ts",
        startLine: 1,
        endLine: 40,
        callees: Array.from({ length: 8 }, (_, i) => ({
          name: "rec",
          path: "rec.ts",
          line: i + 10,
        })),
      },
    ],
  });
  assert.equal(graphFlat.structuredContent.truncated, true);
  assert.equal("retry" in graphFlat.structuredContent.truncation, false);
  assert.equal(graphFlat.text.includes("truncation.retry"), false);
  assert.match(graphFlat.text, /follow truncation\.next/);
});

test("untruncated replies carry no truncation object", () => {
  for (const formatted of [
    formatMcpToolResult("find", {
      status: "ready",
      root: "/repo",
      query: "app",
      total: 1,
      results: [{ path: "src/app.ts" }],
    }),
    formatMcpToolResult("grep", {
      status: "ready",
      root: "/repo",
      pattern: "needle",
      mode: "plain",
      results: [{ path: "src/a.ts", line: 1, column: 1, text: "needle" }],
    }),
    formatMcpToolResult("graph", graphResult),
  ]) {
    assert.equal(formatted.structuredContent.truncated, false);
    assert.equal("truncation" in formatted.structuredContent, false);
  }
});

test("a narrowed repeat query drops the truncation signal", () => {
  // The continue-signal contract: path/glob narrows the same query until the
  // page is whole — then truncated flips false and truncation is gone.
  const wide = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "status_code",
    mode: "plain",
    nextCursor: "abc",
    results: Array.from({ length: 16 }, (_, i) => ({
      path: `src/f${i}.py`,
      line: i + 1,
      column: 1,
      text: "status_code",
    })),
  });
  assert.equal(wide.structuredContent.truncated, true);
  assert.deepEqual(wide.structuredContent.truncation.retry, { cursor: "abc" });

  const narrowed = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "status_code",
    mode: "plain",
    constraint: "src/",
    nextCursor: null,
    results: [
      { path: "src/f0.py", line: 1, column: 1, text: "status_code" },
      { path: "src/f1.py", line: 2, column: 1, text: "status_code" },
    ],
  });
  assert.match(narrowed.text, /grep status_code — 2 matches in 2 files/);
  assert.equal(narrowed.structuredContent.truncated, false);
  assert.equal("truncation" in narrowed.structuredContent, false);

  const findNarrowed = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "test",
    constraint: "tests/api/",
    total: 3,
    results: [
      { path: "tests/api/a.py" },
      { path: "tests/api/b.py" },
      { path: "tests/api/c.py" },
    ],
  });
  assert.match(findNarrowed.text, /find test — 3 matches/);
  assert.equal(findNarrowed.structuredContent.truncated, false);
  assert.equal("truncation" in findNarrowed.structuredContent, false);
});

test("an unfinished index marks every reply provisional instead of a bare miss", () => {
  for (const status of ["indexing", "degraded"]) {
    const base = {
      status,
      root: "/repo",
      fffWarning: status === "degraded" ? "FFF watcher failed" : null,
      graphWarning: null,
      lastSuccessfulSync: "2026-09-21T10:00:00.000Z",
    };
    const find = formatMcpToolResult("find", {
      ...base,
      query: "app",
      total: 0,
      results: [],
    });
    assert.match(find.text, /0 matches/);
    assert.match(find.text, new RegExp(INDEX_NOT_READY_NOTE));
    assert.equal(find.structuredContent.indexReady, false);

    const grep = formatMcpToolResult("grep", {
      ...base,
      pattern: "needle",
      mode: "plain",
      results: [],
    });
    assert.match(grep.text, /0 matches/);
    assert.match(grep.text, new RegExp(INDEX_NOT_READY_NOTE));
    assert.equal(grep.structuredContent.indexReady, false);

    const graph = formatMcpToolResult("graph", {
      ...base,
      query: "createSession",
      result: "",
      symbols: [],
    });
    assert.match(graph.text, /NO exact hit/);
    assert.match(graph.text, new RegExp(INDEX_NOT_READY_NOTE));
    assert.equal(graph.structuredContent.indexReady, false);
  }
});

test("a ready index omits the provisional marker and reports indexReady", () => {
  for (const command of ["find", "grep", "graph"]) {
    const formatted = formatMcpToolResult(command, {
      status: "ready",
      root: "/repo",
      query: "app",
      pattern: "app",
      total: 0,
      results: [],
      result: "",
      symbols: [],
    });
    assert.equal(formatted.text.includes(INDEX_NOT_READY_NOTE), false);
    assert.equal(formatted.structuredContent.indexReady, true);
  }
});

test("a ready index with a real miss stays a bare miss", () => {
  const formatted = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "needle",
    mode: "plain",
    results: [],
  });
  assert.match(formatted.text, /grep needle — 0 matches/);
  assert.equal(formatted.text.includes(INDEX_NOT_READY_NOTE), false);
  assert.equal(formatted.structuredContent.indexReady, true);
});

test("find replies are paths, not file metadata", () => {
  const formatted = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "codeq",
    total: 2,
    results: [
      {
        path: "bin/codeq.js",
        size: 4_096,
        score: 88,
        matchType: "exact",
      },
      { path: "src/grep-mode.js", score: 30 },
    ],
  });
  assert.match(formatted.text, /find codeq — 2 matches/);
  assert.equal(formatted.text.includes("4096"), false);
  assert.equal(formatted.text.includes("88"), false);
  assert.deepEqual(formatted.structuredContent.paths, [
    "bin/codeq.js",
    "src/grep-mode.js",
  ]);
});

test("find pins production exact path matches first without Jev", () => {
  const formatted = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "foo.py",
    total: 3,
    results: [
      { path: "src/pkg/foo_test.py", matchType: "prefix" },
      { path: "src/pkg/other.py", matchType: "fuzzy" },
      { path: "src/pkg/foo.py", matchType: "exact" },
    ],
  });
  assert.deepEqual(formatted.structuredContent.paths, [
    "src/pkg/foo.py",
    "src/pkg/other.py",
    "src/pkg/foo_test.py",
  ]);
});

test("find formatter does not lift aux exact over production", () => {
  const kept = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "git",
    preserveOrder: true,
    total: 2,
    results: [
      { path: "src/pkg/a.py", matchType: "fuzzy" },
      { path: ".gitignore", matchType: "exact" },
    ],
  });
  assert.deepEqual(kept.structuredContent.paths, [
    "src/pkg/a.py",
    ".gitignore",
  ]);

  const defensive = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "git",
    total: 2,
    results: [
      { path: ".gitignore", matchType: "exact" },
      { path: "src/pkg/a.py", matchType: "fuzzy" },
    ],
  });
  assert.deepEqual(defensive.structuredContent.paths, [
    "src/pkg/a.py",
    ".gitignore",
  ]);
});

test("find preserveOrder keeps daemon membership and order", () => {
  const formatted = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "foo",
    preserveOrder: true,
    total: 3,
    results: [
      { path: "src/pkg/needed.py", matchType: "fuzzy" },
      { path: ".github/workflows/ci.yml", matchType: "fuzzy" },
      { path: "src/pkg/foo.py", matchType: "exact" },
    ],
  });
  assert.deepEqual(formatted.structuredContent.paths, [
    "src/pkg/needed.py",
    ".github/workflows/ci.yml",
    "src/pkg/foo.py",
  ]);
  assert.equal(/jev|noul|prod_shortlist|exact_neighborhood|tier_order|mixed_grep|skipped/i.test(formatted.text), false);
});

test("find says glob syntax is not how find works only on a miss without rewrite", () => {
  const miss = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "mr_review_service/**/*profile*",
    total: 0,
    results: [],
  });
  assert.match(miss.text, /find uses path fragments, not globs; try "profile"/);

  const hit = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "*session*",
    total: 1,
    results: [{ path: "src/session.ts" }],
  });
  assert.equal(hit.text.includes("glob"), false);
  assert.equal(hit.text.includes("path fragment"), false);
});

test("find marks a glob rewrite when the daemon searched a fragment first", () => {
  const formatted = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "**/*blueprint*",
    total: 2,
    globFallback: { from: "**/*blueprint*", to: "blueprint" },
    results: [
      { path: "src/blueprint.ts", matchType: "fuzzy" },
      { path: "docs/blueprint.md", matchType: "fuzzy" },
    ],
  });
  assert.match(formatted.text, /query looked like a glob; searched "blueprint"/);
  assert.equal(formatted.text.includes("try \"blueprint\""), false);
  assert.deepEqual(formatted.structuredContent.globFallback, {
    from: "**/*blueprint*",
    to: "blueprint",
  });
});

test("find rewrite line still appears when fragment-first returns no hits", () => {
  const formatted = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "**/*blueprint*",
    total: 0,
    globFallback: { from: "**/*blueprint*", to: "blueprint" },
    results: [],
  });
  assert.match(formatted.text, /query looked like a glob; searched "blueprint"/);
  assert.equal(formatted.text.includes("try \"blueprint\""), false);
});

test("find truncation does not mention the page cap", () => {
  const formatted = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "test",
    total: 84,
    results: Array.from({ length: 16 }, (_, i) => ({ path: `src/f${i}.ts` })),
  });
  assert.match(formatted.text, /find test — 16\/84 matches/);
  assert.match(formatted.text, /truncated — continue once now/);
  assert.equal(formatted.text.includes("capped at 16"), false);
});

test("the dump parser keys off the file-section marker, not a path regex", () => {
  const dump = parseExploreDump(exploreDump(3));
  assert.deepEqual(
    dump.files.map((file) => file.path),
    ["src/session.ts", "src/app.ts", "lib/extra.ts"],
  );
  assert.equal(dump.symbolCount, 43);
});

test("file-as-root note is a relative scope and the path action", () => {
  const formatted = formatMcpToolResult("find", {
    status: "ready",
    root: "/Users/zj669/project/leagent",
    rootSource: "root",
    rootNote:
      "root named a file, so it resolved to this repository narrowed to src/leagent/chat/policy_selector.py; pass a file as path, not root",
    query: "policy",
    results: [],
  });
  assert.equal(
    formatted.text.split("\n")[0],
    "[ready] root /Users/zj669/project/leagent via root argument; scope src/leagent/chat/policy_selector.py (file-as-root; use path)",
  );
});

test("query identifiers drop the prose around them", () => {
  assert.deepEqual(queryIdentifiers("how does formatMcpToolResult work"), [
    "formatMcpToolResult",
  ]);
  assert.equal(freshnessLine({ status: "ready" }), "[ready]");
  assert.equal(CALLEE_CAP, 4);
  assert.equal(CALLER_CAP, 4);
});

test("graph empty dump still pins exact-name definitions from the index", () => {
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    query: "how does createSession work",
    result: "",
  });
  assert.match(formatted.text, /exact createSession/);
  assert.match(formatted.text, /^src\/session\.ts:12-40 createSession$/m);
  assert.equal(formatted.structuredContent.entries[0].symbol, "createSession");
  assert.deepEqual(
    formatted.structuredContent.callers.map((caller) => caller.name),
    ["boot"],
  );
  assert.match(formatted.text, /^callers$/m);
  assert.match(formatted.text, /^src\/main\.ts:8-12 boot$/m);
  assert.equal(formatted.text.includes("fast path"), false);
  assert.equal(formatted.text.includes("skipped explore"), false);
});

test("graph dump miss still pins an exact-name definition from the index", () => {
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    query: "how does full_dispatch_request work",
    result: [
      "Found 40 symbols across 2 files.",
      "",
      "- `full` (src/pkg/short.py:1) — FTS leftover",
      "",
      "**`src/pkg/short.py`** — full(function), dispatch(calls)",
    ].join("\n"),
    symbols: [
      {
        name: "full_dispatch_request",
        kind: "function",
        path: "src/pkg/dispatch.py",
        startLine: 40,
        endLine: 88,
        callees: [{ name: "send", path: "src/pkg/send.py", line: 2, endLine: 4 }],
        callers: [{ name: "handle", path: "src/pkg/api.py", line: 10, endLine: 20 }],
      },
      {
        name: "full",
        kind: "function",
        path: "src/pkg/short.py",
        startLine: 1,
        endLine: 2,
        callees: [],
        callers: [],
      },
    ],
  });
  assert.match(formatted.text, /exact full_dispatch_request/);
  assert.match(formatted.text, /^src\/pkg\/dispatch\.py:40-88 full_dispatch_request$/m);
  assert.equal(formatted.text.includes("NO exact hit"), false);
  assert.equal(formatted.structuredContent.entries[0].symbol, "full_dispatch_request");
  assert.equal(
    formatted.structuredContent.entries.some((entry) => entry.symbol === "full"),
    false,
  );
  assert.deepEqual(
    formatted.structuredContent.callees.map((callee) => callee.name),
    ["send"],
  );
  assert.deepEqual(
    formatted.structuredContent.callers.map((caller) => caller.name),
    ["handle"],
  );
  assert.match(formatted.text, /^callers$/m);
  assert.match(formatted.text, /^src\/pkg\/api\.py:10-20 handle$/m);
  assert.match(formatted.text, /^callees$/m);
});

test("graph dump miss with no exact-name definition stays empty and points at grep", () => {
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    query: "how does missing_identifier work",
    symbols: [
      {
        name: "createSession",
        kind: "function",
        path: "src/session.ts",
        startLine: 12,
        endLine: 40,
        callees: [{ name: "send", path: "src/app.ts", line: 252, endLine: 270 }],
        callers: [{ name: "boot", path: "src/main.ts", line: 8, endLine: 12 }],
      },
    ],
  });
  assert.match(formatted.text, /NO exact hit on missing_identifier/);
  assert.match(formatted.text, /next: grep missing_identifier/);
  assert.deepEqual(formatted.structuredContent.entries, []);
  assert.deepEqual(formatted.structuredContent.callees, []);
  assert.deepEqual(formatted.structuredContent.callers, []);
});

test("graph does not promote relation-only or out-of-scope same-name nodes", () => {
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    query: "render_widget",
    constraint: "src/pkg/",
    result: "Found 0 symbols across 0 files.\n",
    symbols: [
      {
        name: "render_widget",
        kind: "calls",
        path: "src/pkg/widget.py",
        startLine: 14,
        endLine: 14,
        callees: [],
        callers: [],
      },
      {
        name: "render_widget",
        kind: "function",
        path: "src/other/widget.py",
        startLine: 2,
        endLine: 9,
        callees: [],
        callers: [],
      },
      {
        name: "render_widget",
        kind: "function",
        path: "src/pkg/widget.py",
        startLine: 14,
        endLine: 22,
        callees: [],
        callers: [],
      },
    ],
  });
  assert.deepEqual(
    formatted.structuredContent.entries.map((entry) => entry.path),
    ["src/pkg/widget.py"],
  );
});

// Extra definitions sort by the same tier order as callers (production, test,
// bench, docs, config): with the old binary test/non-test split, a docs snippet
// or CI mention counted as "production" and could win an ENTRY_CAP slot by
// path order ahead of real source.
test("graph keeps multiple same-name definitions and deprioritizes tests", () => {
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    query: "dispatch",
    result: "Found 0 symbols across 0 files.\n",
    symbols: [
      {
        name: "dispatch",
        kind: "function",
        path: "test/dispatch_test.py",
        startLine: 1,
        endLine: 4,
        callees: [],
        callers: [],
      },
      {
        name: "dispatch",
        kind: "function",
        path: "src/b.py",
        startLine: 8,
        endLine: 12,
        callees: [],
        callers: [],
      },
      {
        name: "dispatch",
        kind: "function",
        path: "src/a.py",
        startLine: 3,
        endLine: 9,
        callees: [],
        callers: [],
      },
    ],
  });
  assert.deepEqual(
    formatted.structuredContent.entries.map((entry) => entry.path),
    ["src/a.py", "src/b.py", "test/dispatch_test.py"],
  );
});

test("graph definition ranking puts docs and config below tests and benchmarks", () => {
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    query: "dispatch",
    result: "Found 0 symbols across 0 files.\n",
    symbols: [
      {
        name: "dispatch",
        kind: "function",
        path: "docs/tutorial/intro.py",
        startLine: 3,
        endLine: 9,
        callees: [],
        callers: [],
      },
      {
        name: "dispatch",
        kind: "function",
        path: ".github/workflows/ci.yml",
        startLine: 5,
        endLine: 5,
        callees: [],
        callers: [],
      },
      {
        name: "dispatch",
        kind: "function",
        path: "tests/benchmarks/utils.py",
        startLine: 11,
        endLine: 46,
        callees: [],
        callers: [],
      },
      {
        name: "dispatch",
        kind: "function",
        path: "src/b.py",
        startLine: 8,
        endLine: 12,
        callees: [],
        callers: [],
      },
      {
        name: "dispatch",
        kind: "function",
        path: "test/dispatch_test.py",
        startLine: 1,
        endLine: 4,
        callees: [],
        callers: [],
      },
      {
        name: "dispatch",
        kind: "function",
        path: "src/a.py",
        startLine: 3,
        endLine: 9,
        callees: [],
        callers: [],
      },
    ],
  });
  assert.deepEqual(
    formatted.structuredContent.entries.map((entry) => entry.path),
    ["src/a.py", "src/b.py", "test/dispatch_test.py"],
  );
});

test("graph caps callers independently of callees", () => {
  const callers = Array.from({ length: 7 }, (_, i) => ({
    name: `caller${i}`,
    path: `src/pkg/caller${i}.py`,
    line: i + 1,
    endLine: i + 2,
  }));
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    symbols: [
      {
        name: "createSession",
        kind: "function",
        path: "src/session.ts",
        startLine: 12,
        endLine: 40,
        callees: [
          { name: "send", path: "src/app.ts", line: 252, endLine: 270 },
        ],
        callers,
      },
    ],
  });
  assert.match(formatted.text, /^callers$/m);
  assert.match(formatted.text, /^src\/pkg\/caller0\.py:1-2 caller0$/m);
  assert.match(formatted.text, /^src\/pkg\/caller1\.py:2-3 caller1$/m);
  assert.match(formatted.text, /^src\/pkg\/caller2\.py:3-4 caller2$/m);
  assert.match(formatted.text, /^src\/pkg\/caller3\.py:4-5 caller3$/m);
  assert.equal(formatted.text.includes("caller4"), false);
  assert.doesNotMatch(formatted.text, /^callers:/m);
  assert.match(formatted.text, /\+3 callers omitted/);
  assert.equal(formatted.structuredContent.callers.length, 4);
  assert.equal(formatted.structuredContent.truncated, true);
  assert.ok(
    formatted.text.indexOf("\ncallees\n") < formatted.text.indexOf("\ncallers\n"),
  );
});

test("graph deprioritizes test callers without dropping them until cap", () => {
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    symbols: [
      {
        name: "createSession",
        kind: "function",
        path: "src/session.ts",
        startLine: 12,
        endLine: 40,
        callees: [],
        callers: [
          { name: "spec", path: "test/session.test.ts", line: 4, endLine: 8 },
          { name: "boot", path: "src/main.ts", line: 8, endLine: 12 },
          { name: "hook", path: "src/hooks.ts", line: 2, endLine: 3 },
        ],
      },
    ],
  });
  assert.match(formatted.text, /^callers$/m);
  assert.match(formatted.text, /^src\/hooks\.ts:2-3 hook$/m);
  assert.match(formatted.text, /^src\/main\.ts:8-12 boot$/m);
  assert.match(formatted.text, /^test\/session\.test\.ts:4-8 spec$/m);
  assert.ok(
    formatted.text.indexOf("src/hooks.ts:2-3 hook") <
      formatted.text.indexOf("src/main.ts:8-12 boot"),
  );
  assert.ok(
    formatted.text.indexOf("src/main.ts:8-12 boot") <
      formatted.text.indexOf("test/session.test.ts:4-8 spec"),
  );
  assert.deepEqual(
    formatted.structuredContent.callers.map((caller) => caller.name),
    ["hook", "boot", "spec"],
  );
});

test("graph caller cap keeps production callers before tests", () => {
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    symbols: [
      {
        name: "createSession",
        kind: "function",
        path: "src/session.ts",
        startLine: 12,
        endLine: 40,
        callees: [],
        callers: [
          { name: "specA", path: "test/a.test.ts", line: 1, endLine: 2 },
          { name: "specB", path: "test/b.test.ts", line: 1, endLine: 2 },
          { name: "specC", path: "test/c.test.ts", line: 1, endLine: 2 },
          { name: "boot", path: "src/main.ts", line: 8, endLine: 12 },
          { name: "hook", path: "src/hooks.ts", line: 2, endLine: 3 },
        ],
      },
    ],
  });
  assert.deepEqual(
    formatted.structuredContent.callers.map((caller) => caller.name),
    ["hook", "boot", "specA", "specB"],
  );
  assert.match(formatted.text, /\+1 callers omitted/);
  assert.equal(formatted.text.includes("specC"), false);
});

// A library symbol is called from hundreds of tests; alphabetical order used to
// hand every visible slot to tests/benchmarks/* helpers while the production
// caller sat in the omitted count.
test("graph caller ranking puts production first, then tests, then benchmarks, then docs, then config", () => {
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    symbols: [
      {
        name: "createSession",
        kind: "function",
        path: "src/session.ts",
        startLine: 12,
        endLine: 40,
        callees: [],
        callers: [
          { name: "benchHelper", path: "tests/benchmarks/utils.py", line: 11, endLine: 46 },
          { name: "memBench", path: "tests/memory_benchmarks/test_graph.py", line: 21, endLine: 72 },
          { name: "docSample", path: "docs/tutorial/intro.py", line: 3, endLine: 9 },
          { name: "ciMention", path: ".github/workflows/ci.yml", line: 5, endLine: 5 },
          { name: "bundleCopy", path: "dist/bundle.js", line: 900, endLine: 901 },
          { name: "testMultiplePath", path: "tests/test_annotated.py", line: 77, endLine: 100 },
          { name: "boot", path: "src/main.ts", line: 8, endLine: 12 },
        ],
      },
    ],
  });
  assert.deepEqual(
    formatted.structuredContent.callers.map((caller) => caller.name),
    ["boot", "testMultiplePath", "benchHelper", "memBench"],
  );
  // The docs and config callers are pushed out, not the production caller.
  assert.match(formatted.text, /\+3 callers omitted/);
  assert.equal(formatted.text.includes("docSample"), false);
  assert.equal(formatted.text.includes("ciMention"), false);
  assert.equal(formatted.text.includes("bundleCopy"), false);
});

// With fewer callers than the cap, the full tier order is still visible:
// production, test, bench, docs, then config/generated.
test("graph caller ranking shows config callers last when under the cap", () => {
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    symbols: [
      {
        name: "createSession",
        kind: "function",
        path: "src/session.ts",
        startLine: 12,
        endLine: 40,
        callees: [],
        callers: [
          { name: "ciMention", path: ".github/workflows/ci.yml", line: 5, endLine: 5 },
          { name: "docSample", path: "docs/tutorial/intro.py", line: 3, endLine: 9 },
          { name: "boot", path: "src/main.ts", line: 8, endLine: 12 },
          { name: "spec", path: "test/session.test.ts", line: 4, endLine: 8 },
        ],
      },
    ],
  });
  assert.deepEqual(
    formatted.structuredContent.callers.map((caller) => caller.name),
    ["boot", "spec", "docSample", "ciMention"],
  );
  assert.equal(formatted.text.includes("callers omitted"), false);
});

// The reply tells the agent to pass path: when callers are omitted, so path:
// has to actually shrink the caller list.
test("a path constraint narrows callers and the omitted count follows it", () => {
  const symbols = [
    {
      name: "createSession",
      kind: "function",
      path: "src/session.ts",
      startLine: 12,
      endLine: 40,
      callees: [],
      callers: [
        { name: "boot", path: "src/main.ts", line: 8, endLine: 12 },
        { name: "wire", path: "src/wire.ts", line: 4, endLine: 6 },
        { name: "specA", path: "test/a.test.ts", line: 1, endLine: 2 },
        { name: "specB", path: "test/b.test.ts", line: 1, endLine: 2 },
        { name: "specC", path: "test/c.test.ts", line: 1, endLine: 2 },
      ],
    },
  ];
  const wide = formatMcpToolResult("graph", { ...graphResult, symbols });
  assert.match(wide.text, /\+1 callers omitted/);

  // path: scopes the entry too, so it narrows callers only at or above the
  // definition's own directory — src/ here, which drops the three test callers.
  const scoped = formatMcpToolResult("graph", {
    ...graphResult,
    symbols,
    constraint: "src",
  });
  assert.deepEqual(
    scoped.structuredContent.callers.map((caller) => caller.name),
    ["boot", "wire"],
  );
  // Two callers are in scope and the cap is four, so nothing is omitted.
  assert.equal(scoped.text.includes("callers omitted"), false);
  assert.equal(scoped.text.includes("specA"), false);
});

const giantClass = {
  name: "FastAPI",
  kind: "class",
  path: "fastapi/applications.py",
  startLine: 52,
  endLine: 4816,
  callees: [],
  callers: [],
  members: [
    { name: "__init__", path: "fastapi/applications.py", line: 68, endLine: 1030, callerCount: 0 },
    { name: "build_middleware_stack", path: "fastapi/applications.py", line: 1032, endLine: 1083, callerCount: 1 },
    { name: "openapi", path: "fastapi/applications.py", line: 1085, endLine: 1118, callerCount: 192 },
    { name: "setup", path: "fastapi/applications.py", line: 1120, endLine: 1173, callerCount: 1 },
    // Nested inside setup: describes setup's body, not a way into the class.
    { name: "swagger_ui_html", path: "fastapi/applications.py", line: 1138, endLine: 1150, callerCount: 0 },
    { name: "include_router", path: "fastapi/applications.py", line: 1483, endLine: 1686, callerCount: 125 },
    { name: "get", path: "fastapi/applications.py", line: 1688, endLine: 2059, callerCount: 27 },
    { name: "post", path: "fastapi/applications.py", line: 2439, endLine: 2815, callerCount: 564 },
  ],
};

test("giant definition is never presented as a single whole-span read", () => {
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    query: "FastAPI",
    symbols: [giantClass],
  });
  const [entry] = formatted.structuredContent.entries;

  // The presented span is the head, not the 4765-line body.
  assert.equal(entry.startLine, 52);
  assert.equal(entry.endLine, 67);
  assert.equal(entry.spanCapped, true);
  assert.equal(entry.definitionEndLine, 4816);
  assert.equal(entry.definitionLines, 4765);
  assert.equal(formatted.text.includes("52-4816 FastAPI"), false);
  assert.match(formatted.text, /fastapi\/applications\.py:52-67 FastAPI/);
  assert.match(formatted.text, /too big to read; use the entry points below/);

  // The body is reached through method locators, most-called first, and the
  // nested helper inside setup() is not offered as an entry point.
  assert.deepEqual(
    formatted.structuredContent.members.map((member) => member.name),
    ["post", "openapi", "include_router", "get", "build_middleware_stack", "setup"],
  );
  assert.match(formatted.text, /fastapi\/applications\.py:2439-2815 post/);
  assert.equal(formatted.text.includes("swagger_ui_html"), false);
  assert.match(formatted.text, /\+1 methods omitted/);
});

test("giant-definition omitted count covers exactly the unshown top-level methods", () => {
  const members = [];
  for (let index = 0; index < 30; index += 1) {
    members.push({
      name: `method${index}`,
      path: "src/huge.ts",
      line: 20 + index * 10,
      endLine: 28 + index * 10,
      callerCount: 30 - index,
    });
  }
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    query: "Huge",
    symbols: [
      {
        name: "Huge",
        kind: "class",
        path: "src/huge.ts",
        startLine: 10,
        endLine: 900,
        callees: [],
        callers: [],
        members,
      },
    ],
  });
  const shown = formatted.structuredContent.members.length;
  assert.equal(shown, MEMBER_CAP);
  assert.match(formatted.text, new RegExp(`\\+${members.length - shown} methods omitted`));
  assert.equal(formatted.structuredContent.truncated, true);
  assert.match(formatted.text, /continue once now/);
  assert.match(formatted.text, /truncation\.retry/);
});

// The member list is a shared pool capped at MEMBER_CAP, so one giant entry's
// members can push another's entirely into the "+N methods omitted" line. The
// note must still tell the agent those entry points exist.
test("a giant definition whose members are all omitted still points at them", () => {
  const members = (path, base, count, callers) =>
    Array.from({ length: count }, (_, index) => ({
      name: `m${base + index}`,
      path,
      line: 10 + index * 10,
      endLine: 18 + index * 10,
      callerCount: callers - index,
    }));
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    query: "AlphaClass BetaClass",
    result: [
      "**Exploration: AlphaClass BetaClass**",
      "",
      "Found 2 symbols across 2 files.",
      "",
      "**`src/a.ts`** — AlphaClass(class)",
      "",
      "**`src/b.ts`** — BetaClass(class)",
      "",
    ].join("\n"),
    symbols: [
      {
        name: "AlphaClass",
        kind: "class",
        path: "src/a.ts",
        startLine: 1,
        endLine: 900,
        callees: [],
        callers: [],
        members: members("src/a.ts", 0, MEMBER_CAP, 100),
      },
      {
        name: "BetaClass",
        kind: "class",
        path: "src/b.ts",
        startLine: 1,
        endLine: 900,
        callees: [],
        callers: [],
        members: members("src/b.ts", 100, 4, 1),
      },
    ],
  });
  const [alpha, beta] = formatted.structuredContent.entries;
  assert.equal(alpha.spanCapped, true);
  assert.equal(beta.spanCapped, true);
  // AlphaClass filled the member pool; every BetaClass member is omitted.
  assert.equal(
    formatted.structuredContent.members.every(
      (member) => member.path === "src/a.ts",
    ),
    true,
  );
  assert.match(formatted.text, /\+4 methods omitted/);
  const notes = formatted.text.match(/body spans .+$/gm);
  assert.match(notes[0], /use the entry points below/);
  assert.match(
    notes[1],
    /its entry points are in the omitted methods below/,
  );
});

// A long function has no methods to offer, so the note must not promise entry
// points that are not there.
test("a giant definition with no members is capped without promising entry points", () => {
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    query: "include_router",
    symbols: [
      {
        name: "include_router",
        kind: "method",
        path: "fastapi/applications.py",
        startLine: 1483,
        endLine: 1686,
        callees: [],
        callers: [],
        members: [],
      },
    ],
  });
  const [entry] = formatted.structuredContent.entries;
  assert.equal(entry.spanCapped, true);
  assert.equal(entry.definitionEndLine, 1686);
  assert.equal(formatted.text.includes("1483-1686 include_router"), false);
  assert.equal(formatted.text.includes("entry points"), false);
  assert.match(formatted.text, /too big to read whole; the span above is its head/);
  assert.deepEqual(formatted.structuredContent.members, []);
});

test("a definition at or under the giant threshold keeps its whole span", () => {
  const formatted = formatMcpToolResult("graph", {
    ...graphResult,
    query: "Small",
    symbols: [
      {
        name: "Small",
        kind: "class",
        path: "src/small.ts",
        startLine: 1,
        endLine: GIANT_SPAN_LINES,
        callees: [],
        callers: [],
        members: [
          { name: "run", path: "src/small.ts", line: 4, endLine: 9, callerCount: 3 },
        ],
      },
    ],
  });
  const [entry] = formatted.structuredContent.entries;
  assert.equal(entry.endLine, GIANT_SPAN_LINES);
  assert.equal(entry.spanCapped, undefined);
  assert.deepEqual(formatted.structuredContent.members, []);
  assert.equal(formatted.text.includes("entry points"), false);
  assert.equal(formatted.text.includes("too big to read"), false);
});

test("literal grep with unescaped | or groups hints regex:true and stays 0 hits", () => {
  const hint =
    /regex:true if this was a regular expression; this grep was literal/;
  for (const pattern of [
    "Foo|Bar",
    "@app.(get|post|put|delete)",
    "class ComparisonStatus|DatasetKind",
    "gitlab_comment omits|代码评审",
  ]) {
    const formatted = formatMcpToolResult("grep", {
      status: "ready",
      root: "/repo",
      pattern,
      mode: "plain",
      results: [],
    });
    assert.match(formatted.text, hint, pattern);
    assert.match(formatted.text, /0 matches/);
    assert.equal(formatted.structuredContent.hits.length, 0);
    assert.equal(formatted.text.includes("[fuzzy]"), false);
  }

  const escaped = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: String.raw`Foo\|Bar`,
    mode: "plain",
    results: [],
  });
  assert.equal(escaped.text.includes("regex:true"), false);

  for (const pattern of [
    "foo.ts",
    "process.env",
    "array[0]",
    "$HOME",
    ".",
    "[]",
    "^",
    "$",
    'status === "interrupted"',
  ]) {
    const formatted = formatMcpToolResult("grep", {
      status: "ready",
      root: "/repo",
      pattern,
      mode: "plain",
      results: [],
    });
    assert.equal(formatted.text.includes("regex:true"), false, pattern);
  }

  const alreadyRegex = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "Foo|Bar",
    mode: "regex",
    regex: true,
    results: [],
  });
  assert.equal(alreadyRegex.text.includes("regex:true if"), false);
});

test("identifier grep appends a stop-loop tail and a once-only graph hook", () => {
  const hit = {
    path: "src/pkg/kinds.py",
    line: 4,
    column: 1,
    text: "def dataset_kind():",
  };
  const hooked = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "dataset_kind",
    mode: "plain",
    results: [hit],
  });
  const lines = hooked.text.trimEnd().split("\n");
  assert.equal(lines.at(-1), identifierGraphHook("dataset_kind"));
  assert.equal(lines.at(-2), IDENTIFIER_GREP_LOCATED);
  assert.equal(
    lines.filter((line) => line.startsWith("callers/callees:")).length,
    1,
  );
  assert.match(hooked.text, /do not Read the whole file/);
  assert.equal(hooked.text.includes("next: Read"), false);
  assert.doesNotMatch(hooked.text, /^callers$/m);

  for (const pattern of [
    "dataset_kind:",
    "dataset_kind=bogus",
    'status === "interrupted"',
    "Kubernetes Pod query failed",
  ]) {
    const formatted = formatMcpToolResult("grep", {
      status: "ready",
      root: "/repo",
      pattern,
      mode: "plain",
      results: [hit],
    });
    assert.equal(formatted.text.includes("callers/callees:"), false, pattern);
    assert.equal(formatted.text.includes("located."), false, pattern);
  }

  const regex = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "dataset_kind",
    mode: "regex",
    regex: true,
    results: [hit],
  });
  assert.equal(regex.text.includes("callers/callees:"), false);
  assert.equal(regex.text.includes("located."), false);

  const fuzzy = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "dataset_kind",
    mode: "fuzzy",
    results: [hit],
  });
  assert.equal(fuzzy.text.includes("callers/callees:"), false);
  assert.equal(fuzzy.text.includes("located."), false);

  const miss = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "dataset_kind",
    mode: "plain",
    results: [],
  });
  assert.equal(miss.text.includes("callers/callees:"), false);
  assert.equal(miss.text.includes("located."), false);
});

test("find or-query with zero hits teaches two find calls and does not rewrite the query", () => {
  const miss = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "pytest.ini or pyproject.toml",
    total: 0,
    results: [],
  });
  assert.match(miss.text, /find pytest.ini or pyproject.toml — 0 matches/);
  assert.match(
    miss.text,
    /find is not boolean; search "pytest.ini" and "pyproject.toml" as two find calls/,
  );
  assert.deepEqual(miss.structuredContent.paths, []);

  const hit = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "pytest.ini or pyproject.toml",
    total: 1,
    results: [{ path: "pytest.ini" }],
  });
  assert.equal(hit.text.includes("not boolean"), false);
  assert.deepEqual(hit.structuredContent.paths, ["pytest.ini"]);

  const globOr = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "*profile* or *config*",
    total: 0,
    results: [],
  });
  assert.match(globOr.text, /find uses path fragments, not globs/);
  assert.match(globOr.text, /find is not boolean/);
});

test("grep context neighbors appear in text, not only structured hits", () => {
  const formatted = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    rootSource: "root",
    pattern: "match",
    mode: "plain",
    context: 2,
    results: [
      {
        path: "src/app.ts",
        line: 10,
        column: 1,
        text: "const match = 1;",
        contextBefore: ["const a = 1;", "const b = 2;"],
        contextAfter: ["const c = 3;", "const d = 4;"],
      },
      {
        path: "src/other.ts",
        line: 2,
        column: 1,
        text: "match();",
        contextBefore: ["export function go() {"],
        contextAfter: ["}"],
      },
    ],
  });
  const text = formatted.text;
  assert.equal(text.split("\n")[0], "[ready] root /repo via root argument");
  assert.match(text, /^src\/app\.ts:8 const a = 1;$/m);
  assert.match(text, /^src\/app\.ts:9 const b = 2;$/m);
  assert.match(text, /^src\/app\.ts:10 const match = 1;$/m);
  assert.match(text, /^src\/app\.ts:11 const c = 3;$/m);
  assert.match(text, /^src\/app\.ts:12 const d = 4;$/m);
  assert.match(text, /^src\/other\.ts:1 export function go\(\) \{$/m);
  assert.match(text, /^src\/other\.ts:2 match\(\);$/m);
  assert.match(text, /src\/app\.ts:12 const d = 4;\n\nsrc\/other\.ts:1 /);
  assert.equal(text.includes("```"), false);
  assert.deepEqual(formatted.structuredContent.hits[0].before, [
    "const a = 1;",
    "const b = 2;",
  ]);
  assert.deepEqual(formatted.structuredContent.hits[0].after, [
    "const c = 3;",
    "const d = 4;",
  ]);
});

test("grep context above 3 is clamped in the reply", () => {
  const formatted = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "match",
    mode: "plain",
    context: 3,
    contextCapped: true,
    results: [
      {
        path: "src/app.ts",
        line: 10,
        column: 1,
        text: "const match = 1;",
        contextBefore: ["a", "b", "c"],
        contextAfter: ["d", "e", "f"],
      },
    ],
  });
  assert.match(formatted.text, /context capped at 3/);
  assert.match(formatted.text, /^src\/app\.ts:7 a$/m);
  assert.match(formatted.text, /^src\/app\.ts:13 f$/m);
  assert.equal(formatted.text.includes("context capped at 10"), false);
});

test("grep without context keeps single-line locators even if arrays are present", () => {
  const formatted = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "match",
    mode: "plain",
    results: [
      {
        path: "src/app.ts",
        line: 10,
        column: 1,
        text: "const match = 1;",
        contextBefore: ["const a = 1;"],
        contextAfter: ["const c = 3;"],
      },
    ],
  });
  assert.match(formatted.text, /^src\/app\.ts:10 const match = 1;$/m);
  assert.equal(formatted.text.includes("const a = 1;"), false);
  assert.equal(formatted.text.includes("const c = 3;"), false);
  assert.equal("before" in formatted.structuredContent.hits[0], false);
});

test("grep formatter prints the daemon page instead of recapping at 16", () => {
  const hits = Array.from({ length: 30 }, (_, i) => ({
    path: `src/f${i}.ts`,
    line: i + 1,
    column: 1,
    text: "token",
  }));
  const thirty = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "token",
    mode: "plain",
    requestedLimit: 30,
    pageCap: 48,
    nextCursor: "abc",
    results: hits,
  });
  assert.equal(thirty.structuredContent.hits.length, 30);
  assert.match(thirty.text, /grep token — 30\/\? shown, more remain/);
  assert.equal(thirty.text.includes("capped at"), false);

  const omitted = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "token",
    mode: "plain",
    requestedLimit: null,
    pageCap: 48,
    nextCursor: "abc",
    results: hits.slice(0, 16),
  });
  assert.equal(omitted.structuredContent.hits.length, 16);
  assert.match(omitted.text, /grep token — 16\/\? shown, more remain/);
  assert.equal(omitted.text.includes("capped at"), false);

  const capped = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "token",
    mode: "plain",
    requestedLimit: 500,
    pageCap: 48,
    nextCursor: "abc",
    results: Array.from({ length: 48 }, (_, i) => ({
      path: `src/f${i}.ts`,
      line: i + 1,
      column: 1,
      text: "token",
    })),
  });
  assert.equal(capped.structuredContent.hits.length, 48);
  assert.match(capped.text, /truncated — continue once now/);
  assert.deepEqual(capped.structuredContent.truncation.retry, { cursor: "abc" });
  assert.equal(capped.text.includes("cursor=abc"), false);

  const ten = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "token",
    mode: "plain",
    requestedLimit: 10,
    pageCap: 48,
    results: hits.slice(0, 10),
  });
  assert.equal(ten.structuredContent.hits.length, 10);
  assert.match(ten.text, /grep token — 10 matches in 10 files/);
});

test("grep count is a number sentence with empty hits", () => {
  const counted = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "token",
    mode: "plain",
    count: true,
    matchCount: 12,
    fileCount: 4,
    results: [
      { path: "src/app.ts", line: 1, column: 1, text: "token" },
    ],
  });
  assert.equal(
    counted.text.split("\n").slice(1).join("\n"),
    "grep token — 12 matches in 4 files",
  );
  assert.deepEqual(counted.structuredContent.hits, []);
  assert.equal(counted.structuredContent.matchCount, 12);
  assert.equal(counted.structuredContent.fileCount, 4);
  assert.equal(counted.text.includes("src/app.ts"), false);

  const capped = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "token",
    mode: "plain",
    count: true,
    countTruncated: true,
    matchCount: 4096,
    fileCount: 90,
    results: [],
  });
  assert.match(
    capped.text,
    /grep token — ≥4096 matches in 90 files, more remain/,
  );
  assert.deepEqual(capped.structuredContent.hits, []);
});

test("find short-fragment truncation teaches fragment-first", () => {
  const results = Array.from({ length: 16 }, (_, i) => ({
    path: `src/f${i}.ts`,
  }));
  const hint =
    /find is a path fragment, not a glob; a short token matches widely — use a filename with extension, a directory, or host Glob/;
  const profile = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "profile",
    total: 40,
    results,
  });
  assert.match(profile.text, hint);

  for (const query of ["foo.py", "profiles/", "SKILL.md"]) {
    const formatted = formatMcpToolResult("find", {
      status: "ready",
      root: "/repo",
      query,
      total: 40,
      results,
    });
    assert.equal(formatted.text.includes("short token matches widely"), false, query);
  }

  const complete = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "profile",
    total: 2,
    results: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
  });
  assert.equal(complete.text.includes("short token matches widely"), false);
});

test("find confirmation teaches not to find again and is not an error", () => {
  const byExt = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "overview.md",
    total: 1,
    results: [{ path: "docs/architecture/overview.md" }],
  });
  assert.match(byExt.text, new RegExp(escapeRegExp(FIND_CONFIRM), "m"));
  assert.equal(byExt.structuredContent.truncated, false);
  assert.equal(byExt.text.includes("isError"), false);

  const byBasename = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "widget.py",
    total: 1,
    results: [{ path: "src/pkg/widget.py" }],
  });
  assert.match(byBasename.text, new RegExp(escapeRegExp(FIND_CONFIRM), "m"));

  const fragment = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "widget",
    total: 1,
    results: [{ path: "src/pkg/widget.py" }],
  });
  assert.equal(fragment.text.includes("do not find to confirm"), false);

  const miss = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "overview.md",
    total: 0,
    results: [],
  });
  assert.equal(miss.text.includes("do not find to confirm"), false);
});

test("find confirmation tells agents the path is ready for host Read", () => {
  const hit = formatMcpToolResult("find", {
    status: "ready",
    root: "/repo",
    query: "overview.md",
    total: 1,
    results: [{ path: "docs/architecture/overview.md" }],
  });
  assert.match(hit.text, /join to root for host Read/);
  assert.match(MCP_INSTRUCTIONS, /find takes a path fragment or file name/);
});

test("empty tool menu and MCP instructions stop the locate loop", () => {
  assert.match(
    EMPTY_TOOL_MENU,
    /Then Read only those spans, not whole files; skip Read if span \+ neighbors suffice/,
  );
  assert.equal(EMPTY_TOOL_MENU.includes("Then host Read the spans."), false);
  assert.match(MCP_INSTRUCTIONS, /already located/);
  assert.match(MCP_INSTRUCTIONS, /Host Read only the span/);
  assert.equal(
    MCP_INSTRUCTIONS.includes("Replies are locators. Read source with the host Read tool."),
    false,
  );
});
