import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { daemonPaths } from "../src/paths.js";
import { freshnessLine, formatMcpToolResult } from "../src/mcp-format.js";

const execFileAsync = promisify(execFile);
const bin = fileURLToPath(new URL("../bin/codeq.js", import.meta.url));

function repository(parent, name) {
  const root = join(parent, name);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "session.ts"),
    "export function createSession() { return { id: 1 }; }\n",
  );
  writeFileSync(
    join(root, "src", "drifting.ts"),
    [
      "// line 1",
      "// line 2",
      "export function driftTarget() { return 'before'; }",
      "// line 4",
      "// line 5",
    ].join("\n") + "\n",
  );
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=codeq-test",
      "-c",
      "user.email=codeq@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: root },
  );
  return root;
}

function run(repo, env, args) {
  return execFileAsync(process.execPath, [bin, ...args], {
    cwd: repo,
    env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

function daemonPid(paths) {
  return Number(readFileSync(paths.pid, "utf8").trim());
}

function killPidFile(paths) {
  try {
    process.kill(daemonPid(paths), "SIGTERM");
  } catch {}
}

async function waitFor(check, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) {
      assert.fail(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test(
  "a file changed after the index is flagged stale in the query result",
  { timeout: 240_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-freshness-"));
    const dataDir = join(parent, "data");
    const repo = repository(parent, "app");
    const env = { ...process.env, CODEQ_DATA_DIR: dataDir };
    const paths = daemonPaths(dataDir);
    t.after(() => killPidFile(paths));

    // State 1: clean index — a query before any edit must not flag staleness.
    const warm = await run(repo, env, ["--json", "graph", "driftTarget"]);
    const clean = JSON.parse(warm.stdout);
    assert.equal(clean.status, "ready", JSON.stringify(clean).slice(0, 400));
    assert.ok(!clean.stalePaths || clean.stalePaths.length === 0);
    const cleanGrep = JSON.parse(
      (await run(repo, env, ["--json", "grep", "driftTarget", "--regex"]))
        .stdout,
    );
    assert.equal(cleanGrep.status, "ready");
    assert.equal(cleanGrep.results.length, 1);
    assert.equal(cleanGrep.results[0].stale ?? false, false);

    // State 2: file edited after indexing — the very next query must mark the
    // file, not serve the old line numbers as current. The graph watcher takes
    // ~2s to debounce+sync, so this races it on purpose.
    writeFileSync(
      join(repo, "src", "drifting.ts"),
      [
        "// line 1",
        "// line 2",
        "// inserted 3",
        "// inserted 4",
        "// inserted 5",
        "// inserted 6",
        "// inserted 7",
        "export function driftTarget() { return 'after'; }",
      ].join("\n") + "\n",
    );
    const mid = JSON.parse(
      (await run(repo, env, ["--json", "grep", "driftTarget", "--regex"]))
        .stdout,
    );
    const midHit = mid.results.find((hit) => hit.path === "src/drifting.ts");
    assert.ok(midHit, JSON.stringify(mid).slice(0, 400));
    // The poll runs before the query, so the drift is always known: either the
    // daemon marks the file stale (watcher's ~2s debounce hasn't synced yet)
    // or the sync already landed. Both keep the marker honest; what must never
    // happen is an unflagged stale locator.
    if (midHit.stale) {
      assert.ok(
        (mid.stalePaths || []).includes("src/drifting.ts"),
        JSON.stringify(mid).slice(0, 400),
      );
    } else {
      assert.equal(midHit.line, 8, "synced index should point at line 8");
    }

    // The same drift must mark a graph locator pointing into the edited file.
    const midGraph = JSON.parse(
      (await run(repo, env, ["--json", "graph", "driftTarget"])).stdout,
    );
    const entry = (midGraph.symbols || []).find(
      (item) => item.path === "src/drifting.ts",
    );
    if ((midGraph.stalePaths || []).includes("src/drifting.ts")) {
      assert.ok(entry, JSON.stringify(midGraph).slice(0, 400));
      const formatted = formatMcpToolResult("graph", {
        ...midGraph,
        result: "",
      });
      assert.match(formatted.text, /changed after the index/);
    }

    // State 3: after the graph sync completes, nothing may be flagged stale
    // and the locator points at the new line.
    const settled = await waitFor(async () => {
      const reply = await run(repo, env, [
        "--json",
        "grep",
        "driftTarget",
        "--regex",
      ]);
      const payload = JSON.parse(reply.stdout);
      const hit = payload.results.find(
        (item) => item.path === "src/drifting.ts",
      );
      if (!hit || hit.stale) return null;
      return { payload, hit };
    }, "the post-sync query to report the new line unmarked", 30_000);
    assert.equal(settled.hit.line, 8);
    const stillStale = (settled.payload.stalePaths || []).filter(
      (path) => path === "src/drifting.ts",
    );
    assert.deepEqual(stillStale, []);
  },
);

test(
  "freshnessLine and grep text mark a stale file so an agent can tell",
  () => {
    const result = {
      status: "ready",
      root: "/repo",
      rootSource: "cwd",
      stalePaths: ["src/drifting.ts"],
      pattern: "driftTarget",
      mode: "plain",
      regex: true,
      results: [
        {
          path: "src/drifting.ts",
          line: 3,
          column: 18,
          text: "export function driftTarget() { return 'before'; }",
          contextBefore: [],
          contextAfter: [],
        },
      ],
      shown: 1,
      context: 0,
      pageCap: 48,
    };
    const line = freshnessLine(result);
    assert.match(line, /\[ready\]/);
    assert.match(line, /stale 1 file/);
    const formatted = formatMcpToolResult("grep", result);
    assert.match(formatted.text, /file changed after index/);
    assert.match(formatted.text, /line numbers there may have drifted/);
    assert.equal(formatted.structuredContent.stalePaths[0], "src/drifting.ts");
    assert.equal(formatted.structuredContent.hits[0].stale, true);
  },
);
