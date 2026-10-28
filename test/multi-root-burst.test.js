import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { daemonPaths } from "../src/paths.js";
import { formatMcpToolResult } from "../src/mcp-format.js";

const execFileAsync = promisify(execFile);
const bin = fileURLToPath(new URL("../bin/codeq.js", import.meta.url));

function repository(parent, name) {
  const root = join(parent, name);
  mkdirSync(join(root, "src"), { recursive: true });
  for (let index = 0; index < 12; index += 1) {
    writeFileSync(
      join(root, "src", `mod${index}.ts`),
      `export function fn_${name}_${index}() { return ${index}; }\n`,
    );
  }
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

function find(dataDir, root, query) {
  return execFileAsync(
    process.execPath,
    [bin, "--json", "--root", root, "find", query],
    {
      env: { ...process.env, CODEQ_DATA_DIR: dataDir },
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    },
  ).then(({ stdout }) => JSON.parse(stdout));
}

function killPidFile(paths) {
  try {
    process.kill(
      Number(readFileSync(paths.pid, "utf8").trim()),
      "SIGTERM",
    );
  } catch {}
}

// More simultaneous cold roots than the daemon's live pool: every caller used
// to either watch the daemon die (a .finally floating rejection crashed the
// process once an evicted root's init promise rejected) or get "FileFinder
// instance has been destroyed" when its root was evicted mid-scan. One call
// still serves exactly one root — the extras now wait and answer provisional
// replies instead of crashing.
test(
  "a burst of cold roots over the pool limit answers every query and flags the contention",
  { timeout: 300_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-multi-root-"));
    const dataDir = join(parent, "data");
    const roots = ["rootA", "rootB", "rootC", "rootD", "rootE"].map((name) =>
      repository(parent, name),
    );
    const paths = daemonPaths(dataDir);
    t.after(() => killPidFile(paths));

    const replies = await Promise.all(
      roots.map((root) => find(dataDir, root, "mod0.ts")),
    );

    for (const [index, reply] of replies.entries()) {
      assert.equal(
        reply.root,
        roots[index],
        `reply ${index} resolved a different root: ${reply.root}`,
      );
      // The index may still be building; what matters is the caller can tell
      // provisional from settled, not a bare empty answer.
      assert.ok(
        reply.status === "indexing" ||
          reply.status === "ready" ||
          reply.status === "degraded",
        `unexpected status ${reply.status}`,
      );
      const formatted = formatMcpToolResult("find", reply);
      assert.equal(
        typeof formatted.structuredContent.indexReady,
        "boolean",
      );
    }
    // The pool was saturated, so every reply carries the contention signal.
    assert.ok(
      replies.some((reply) => reply.poolBusy === true),
      `no reply flagged poolBusy: ${JSON.stringify(
        replies.map((reply) => reply.poolBusy),
      )}`,
    );
    const busy = formatMcpToolResult(
      "find",
      replies.find((reply) => reply.poolBusy === true),
    );
    assert.match(busy.firstLine, /pool busy/);
    assert.equal(busy.structuredContent.poolBusy, true);

    // The daemon survived the burst: a warm root answers ready, not a restart.
    const settled = await waitForReady(dataDir, roots[0]);
    assert.equal(settled.status, "ready", JSON.stringify(settled).slice(0, 400));
    assert.equal(settled.poolBusy === true, false);
    assert.ok(
      settled.results.some((item) => item.path === "src/mod0.ts"),
      JSON.stringify(settled).slice(0, 400),
    );
  },
);

async function waitForReady(dataDir, root, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reply = await find(dataDir, root, "mod0.ts");
    if (reply.status === "ready") return reply;
    if (Date.now() >= deadline) {
      assert.fail(`timed out waiting for ${root} to report ready`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
