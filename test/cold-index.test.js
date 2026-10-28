import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { daemonPaths } from "../src/paths.js";
import {
  formatMcpToolResult,
  INDEX_NOT_READY_NOTE,
} from "../src/mcp-format.js";

const execFileAsync = promisify(execFile);
const bin = fileURLToPath(new URL("../bin/codeq.js", import.meta.url));

function repository(parent, name) {
  const root = join(parent, name);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "session.ts"),
    "export function createSession() { return { id: 1 }; }\n",
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

async function waitFor(check, label, timeoutMs = 30_000) {
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
  "a query served while the index builds is marked provisional, then settles",
  { timeout: 180_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-cold-index-"));
    const dataDir = join(parent, "data");
    const repo = repository(parent, "app");
    const env = { ...process.env, CODEQ_DATA_DIR: dataDir };
    const paths = daemonPaths(dataDir);
    t.after(() => killPidFile(paths));

    // State 1: first contact on a fresh root — the graph index is still
    // building, so the reply must carry a provisional marker a caller can
    // tell apart from a settled "no hits".
    const cold = JSON.parse(
      (await run(repo, env, ["--json", "find", "session.ts"])).stdout,
    );
    assert.equal(cold.status, "indexing", JSON.stringify(cold).slice(0, 400));
    const coldText = formatColdText("find", cold);
    assert.match(coldText, new RegExp(INDEX_NOT_READY_NOTE));
    assert.equal(coldStructured(cold).indexReady, false);

    // State 2: once the index reports ready, the same query drops the marker.
    const settled = await waitFor(async () => {
      const reply = await run(repo, env, ["--json", "find", "session.ts"]);
      const payload = JSON.parse(reply.stdout);
      return payload.status === "ready" ? payload : null;
    }, "the index to report ready");
    const settledText = formatColdText("find", settled);
    assert.equal(settledText.includes(INDEX_NOT_READY_NOTE), false);
    assert.equal(coldStructured(settled).indexReady, true);
    assert.ok(
      settled.results.some((item) => item.path === "src/session.ts"),
      JSON.stringify(settled).slice(0, 400),
    );
  },
);

test(
  "a cold-index grep that finds nothing still flags the empty page as provisional",
  { timeout: 180_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-cold-grep-"));
    const dataDir = join(parent, "data");
    const repo = repository(parent, "app");
    const env = { ...process.env, CODEQ_DATA_DIR: dataDir };
    const paths = daemonPaths(dataDir);
    t.after(() => killPidFile(paths));

    const cold = JSON.parse(
      (
        await run(repo, env, ["--json", "grep", "absent_token", "--regex"])
      ).stdout,
    );
    assert.equal(cold.status, "indexing", JSON.stringify(cold).slice(0, 400));
    const coldText = formatColdText("grep", cold);
    assert.match(coldText, /0 matches/);
    assert.match(coldText, new RegExp(INDEX_NOT_READY_NOTE));
    assert.equal(coldStructured(cold).indexReady, false);

    const settled = await waitFor(async () => {
      const reply = await run(repo, env, [
        "--json",
        "grep",
        "absent_token",
        "--regex",
      ]);
      const payload = JSON.parse(reply.stdout);
      return payload.status === "ready" ? payload : null;
    }, "the index to report ready");
    const settledText = formatColdText("grep", settled);
    assert.match(settledText, /0 matches/);
    assert.equal(settledText.includes(INDEX_NOT_READY_NOTE), false);
    assert.equal(coldStructured(settled).indexReady, true);
  },
);

test(
  "graph --no-wait answers provisionally while the default call blocks for the build",
  { timeout: 300_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-cold-graph-"));
    const dataDir = join(parent, "data");
    // Enough files that a blocking cold graph call measurably outlasts a
    // non-blocking one: the assertion is "provisional before the build could
    // finish", not a wall-clock guess on an empty repo.
    const repo = repository(parent, "app");
    for (let i = 0; i < 200; i += 1) {
      mkdirSync(join(repo, "src", `pkg${i % 20}`), { recursive: true });
      writeFileSync(
        join(repo, "src", `pkg${i % 20}`, `mod${i}.js`),
        `export function modFn${i}(x){ return { id: ${i}, x }; }\n`,
      );
    }
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=codeq-test",
        "-c",
        "user.email=codeq@example.invalid",
        "commit",
        "-qm",
        "more",
      ],
      { cwd: repo },
    );
    const env = { ...process.env, CODEQ_DATA_DIR: dataDir };
    const paths = daemonPaths(dataDir);
    t.after(() => killPidFile(paths));

    // Opt-in non-blocking: returns before the index could possibly be ready
    // on a fresh repo, flagged indexing/indexReady false like a cold find.
    const started = Date.now();
    const provisional = JSON.parse(
      (await run(repo, env, ["--json", "graph", "createSession", "--no-wait"]))
        .stdout,
    );
    const provisionalMs = Date.now() - started;
    assert.equal(
      provisional.status,
      "indexing",
      JSON.stringify(provisional).slice(0, 400),
    );
    assert.equal(coldStructured(provisional).indexReady, false);
    assert.match(
      formatColdText("graph", provisional),
      new RegExp(INDEX_NOT_READY_NOTE),
    );
    assert.ok(
      provisionalMs < 15_000,
      `--no-wait took ${provisionalMs}ms — it must not wait for the index`,
    );

    // The kicked-off build completes; the default call waits for it and
    // returns a settled answer.
    const settled = await waitFor(async () => {
      const reply = await run(repo, env, ["--json", "graph", "createSession"]);
      const payload = JSON.parse(reply.stdout);
      return payload.status === "ready" ? payload : null;
    }, "the index to report ready", 120_000);
    assert.equal(coldStructured(settled).indexReady, true);
    const settledText = formatColdText("graph", settled);
    assert.equal(settledText.includes(INDEX_NOT_READY_NOTE), false);
  },
);

test(
  "graph without --no-wait keeps blocking semantics on a cold repo",
  { timeout: 300_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-cold-graph-block-"));
    const dataDir = join(parent, "data");
    const repo = repository(parent, "app");
    const env = { ...process.env, CODEQ_DATA_DIR: dataDir };
    const paths = daemonPaths(dataDir);
    t.after(() => killPidFile(paths));

    // Default behavior is unchanged: one cold graph call both builds the
    // index and answers — it returns ready, never a provisional indexing page.
    const cold = JSON.parse(
      (await run(repo, env, ["--json", "graph", "createSession"])).stdout,
    );
    assert.equal(cold.status, "ready", JSON.stringify(cold).slice(0, 400));
    assert.equal(coldStructured(cold).indexReady, true);
  },
);

test("graph --no-wait is not valid for find or grep", async () => {
  const parent = mkdtempSync(join(tmpdir(), "codeq-no-wait-flag-"));
  const dataDir = join(parent, "data");
  const repo = repository(parent, "app");
  const env = { ...process.env, CODEQ_DATA_DIR: dataDir };
  await assert.rejects(
    run(repo, env, ["find", "x", "--no-wait"]),
    /--no-wait is not valid for find/,
  );
  await assert.rejects(
    run(repo, env, ["grep", "x", "--regex", "--no-wait"]),
    /--no-wait is not valid for grep/,
  );
});

function formatColdText(command, result) {
  return formatMcpToolResult(command, result).text;
}

function coldStructured(result) {
  return formatMcpToolResult(result.command ?? "find", result)
    .structuredContent;
}
