import assert from "node:assert/strict";
import test from "node:test";
import {
  extractCandidates,
  exactNeighborhoodSkip,
  jevClientOptions,
  jevConfig,
  jevEnabled,
  JEV_TIMEOUT_MS,
  maybeRerank,
  mixedGrepSkip,
  prodShortlistSkip,
  rerank,
  skipReason,
  tierOrderSkip,
} from "../src/jev.js";
import { neighborhood } from "../src/graph-map.js";
import { formatMcpToolResult } from "../src/mcp-format.js";
import { pathTier } from "../src/path-tier.js";

const grepResult = {
  status: "ready",
  root: "/repo",
  pattern: "render_widget",
  mode: "plain",
  results: [
    {
      path: "src/pkg/foo_test.py",
      line: 8,
      column: 1,
      text: "def test_render_widget_includes_name():",
    },
    {
      path: "src/pkg/foo.py",
      line: 14,
      column: 1,
      text: "def render_widget(name, color, width=12):",
      contextBefore: ["", ""],
      contextAfter: [
        '    """Paint a named widget onto the canvas."""',
        "    boxed = layout(name, width)",
      ],
    },
    {
      path: "src/ui/widget.py",
      line: 9,
      column: 1,
      text: 'def render_widget(name, theme="gray"):',
    },
  ],
};

const prodGrepResult = {
  status: "ready",
  root: "/repo",
  pattern: "render_widget",
  mode: "plain",
  results: [
    {
      path: "src/pkg/foo.py",
      line: 14,
      column: 1,
      text: "def render_widget(name, color, width=12):",
    },
    {
      path: "src/ui/widget.py",
      line: 9,
      column: 1,
      text: 'def render_widget(name, theme="gray"):',
    },
    {
      path: "src/pkg/layout.py",
      line: 3,
      column: 1,
      text: "def render_widget_box():",
    },
  ],
};

const prodFindResult = {
  status: "ready",
  query: "foo.py",
  results: [
    { path: "src/pkg/foo.py", matchType: "exact" },
    { path: "src/pkg/other.py", matchType: "fuzzy" },
  ],
};

const mixedConfigFindResult = {
  status: "ready",
  query: "ci",
  results: [
    { path: "src/pkg/foo.py", matchType: "fuzzy" },
    { path: ".github/workflows/ci.yml", matchType: "fuzzy" },
  ],
};

const mixedConfigGrepResult = {
  status: "ready",
  root: "/repo",
  pattern: "render_widget",
  mode: "plain",
  results: [
    {
      path: "src/pkg/foo.py",
      line: 14,
      column: 1,
      text: "def render_widget(name, color, width=12):",
    },
    {
      path: ".github/workflows/ci.yml",
      line: 4,
      column: 1,
      text: "render_widget",
    },
  ],
};

const mixedDistFindResult = {
  status: "ready",
  query: "async",
  results: [
    { path: "src/pkg/foo.py", matchType: "fuzzy" },
    { path: "dist/async.js", matchType: "fuzzy" },
  ],
};

const mixedDistGrepResult = {
  status: "ready",
  root: "/repo",
  pattern: "render_widget",
  mode: "plain",
  results: [
    {
      path: "src/pkg/foo.py",
      line: 14,
      column: 1,
      text: "def render_widget(name, color, width=12):",
    },
    {
      path: "dist/async.js",
      line: 4,
      column: 1,
      text: "render_widget",
    },
  ],
};

const allConfigFindResult = {
  status: "ready",
  query: "ci",
  results: [
    { path: ".github/workflows/ci.yml", matchType: "fuzzy" },
    { path: ".editorconfig", matchType: "fuzzy" },
  ],
};

const allDocsFindResult = {
  status: "ready",
  query: "guide",
  results: [
    { path: "docs/guide.md", matchType: "fuzzy" },
    { path: "README.md", matchType: "fuzzy" },
  ],
};

function graphExactNeighborhood(extra = {}) {
  return {
    status: "ready",
    root: "/repo",
    query: "how does render_widget work",
    result: "",
    symbols: [
      {
        name: "render_widget",
        kind: "function",
        path: "src/pkg/foo.py",
        startLine: 14,
        endLine: 22,
        callees: [{ name: "layout", path: "src/pkg/layout.py", line: 1, endLine: 2 }],
        callers: [{ name: "show", path: "src/pkg/widget.py", line: 25, endLine: 27 }],
      },
    ],
    ...extra,
  };
}

function noulFor(state, questions) {
  const answers = {};
  for (const key of Object.keys(questions)) {
    const index = Number(key.slice(1));
    const anchors = Object.keys(state.hits);
    const anchor = anchors[index] || "";
    const impl = /foo\.py:14|widget\.py:9/.test(anchor);
    answers[key] = { type: "noul", noul: impl ? 0.9 : 0.08 };
  }
  return { model: "configured-model", answers, usage: { input_tokens: 1, output_tokens: 1 } };
}

test("Jev runs iff a key is configured", () => {
  assert.equal(jevEnabled({}), false);
  assert.equal(jevEnabled({ CODEQ_JEV: "1" }), false);
  assert.equal(jevEnabled({ TYPESAFE_API_KEY: "x" }), false);
  assert.equal(jevEnabled({ CODEQ_JEV_KEY: "   " }), false);
  assert.equal(jevEnabled({ CODEQ_JEV_KEY: "x" }), true);
  const configured = jevConfig({
    CODEQ_JEV_KEY: "x",
    CODEQ_JEV_URL: "https://jev.example.test",
    CODEQ_JEV_MODEL: "configured-model",
  });
  assert.equal(configured.url, "https://jev.example.test");
  assert.equal(configured.model, "configured-model");
  assert.equal(configured.timeoutMs, 800);
  assert.equal(JEV_TIMEOUT_MS, 800);
  const options = jevClientOptions({
    CODEQ_JEV_KEY: "x",
    CODEQ_JEV_URL: "https://jev.example.test",
    CODEQ_JEV_MODEL: "configured-model",
  });
  assert.equal(options.baseURL, "https://jev.example.test");
  assert.equal(options.defaultModel, "configured-model");
  assert.equal(options.timeout, 800);
  assert.equal(options.retry.maxRetries, 0);
});

test("maybeRerank is a no-op when disabled", async () => {
  const ranked = await maybeRerank("grep", { query: "render_widget" }, grepResult, {
    env: {},
    systemOne: async () => {
      throw new Error("should not call Jev");
    },
  });
  assert.deepEqual(ranked.results, grepResult.results);
  assert.deepEqual(ranked.jev, { applied: false, skipped: "no_key" });
});

test("zero and one hits skip Jev", async () => {
  const empty = { ...grepResult, results: [] };
  const once = { ...grepResult, results: grepResult.results.slice(0, 1) };
  const systemOne = async () => {
    throw new Error("should not call Jev");
  };
  assert.equal(await rerank("grep", { query: "render_widget" }, empty, { systemOne }), empty);
  assert.equal(await rerank("grep", { query: "render_widget" }, once, { systemOne }), once);
  const skipped = await maybeRerank("grep", { query: "render_widget" }, once, {
    env: { CODEQ_JEV_KEY: "x" },
    systemOne,
  });
  assert.equal(skipped.jev.skipped, "too_few");
});

test("rerank sorts grep hits by Noul and never drops one", async () => {
  const seen = [];
  const ranked = await rerank(
    "grep",
    { query: "how does render_widget work", command: "grep" },
    grepResult,
    {
      systemOne: async (payload) => {
        seen.push(payload);
        return noulFor(payload.state, payload.questions);
      },
    },
  );
  assert.equal(ranked.results.length, 3);
  assert.deepEqual(
    ranked.results.map((hit) => `${hit.path}:${hit.line}`),
    ["src/pkg/foo.py:14", "src/ui/widget.py:9", "src/pkg/foo_test.py:8"],
  );
  assert.equal(ranked.preserveOrder, true);
  const payload = seen[0];
  assert.equal(payload.state.request.tool, "grep");
  assert.equal(Object.keys(payload.questions).some((key) => key.startsWith("s")), false);
  assert.equal(Object.keys(payload.questions).some((key) => key.includes("choice")), false);
});

test("fail-open returns the engine page on Jev errors", async () => {
  const ranked = await maybeRerank(
    "grep",
    { query: "render_widget" },
    grepResult,
    {
      env: { CODEQ_JEV_KEY: "x" },
      systemOne: async () => {
        throw new Error("timeout");
      },
    },
  );
  assert.deepEqual(ranked.results, grepResult.results);
  assert.deepEqual(ranked.jev, { applied: false, skipped: "timeout" });
});

test("a Jev call that outlives the budget fails open near the timeout", async () => {
  const started = Date.now();
  const ranked = await maybeRerank(
    "grep",
    { query: "render_widget" },
    grepResult,
    {
      env: { CODEQ_JEV_KEY: "x" },
      // A hung call the SDK timeout never fires on must not hold the reply:
      // maybeRerank races rerank against JEV_TIMEOUT_MS and keeps the page.
      systemOne: () => new Promise(() => {}),
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < JEV_TIMEOUT_MS * 3, `expected fallback near ${JEV_TIMEOUT_MS}ms, took ${elapsed}ms`);
  assert.deepEqual(ranked.results, grepResult.results);
  assert.deepEqual(ranked.jev, { applied: false, skipped: "timeout" });
});

test("literal grep with a production vis16 skips the optional rerank", async () => {
  let called = 0;
  const systemOne = async () => {
    called += 1;
    throw new Error("should not call optional rerank");
  };
  assert.equal(prodShortlistSkip("grep", { query: "render_widget" }, prodGrepResult), true);
  const ranked = await maybeRerank("grep", { query: "render_widget" }, prodGrepResult, {
    env: { CODEQ_JEV_KEY: "x" },
    systemOne,
  });
  assert.equal(called, 0);
  assert.deepEqual(ranked.jev, { applied: false, skipped: "prod_shortlist" });
  assert.equal(ranked.preserveOrder, true);
  assert.deepEqual(ranked.results, prodGrepResult.results);
  const formatted = formatMcpToolResult("grep", ranked);
  assert.equal(/jev|noul|prod_shortlist|exact_neighborhood|tier_order|mixed_grep|skipped/i.test(formatted.text), false);
});

test("no key is still no_key on a production vis16", async () => {
  const ranked = await maybeRerank("grep", { query: "render_widget" }, prodGrepResult, {
    env: {},
    systemOne: async () => {
      throw new Error("should not call optional rerank");
    },
  });
  assert.deepEqual(ranked.jev, { applied: false, skipped: "no_key" });
});

function stubAnswers(payload) {
  const answers = {};
  for (const key of Object.keys(payload.questions)) {
    answers[key] = { type: "noul", noul: 0.1 };
  }
  return { answers };
}

test("find with an all-production vis16 skips the optional rerank", async () => {
  let called = 0;
  const systemOne = async () => {
    called += 1;
    throw new Error("should not call optional rerank");
  };
  assert.equal(prodShortlistSkip("find", { query: "foo.py" }, prodFindResult), true);
  const ranked = await maybeRerank("find", { query: "foo.py" }, prodFindResult, {
    env: { CODEQ_JEV_KEY: "x" },
    systemOne,
  });
  assert.equal(called, 0);
  assert.deepEqual(ranked.jev, { applied: false, skipped: "prod_shortlist" });
  assert.equal(ranked.preserveOrder, true);
  assert.deepEqual(ranked.results, prodFindResult.results);
  const formatted = formatMcpToolResult("find", ranked);
  assert.equal(/jev|noul|prod_shortlist|exact_neighborhood|tier_order|mixed_grep|skipped/i.test(formatted.text), false);
});

test("regex, fuzzy, and mixed-tier grep with 2+ hits in a bucket still call the optional rerank", async () => {
  const calls = [];
  const systemOne = async (payload) => {
    calls.push(payload.state.request.tool);
    return stubAnswers(payload);
  };
  const env = { CODEQ_JEV_KEY: "x" };

  await maybeRerank(
    "grep",
    { query: "render_widget", regex: true },
    { ...prodGrepResult, mode: "regex" },
    { env, systemOne },
  );
  await maybeRerank(
    "grep",
    { query: "render_widget", fuzzy: true },
    { ...prodGrepResult, mode: "fuzzy" },
    { env, systemOne },
  );
  await maybeRerank("grep", { query: "render_widget" }, grepResult, { env, systemOne });
  await maybeRerank(
    "grep",
    { query: "render_widget", regex: true },
    { ...mixedConfigGrepResult, mode: "regex" },
    { env, systemOne },
  );
  await maybeRerank(
    "grep",
    { query: "render_widget", fuzzy: true },
    { ...mixedDistGrepResult, mode: "fuzzy" },
    { env, systemOne },
  );

  assert.deepEqual(calls, ["grep", "grep", "grep", "grep", "grep"]);
  assert.equal(prodShortlistSkip("grep", { regex: true }, { ...prodGrepResult, mode: "regex" }), false);
  assert.equal(
    prodShortlistSkip("grep", { query: "render_widget" }, grepResult),
    false,
  );
  assert.equal(mixedGrepSkip("grep", { query: "render_widget" }, grepResult), false);
  assert.equal(
    prodShortlistSkip("grep", { query: "render_widget" }, mixedConfigGrepResult),
    false,
  );
  assert.equal(
    prodShortlistSkip("grep", { query: "render_widget" }, mixedDistGrepResult),
    false,
  );
  assert.equal(tierOrderSkip("grep", { query: "render_widget" }, mixedDistGrepResult), false);
  assert.equal(
    prodShortlistSkip(
      "grep",
      { query: "render_widget" },
      {
        mode: "plain",
        results: [
          { path: "src/pkg/foo.py", line: 1, column: 1, text: "def render_widget():" },
          {
            path: "library/src/actions/args/args.test.ts",
            line: 11,
            column: 1,
            text: "render_widget()",
          },
        ],
      },
    ),
    false,
  );
});

test("literal grep with one hit per pathTier skips as mixed_grep", async () => {
  let called = 0;
  const systemOne = async () => {
    called += 1;
    throw new Error("should not call optional rerank");
  };
  const env = { CODEQ_JEV_KEY: "x" };
  const singletonMixed = {
    status: "ready",
    root: "/repo",
    pattern: "render_widget",
    mode: "plain",
    results: [
      {
        path: "src/pkg/foo.py",
        line: 14,
        column: 1,
        text: "def render_widget():",
      },
      {
        path: "runtime-tests/deno/a.ts",
        line: 3,
        column: 1,
        text: "render_widget()",
      },
    ],
  };

  assert.equal(pathTier("src/pkg/foo.py"), 0);
  assert.equal(pathTier("runtime-tests/deno/a.ts"), 2);
  assert.equal(mixedGrepSkip("grep", { query: "render_widget" }, singletonMixed), true);
  assert.equal(mixedGrepSkip("grep", { query: "render_widget" }, mixedConfigGrepResult), true);
  assert.equal(mixedGrepSkip("grep", { query: "render_widget" }, mixedDistGrepResult), true);
  assert.equal(prodShortlistSkip("grep", { query: "render_widget" }, singletonMixed), false);
  assert.equal(tierOrderSkip("grep", { query: "render_widget" }, singletonMixed), false);
  assert.equal(mixedGrepSkip("find", { query: "foo.py" }, mixedConfigFindResult), false);
  assert.equal(mixedGrepSkip("graph", { query: "render_widget" }, graphExactNeighborhood()), false);
  assert.equal(
    mixedGrepSkip("grep", { query: "render_widget", regex: true }, { ...singletonMixed, mode: "regex" }),
    false,
  );
  assert.equal(
    mixedGrepSkip("grep", { query: "render_widget", fuzzy: true }, { ...singletonMixed, mode: "fuzzy" }),
    false,
  );

  const ranked = await maybeRerank("grep", { query: "render_widget" }, singletonMixed, {
    env,
    systemOne,
  });
  assert.equal(called, 0);
  assert.deepEqual(ranked.jev, { applied: false, skipped: "mixed_grep" });
  assert.equal(ranked.preserveOrder, true);
  assert.deepEqual(ranked.results, singletonMixed.results);
  const formatted = formatMcpToolResult("grep", ranked);
  assert.equal(
    /jev|noul|prod_shortlist|exact_neighborhood|tier_order|mixed_grep|skipped/i.test(formatted.text),
    false,
  );

  const config = await maybeRerank("grep", { query: "render_widget" }, mixedConfigGrepResult, {
    env,
    systemOne,
  });
  assert.equal(called, 0);
  assert.deepEqual(config.jev, { applied: false, skipped: "mixed_grep" });

  const dist = await maybeRerank("grep", { query: "render_widget" }, mixedDistGrepResult, {
    env,
    systemOne,
  });
  assert.equal(called, 0);
  assert.deepEqual(dist.jev, { applied: false, skipped: "mixed_grep" });
});

test("literal grep with 2+ hits in one pathTier still calls Jev", async () => {
  let called = 0;
  const env = { CODEQ_JEV_KEY: "x" };
  const twoProdOneTest = {
    status: "ready",
    root: "/repo",
    pattern: "render_widget",
    mode: "plain",
    results: [
      {
        path: "src/pkg/foo.py",
        line: 14,
        column: 1,
        text: "def render_widget():",
      },
      {
        path: "src/pkg/bar.py",
        line: 2,
        column: 1,
        text: "render_widget()",
      },
      {
        path: "runtime-tests/deno/a.ts",
        line: 3,
        column: 1,
        text: "render_widget()",
      },
    ],
  };
  assert.equal(mixedGrepSkip("grep", { query: "render_widget" }, twoProdOneTest), false);
  const sameFileTwoHits = {
    status: "ready",
    root: "/repo",
    pattern: "render_widget",
    mode: "plain",
    results: [
      {
        path: "src/pkg/foo.py",
        line: 14,
        column: 1,
        text: "def render_widget():",
      },
      {
        path: "src/pkg/foo.py",
        line: 20,
        column: 1,
        text: "render_widget()",
      },
      {
        path: "runtime-tests/deno/a.ts",
        line: 3,
        column: 1,
        text: "render_widget()",
      },
    ],
  };
  assert.equal(mixedGrepSkip("grep", { query: "render_widget" }, sameFileTwoHits), false);
  const ranked = await maybeRerank("grep", { query: "render_widget" }, twoProdOneTest, {
    env,
    systemOne: async (payload) => {
      called += 1;
      const answers = {};
      for (const key of Object.keys(payload.questions)) {
        const index = Number(key.slice(1));
        const anchors = Object.keys(payload.state.hits);
        const anchor = anchors[index] || "";
        answers[key] = {
          type: "noul",
          noul: anchor.includes("runtime-tests")
            ? 0.99
            : anchor.includes("bar.py")
              ? 0.8
              : 0.1,
        };
      }
      return { answers };
    },
  });
  assert.equal(called, 1);
  assert.equal(ranked.jev.applied, true);
  assert.equal(ranked.jev.skipped, undefined);
  const paths = ranked.results.map((hit) => hit.path);
  const tiers = paths.map((filePath) => pathTier(filePath));
  for (let index = 1; index < tiers.length; index += 1) {
    assert.ok(tiers[index] >= tiers[index - 1], paths.join(" "));
  }
  assert.deepEqual(paths, [
    "src/pkg/bar.py",
    "src/pkg/foo.py",
    "runtime-tests/deno/a.ts",
  ]);

  const allConfigGrep = {
    status: "ready",
    root: "/repo",
    pattern: "render_widget",
    mode: "plain",
    results: [
      { path: ".github/workflows/ci.yml", line: 4, column: 1, text: "render_widget" },
      { path: ".editorconfig", line: 1, column: 1, text: "render_widget" },
    ],
  };
  assert.equal(mixedGrepSkip("grep", { query: "render_widget" }, allConfigGrep), false);
  assert.equal(prodShortlistSkip("grep", { query: "render_widget" }, allConfigGrep), false);
  const allConfig = await maybeRerank("grep", { query: "render_widget" }, allConfigGrep, {
    env,
    systemOne: async (payload) => {
      called += 1;
      return stubAnswers(payload);
    },
  });
  assert.equal(called, 2);
  assert.equal(allConfig.jev.applied, true);
});

test("mixed-tier find 2-16 skips with tier_order; all-config find still reranks", async () => {
  let called = 0;
  const systemOne = async (payload) => {
    called += 1;
    return stubAnswers(payload);
  };
  const env = { CODEQ_JEV_KEY: "x" };

  assert.equal(prodShortlistSkip("find", { query: "ci" }, mixedConfigFindResult), false);
  assert.equal(tierOrderSkip("find", { query: "ci" }, mixedConfigFindResult), true);
  assert.equal(mixedGrepSkip("find", { query: "ci" }, mixedConfigFindResult), false);
  assert.equal(tierOrderSkip("find", { query: "async" }, mixedDistFindResult), true);
  assert.equal(mixedGrepSkip("find", { query: "async" }, mixedDistFindResult), false);
  assert.equal(tierOrderSkip("find", { query: "foo.py" }, prodFindResult), false);
  assert.equal(tierOrderSkip("find", { query: "ci" }, allConfigFindResult), false);
  assert.equal(tierOrderSkip("find", { query: "guide" }, allDocsFindResult), false);
  assert.equal(tierOrderSkip("grep", { query: "render_widget" }, mixedConfigGrepResult), false);

  const mixed = await maybeRerank("find", { query: "ci" }, mixedConfigFindResult, {
    env,
    systemOne,
  });
  assert.equal(called, 0);
  assert.deepEqual(mixed.jev, { applied: false, skipped: "tier_order" });
  assert.equal(mixed.preserveOrder, true);
  assert.deepEqual(mixed.results, mixedConfigFindResult.results);
  const formatted = formatMcpToolResult("find", mixed);
  assert.equal(
    /jev|noul|prod_shortlist|exact_neighborhood|tier_order|mixed_grep|skipped/i.test(formatted.text),
    false,
  );

  const dist = await maybeRerank("find", { query: "async" }, mixedDistFindResult, {
    env,
    systemOne,
  });
  assert.equal(called, 0);
  assert.deepEqual(dist.jev, { applied: false, skipped: "tier_order" });
  assert.deepEqual(dist.results, mixedDistFindResult.results);

  const allConfig = await maybeRerank("find", { query: "ci" }, allConfigFindResult, {
    env,
    systemOne,
  });
  assert.equal(called, 1);
  assert.equal(allConfig.jev.applied, true);
  assert.equal(allConfig.jev.skipped, undefined);
  assert.equal(allConfig.preserveOrder, true);

  const allDocs = await maybeRerank("find", { query: "guide" }, allDocsFindResult, {
    env,
    systemOne,
  });
  assert.equal(called, 2);
  assert.equal(allDocs.jev.applied, true);
});

test("graph exact neighborhood skips the optional rerank", async () => {
  let called = 0;
  const result = graphExactNeighborhood();
  const before = neighborhood(result);
  assert.ok(before.entries.length >= 1);
  const candidates = extractCandidates("graph", { query: result.query }, result);
  assert.ok(candidates.length >= 2 && candidates.length <= 16);
  assert.equal(prodShortlistSkip("graph", { query: result.query }, result), false);
  assert.equal(exactNeighborhoodSkip("graph", { query: result.query }, result), true);
  assert.equal(mixedGrepSkip("graph", { query: result.query }, result), false);
  const ranked = await maybeRerank("graph", { query: result.query }, result, {
    env: { CODEQ_JEV_KEY: "x" },
    systemOne: async (payload) => {
      called += 1;
      return stubAnswers(payload);
    },
  });
  assert.equal(called, 0);
  assert.deepEqual(ranked.jev, { applied: false, skipped: "exact_neighborhood" });
  assert.equal(ranked.preserveOrder, true);
  const after = neighborhood(ranked);
  assert.deepEqual(
    after.entries.map((entry) => `${entry.path}:${entry.startLine}`),
    before.entries.map((entry) => `${entry.path}:${entry.startLine}`),
  );
  assert.deepEqual(
    after.callees.map((item) => `${item.path}:${item.line}`),
    before.callees.map((item) => `${item.path}:${item.line}`),
  );
  assert.deepEqual(
    after.callers.map((item) => `${item.path}:${item.line}`),
    before.callers.map((item) => `${item.path}:${item.line}`),
  );
  const formatted = formatMcpToolResult("graph", ranked);
  assert.equal(
    /jev|noul|prod_shortlist|exact_neighborhood|tier_order|mixed_grep|skipped/i.test(formatted.text),
    false,
  );
  assert.match(formatted.text, /^callers$/m);
  assert.match(formatted.text, /^src\/pkg\/widget\.py:25-27 show$/m);
});

test("graph miss with empty entries is too_few, not exact_neighborhood", async () => {
  const result = {
    status: "ready",
    root: "/repo",
    query: "how does missing_widget work",
    result: "",
    symbols: [],
  };
  assert.equal(neighborhood(result).entries.length, 0);
  assert.equal(extractCandidates("graph", { query: result.query }, result).length, 0);
  assert.equal(exactNeighborhoodSkip("graph", { query: result.query }, result), false);
  let called = 0;
  const ranked = await maybeRerank("graph", { query: result.query }, result, {
    env: { CODEQ_JEV_KEY: "x" },
    systemOne: async () => {
      called += 1;
      throw new Error("should not call optional rerank");
    },
  });
  assert.equal(called, 0);
  assert.deepEqual(ranked.jev, { applied: false, skipped: "too_few" });
});

test("skipReason maps HTTP and timeouts", () => {
  assert.equal(skipReason({ status: 401 }), "http_4xx");
  assert.equal(skipReason({ status: 503 }), "http_5xx");
  assert.equal(skipReason({ message: "Request timed out" }), "timeout");
});

test("find pins exact path matches above Noul", async () => {
  const result = {
    status: "ready",
    query: "foo.py",
    results: [
      { path: "src/pkg/foo_test.py", matchType: "prefix" },
      { path: "src/pkg/foo.py", matchType: "exact" },
      { path: "src/pkg/other.py", matchType: "fuzzy" },
    ],
  };
  const ranked = await rerank("find", { query: "foo.py" }, result, {
    systemOne: async (payload) => {
      assert.equal(payload.state.hits["src/pkg/foo.py"].matchType, "exact");
      const answers = {};
      for (const key of Object.keys(payload.questions)) {
        answers[key] = {
          type: "noul",
          noul: payload.state.hits[Object.keys(payload.state.hits)[Number(key.slice(1))]]
            ?.path === "src/pkg/other.py"
            ? 0.99
            : 0.1,
        };
      }
      return { answers };
    },
  });
  assert.equal(ranked.results[0].path, "src/pkg/foo.py");
  assert.equal(ranked.results[0].matchType, "exact");
  assert.equal(ranked.preserveOrder, true);
  assert.deepEqual(
    ranked.results.map((item) => item.path),
    ["src/pkg/foo.py", "src/pkg/other.py", "src/pkg/foo_test.py"],
  );
});

test("find pins only production exact matches", () => {
  const candidates = extractCandidates(
    "find",
    { query: "git" },
    {
      results: [
        { path: ".gitignore", matchType: "exact" },
        { path: "src/foo.py", matchType: "exact" },
        { path: "src/other.py", matchType: "fuzzy" },
      ],
    },
  );
  const byPath = Object.fromEntries(
    candidates.map((item) => [item.record.path, item]),
  );
  assert.equal(byPath[".gitignore"].pinned, false);
  assert.equal(byPath["src/foo.py"].pinned, true);
  assert.equal(byPath["src/other.py"].pinned, false);

  const live = extractCandidates(
    "find",
    { query: "foo.py" },
    {
      results: [
        { path: ".gitignore", matchType: "exact_filename" },
        { path: "src/foo.py", matchType: "exact_filename" },
        { path: "src/b.py", matchType: "exact_filename" },
        { path: "src/other.py", matchType: "fuzzy_path" },
        { path: "src/name.py", matchType: "fuzzy_filename" },
        { path: "src/dir.py", matchType: "exact_path" },
      ],
    },
  );
  const liveByPath = Object.fromEntries(
    live.map((item) => [item.record.path, item]),
  );
  assert.equal(liveByPath[".gitignore"].pinned, false);
  assert.equal(liveByPath["src/foo.py"].pinned, true);
  assert.equal(liveByPath["src/b.py"].pinned, true);
  assert.equal(liveByPath["src/other.py"].pinned, false);
  assert.equal(liveByPath["src/name.py"].pinned, false);
  assert.equal(liveByPath["src/dir.py"].pinned, false);
});

test("literal grep still calls Jev but does not undo pathTier across buckets", async () => {
  const result = {
    status: "ready",
    root: "/repo",
    pattern: "render_widget",
    mode: "plain",
    results: [
      {
        path: "src/pkg/foo.py",
        line: 14,
        column: 1,
        text: "def render_widget():",
      },
      {
        path: "src/pkg/bar.py",
        line: 2,
        column: 1,
        text: "render_widget()",
      },
      {
        path: "dist/async.js",
        line: 4,
        column: 1,
        text: "render_widget",
      },
    ],
  };
  let called = 0;
  const ranked = await maybeRerank("grep", { query: "render_widget" }, result, {
    env: { CODEQ_JEV_KEY: "x" },
    systemOne: async (payload) => {
      called += 1;
      const answers = {};
      for (const key of Object.keys(payload.questions)) {
        const index = Number(key.slice(1));
        const anchors = Object.keys(payload.state.hits);
        const anchor = anchors[index] || "";
        answers[key] = {
          type: "noul",
          noul: anchor.includes("dist/")
            ? 0.99
            : anchor.includes("bar.py")
              ? 0.8
              : 0.1,
        };
      }
      return { answers };
    },
  });
  assert.equal(called, 1);
  assert.equal(ranked.jev.applied, true);
  assert.equal(ranked.preserveOrder, true);
  const paths = ranked.results.map((hit) => hit.path);
  const tiers = paths.map((filePath) => pathTier(filePath));
  for (let index = 1; index < tiers.length; index += 1) {
    assert.ok(tiers[index] >= tiers[index - 1], paths.join(" "));
  }
  assert.deepEqual(paths, [
    "src/pkg/bar.py",
    "src/pkg/foo.py",
    "dist/async.js",
  ]);
});

test("grep preserveOrder keeps Jev sequence on the map", () => {
  const formatted = formatMcpToolResult("grep", {
    status: "ready",
    root: "/repo",
    pattern: "render_widget",
    mode: "plain",
    preserveOrder: true,
    results: [
      {
        path: "src/pkg/foo.py",
        line: 14,
        column: 1,
        text: "def render_widget(name, color, width=12):",
      },
      {
        path: "src/pkg/foo_test.py",
        line: 8,
        column: 1,
        text: "def test_render_widget_includes_name():",
      },
    ],
  });
  const defAt = formatted.text.indexOf("src/pkg/foo.py:14");
  const testAt = formatted.text.indexOf("src/pkg/foo_test.py:8");
  assert.ok(defAt > 0 && testAt > defAt, formatted.text);
  assert.equal(formatted.text.includes("Jev"), false);
  assert.equal(formatted.text.includes("noul"), false);
});

test("graph candidates are entry spans and callees, not files", () => {
  const dump = [
    "Found 2 symbols across 2 files.",
    "",
    "- `render_widget` (src/pkg/foo.py:14) — 1 caller",
    "",
    "**`src/pkg/foo.py`** — render_widget(function)",
    "",
    "```python",
    "14\tdef render_widget():",
    "```",
  ].join("\n");
  const result = {
    status: "ready",
    root: "/repo",
    query: "how does render_widget work",
    result: dump,
    symbols: [
      {
        name: "render_widget",
        kind: "function",
        path: "src/pkg/foo.py",
        startLine: 14,
        endLine: 22,
        callees: [{ name: "layout", path: "src/pkg/layout.py", line: 1, endLine: 2 }],
      },
    ],
  };
  const candidates = extractCandidates("graph", { query: result.query }, result);
  assert.deepEqual(
    candidates.map((item) => item.kind),
    ["entry", "callee"],
  );
  assert.equal(candidates[0].pinned, true);
  assert.equal(candidates[0].anchor, "src/pkg/foo.py:14");
  assert.equal(candidates[1].anchor, "src/pkg/layout.py:1");
});

test("graph candidates include callers after callees", () => {
  const dump = [
    "Found 1 symbols across 1 files.",
    "",
    "- `render_widget` (src/pkg/foo.py:14) — 1 caller",
    "",
    "**`src/pkg/foo.py`** — render_widget(function)",
  ].join("\n");
  const result = {
    status: "ready",
    root: "/repo",
    query: "how does render_widget work",
    result: dump,
    symbols: [
      {
        name: "render_widget",
        kind: "function",
        path: "src/pkg/foo.py",
        startLine: 14,
        endLine: 22,
        callees: [{ name: "layout", path: "src/pkg/layout.py", line: 1, endLine: 2 }],
        callers: [{ name: "show", path: "src/pkg/widget.py", line: 25, endLine: 27 }],
      },
    ],
  };
  const candidates = extractCandidates("graph", { query: result.query }, result);
  assert.deepEqual(
    candidates.map((item) => item.kind),
    ["entry", "callee", "caller"],
  );
  assert.equal(candidates[2].anchor, "src/pkg/widget.py:25");
  assert.equal(candidates.length <= 16, true);
});
