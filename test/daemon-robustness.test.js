import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { daemonPaths } from "../src/paths.js";

const execFileAsync = promisify(execFile);
const bin = fileURLToPath(new URL("../bin/codeq.js", import.meta.url));
const { version } = createRequire(import.meta.url)("../package.json");

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

// Graph indexing has to outlive the stop signal by a wide margin or the query
// completes before the wedge exists.
function bigRepository(parent, name) {
  const root = repository(parent, name);
  for (let index = 0; index < 120; index += 1) {
    writeFileSync(
      join(root, "src", `mod${index}.ts`),
      `export function mod${index}Value() { return ${index}; }\n`,
    );
  }
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
      "more",
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

function processGone(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2)[0];
    return state === "Z" || state === "X";
  } catch {
    return true;
  }
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

function childPids(pid, match) {
  try {
    const out = execFileSync("pgrep", ["-P", String(pid), "-f", match], {
      encoding: "utf8",
    });
    return out
      .trim()
      .split("\n")
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 1);
  } catch {
    return [];
  }
}

test(
  "a hung daemon is detected and restarted",
  { timeout: 120_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-hung-daemon-"));
    const dataDir = join(parent, "data");
    const repo = repository(parent, "app");
    const env = { ...process.env, CODEQ_DATA_DIR: dataDir };
    const paths = daemonPaths(dataDir);
    t.after(() => killPidFile(paths));

    await run(repo, env, ["--json", "find", "session.ts"]);
    const first = daemonPid(paths);
    // SIGSTOP freezes the event loop but the kernel keeps accepting on the
    // socket, which is exactly how a wedged daemon looks from outside.
    process.kill(first, "SIGSTOP");
    t.after(() => {
      try {
        process.kill(first, "SIGKILL");
      } catch {}
    });

    const reply = await run(repo, env, ["--json", "find", "session.ts"]);
    assert.equal(JSON.parse(reply.stdout).command, "find");
    const second = daemonPid(paths);
    assert.notEqual(second, first);
    await waitFor(
      () => processGone(first),
      "stopped daemon to be cleaned up",
    );
  },
);

test(
  "a daemon whose socket vanished is stopped instead of left orphaned",
  { timeout: 120_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-partial-daemon-"));
    const dataDir = join(parent, "data");
    const repo = repository(parent, "app");
    const env = { ...process.env, CODEQ_DATA_DIR: dataDir };
    const paths = daemonPaths(dataDir);
    t.after(() => killPidFile(paths));

    await run(repo, env, ["--json", "find", "session.ts"]);
    const first = daemonPid(paths);
    t.after(() => {
      try {
        process.kill(first, "SIGKILL");
      } catch {}
    });
    rmSync(paths.socket, { force: true });

    const reply = await run(repo, env, ["--json", "find", "session.ts"]);
    assert.equal(JSON.parse(reply.stdout).command, "find");
    assert.notEqual(daemonPid(paths), first);
    await waitFor(() => processGone(first), "orphaned daemon to exit");
  },
);

test(
  "a daemon that cannot answer ping is replaced",
  { timeout: 120_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-stale-daemon-"));
    const dataDir = join(parent, "data");
    const repo = repository(parent, "app");
    const env = { ...process.env, CODEQ_DATA_DIR: dataDir };
    const paths = daemonPaths(dataDir);
    mkdirSync(paths.daemonDir, { recursive: true });
    t.after(() => killPidFile(paths));

    // Stand in for a daemon from a deleted or downgraded install: it still
    // owns the socket and its files claim this version, but the process only
    // ever answers errors — an old build treats ping as an unknown command.
    const imposter = fileURLToPath(
      new URL("./fixtures/imposter.js", import.meta.url),
    );
    const fake = spawn(process.execPath, [imposter, paths.socket], {
      detached: true,
      stdio: "ignore",
    });
    fake.unref();
    t.after(() => {
      try {
        process.kill(fake.pid, "SIGKILL");
      } catch {}
    });
    await waitFor(async () => {
      const { connect } = await import("node:net");
      return new Promise((resolve) => {
        const socket = connect(paths.socket);
        socket.once("connect", () => {
          socket.end();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
      });
    }, "imposter to listen");
    writeFileSync(paths.pid, `${fake.pid}\n`);
    writeFileSync(paths.packageVersion, `${version}\n`);

    const reply = await run(repo, env, ["--json", "find", "session.ts"]);
    const payload = JSON.parse(reply.stdout);
    assert.equal(payload.command, "find");
    assert.equal(payload.root, realpathSync(repo));
    assert.notEqual(daemonPid(paths), fake.pid);
    await waitFor(() => processGone(fake.pid), "imposter to be stopped");
  },
);

test(
  "an FFF watcher failure warns and falls back to rescans",
  { timeout: 120_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-fff-watch-"));
    const dataDir = join(parent, "data");
    const repo = repository(parent, "app");
    const env = {
      ...process.env,
      CODEQ_DATA_DIR: dataDir,
      CODEQ_FFF_DISABLE_WATCH: "1",
    };
    const paths = daemonPaths(dataDir);
    t.after(() => killPidFile(paths));

    const first = await run(repo, env, ["--json", "find", "session.ts"]);
    const before = JSON.parse(first.stdout);
    assert.equal(before.status, "degraded");
    assert.match(before.fffWarning || "", /FFF watcher failed/);

    // The watcher never reports the write; only the rescan fallback can see it.
    writeFileSync(
      join(repo, "src", "late.ts"),
      "export function lateAddition() { return 2; }\n",
    );
    const found = await waitFor(async () => {
      const reply = await run(repo, env, ["--json", "find", "late.ts"]);
      const payload = JSON.parse(reply.stdout);
      return payload.results.some((item) => item.path === "src/late.ts")
        ? payload
        : null;
    }, "rescan fallback to index the new file");
    assert.equal(found.fffWarning && /FFF/.test(found.fffWarning), true);
  },
);

test(
  "a graph worker exit warns once and the next graph restarts it",
  { timeout: 180_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-worker-exit-"));
    const dataDir = join(parent, "data");
    const repo = repository(parent, "app");
    const env = {
      ...process.env,
      CODEQ_DATA_DIR: dataDir,
      // Keep an FFF warning up the whole time: the two warnings must coexist.
      CODEQ_FFF_DISABLE_WATCH: "1",
    };
    const paths = daemonPaths(dataDir);
    t.after(() => killPidFile(paths));

    await run(repo, env, ["--json", "graph", "createSession"]);
    const pid = daemonPid(paths);
    const [worker] = await waitFor(
      () => {
        const workers = childPids(pid, "graph-worker.js");
        return workers.length > 0 ? workers : null;
      },
      "graph worker to spawn",
    );
    process.kill(worker, "SIGKILL");

    const degraded = await waitFor(async () => {
      const reply = await run(repo, env, ["--json", "find", "session.ts"]);
      const payload = JSON.parse(reply.stdout);
      return payload.graphWarning ? payload : null;
    }, "worker exit to surface as a graph warning");
    assert.equal(degraded.status, "degraded");
    assert.match(degraded.graphWarning, /CodeGraph worker exited/);
    assert.match(degraded.fffWarning || "", /FFF watcher failed/);

    const reply = await run(repo, env, ["--json", "graph", "createSession"]);
    const recovered = JSON.parse(reply.stdout);
    assert.equal(recovered.command, "graph");
    assert.ok(
      recovered.symbols.length > 0,
      JSON.stringify(recovered).slice(0, 400),
    );
    // The restart cleared only the graph warning; the FFF one is still true.
    assert.equal(recovered.graphWarning, null);
    assert.match(recovered.fffWarning || "", /FFF watcher failed/);
  },
);

test(
  "a wedged daemon fails an in-flight query instead of hanging",
  { timeout: 180_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-stall-"));
    const dataDir = join(parent, "data");
    const repo = bigRepository(parent, "app");
    const env = { ...process.env, CODEQ_DATA_DIR: dataDir };
    const paths = daemonPaths(dataDir);
    t.after(() => killPidFile(paths));

    // The graph call is the first contact, so its worker only exists while
    // this request is in flight; freezing the daemon once the worker is up
    // can no longer be masked by an earlier call's warm-up indexing.
    const pending = run(repo, env, ["--json", "graph", "createSession"]);
    const pid = await waitFor(
      () => (existsSync(paths.pid) ? daemonPid(paths) : null),
      "daemon pid file",
    );
    t.after(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    });
    await waitFor(
      () => {
        const workers = childPids(pid, "graph-worker.js");
        return workers.length > 0 ? workers : null;
      },
      "graph worker to spawn",
    );
    process.kill(pid, "SIGSTOP");
    await assert.rejects(pending, (error) =>
      /stopped responding/.test(`${error.message}\n${error.stderr}`),
    );

    const reply = await run(repo, env, ["--json", "find", "session.ts"]);
    assert.equal(JSON.parse(reply.stdout).command, "find");
    assert.notEqual(daemonPid(paths), pid);
  },
);
