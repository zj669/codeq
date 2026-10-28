import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { daemonPaths } from "../src/paths.js";

const bin = fileURLToPath(new URL("../bin/codeq.js", import.meta.url));
const { version } = createRequire(import.meta.url)("../package.json");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(parent, name) {
  const root = join(parent, name);
  mkdirSync(join(root, "src", "pkg"), { recursive: true });
  writeFileSync(join(root, "src", "pkg", "foo.py"), "TREE = \"main\"\n");
  git(root, "init", "-b", "main");
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=codeq-test",
    "-c",
    "user.email=codeq@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  return realpathSync(root);
}

function linkedWorktrees(parent) {
  const main = repository(parent, "repo");
  const wtA = join(parent, "wt-a");
  const wtB = join(parent, "wt-b");
  git(main, "worktree", "add", "-b", "tree-a", wtA, "main");
  git(main, "worktree", "add", "-b", "tree-b", wtB, "main");
  writeFileSync(join(wtA, "src", "pkg", "foo.py"), "TREE = \"a\"\nMARKER_A = 1\n");
  writeFileSync(join(wtB, "src", "pkg", "foo.py"), "TREE = \"b\"\nMARKER_B = 1\n");
  return { wtA: realpathSync(wtA), wtB: realpathSync(wtB) };
}

function stopDaemon(dataDir) {
  const pidFile = join(dataDir, "daemon", "daemon.pid");
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (Number.isInteger(pid) && pid > 1) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

function socketConnectable(path) {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitFor(check, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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

function cliJson(args, { cwd, env, timeout = 60_000 }) {
  try {
    const stdout = execFileSync(process.execPath, [bin, "--json", ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, stdout, payload: JSON.parse(stdout) };
  } catch (error) {
    return {
      ok: false,
      status: error.status,
      stdout: error.stdout?.toString() || "",
      stderr: error.stderr?.toString() || "",
    };
  }
}

test(
  "live query: cwd worktree A, root worktree B, path src/pkg searches B",
  { timeout: 120_000 },
  (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-live-wt-"));
    const dataDir = join(parent, "data");
    const env = { ...process.env, CODEQ_DATA_DIR: dataDir };
    delete env.CODEQ_CWD;
    t.after(() => stopDaemon(dataDir));
    const { wtA, wtB } = linkedWorktrees(parent);

    const hit = cliJson(
      ["--root", wtB, "grep", "MARKER_B", "--path", "src/pkg"],
      { cwd: wtA, env },
    );
    assert.equal(hit.ok, true, hit.stderr || hit.stdout);
    assert.equal(hit.payload.root, wtB);
    assert.equal(hit.payload.rootSource, "root");
    assert.ok(
      hit.payload.results.some((item) => item.path === "src/pkg/foo.py"),
      JSON.stringify(hit.payload.results),
    );
    assert.equal(
      hit.payload.results.some((item) => item.text?.includes("MARKER_A")),
      false,
    );

    const missA = cliJson(
      ["--root", wtB, "grep", "MARKER_A", "--path", "src/pkg"],
      { cwd: wtA, env },
    );
    assert.equal(missA.ok, true, missA.stderr || missA.stdout);
    assert.equal(missA.payload.root, wtB);
    assert.equal(missA.payload.shown, 0);

    const missing = cliJson(
      ["--root", wtB, "find", "foo.py", "--path", "src/pkg/nope.py"],
      { cwd: wtA, env },
    );
    assert.equal(missing.ok, false);
    const message = `${missing.stderr}\n${missing.stdout}`;
    assert.match(message, /path not found: src\/pkg\/nope\.py/);
    assert.ok(message.includes(join(wtB, "src", "pkg", "nope.py")), message);
    assert.equal(message.includes(join(wtA, "src", "pkg", "nope.py")), false, message);
    assert.equal(message.includes("--root"), false, message);
    assert.equal(message.includes("whole"), false, message);

    const file = join(wtB, "src", "pkg", "foo.py");
    const fileRoot = cliJson(["--root", file, "grep", "MARKER_B"], {
      cwd: wtA,
      env,
    });
    assert.equal(fileRoot.ok, true, fileRoot.stderr || fileRoot.stdout);
    assert.equal(fileRoot.payload.root, wtB);
    assert.match(fileRoot.payload.rootNote, /root named a file/);
    assert.equal(
      [...new Set(fileRoot.payload.results.map((item) => item.path))].join(),
      "src/pkg/foo.py",
    );
    assert.equal(
      `${fileRoot.stdout}${fileRoot.payload.rootNote}`.includes("--root"),
      false,
    );

    const buckets = readdirSync(join(dataDir, "roots"));
    assert.equal(buckets.length, 1, "path must not create a second index");
    const meta = JSON.parse(
      readFileSync(join(dataDir, "roots", buckets[0], "root.json"), "utf8"),
    );
    assert.equal(meta.root, wtB);
  },
);

test(
  "a daemon from an older package is replaced on the next query",
  { timeout: 120_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-daemon-ver-"));
    const dataDir = join(parent, "data");
    const env = { ...process.env, CODEQ_DATA_DIR: dataDir };
    delete env.CODEQ_CWD;
    t.after(() => stopDaemon(dataDir));
    const repo = repository(parent, "app");
    const paths = daemonPaths(dataDir);
    mkdirSync(paths.daemonDir, { recursive: true });

    // A daemon from an older package is a different process on the same
    // socket: it answers ping the way an old build answers any unknown
    // command — an error, never a pong.
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
    await waitFor(
      () => socketConnectable(paths.socket),
      "imposter to listen",
    );
    writeFileSync(paths.pid, `${fake.pid}\n`);
    writeFileSync(paths.packageVersion, "0.0.0\n");
    writeFileSync(
      paths.registry,
      `${JSON.stringify(
        {
          pid: fake.pid,
          version: "0.0.0",
          socket: paths.socket,
          startedAt: new Date().toISOString(),
          roots: [],
        },
        null,
        2,
      )}\n`,
    );

    const second = cliJson(["find", "foo.py"], { cwd: repo, env });
    assert.equal(second.ok, true, second.stderr || second.stdout);
    const secondPid = Number(readFileSync(paths.pid, "utf8").trim());
    assert.notEqual(secondPid, fake.pid);
    assert.equal(readFileSync(paths.packageVersion, "utf8").trim(), version);
    assert.equal(
      JSON.parse(readFileSync(paths.registry, "utf8")).version,
      version,
    );
    await waitFor(() => processGone(fake.pid), "imposter to be stopped");

    const third = cliJson(["find", "foo.py"], { cwd: repo, env });
    assert.equal(third.ok, true, third.stderr || third.stdout);
    assert.equal(Number(readFileSync(paths.pid, "utf8").trim()), secondPid);
  },
);
