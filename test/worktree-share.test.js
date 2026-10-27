import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { rootBucket } from "../src/paths.js";
import { worktreeFingerprint } from "../src/worktree.js";

const bin = fileURLToPath(new URL("../bin/codeq.js", import.meta.url));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const MODULE = `def alpha_one():
    return 1


def beta_two():
    return alpha_one()
`;

function repository(parent, name) {
  const root = join(parent, name);
  mkdirSync(join(root, "src", "pkg"), { recursive: true });
  writeFileSync(join(root, "src", "pkg", "shared.py"), MODULE);
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

function twins(parent) {
  const main = repository(parent, "repo");
  const wtA = join(parent, "wt-a");
  const wtB = join(parent, "wt-b");
  git(main, "worktree", "add", "-b", "tree-a", wtA, "main");
  git(main, "worktree", "add", "-b", "tree-b", wtB, "main");
  return { main, wtA: realpathSync(wtA), wtB: realpathSync(wtB) };
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

function cliJson(args, { cwd, env, timeout = 120_000 }) {
  try {
    const stdout = execFileSync(process.execPath, [bin, "--json", ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, payload: JSON.parse(stdout) };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout?.toString() || "",
      stderr: error.stderr?.toString() || "",
    };
  }
}

function metadata(dataDir, root) {
  return JSON.parse(readFileSync(rootBucket(dataDir, root).metadata, "utf8"));
}

function hasGraph(dataDir, root) {
  return existsSync(join(rootBucket(dataDir, root).graphDir, "codegraph.db"));
}

function names(payload) {
  return (payload.symbols || []).map((symbol) => symbol.name);
}

test("identical worktrees fingerprint the same, a changed one does not", async () => {
  const parent = mkdtempSync(join(tmpdir(), "codeq-fp-"));
  const { main, wtA, wtB } = twins(parent);

  const clean = await worktreeFingerprint(wtA);
  assert.match(clean, /^[0-9a-f]{64}$/);
  // Content is the identity, not the path or the branch name: the main
  // checkout and both linked worktrees sit on the same commit.
  assert.equal(await worktreeFingerprint(wtB), clean);
  assert.equal(await worktreeFingerprint(main), clean);

  appendFileSync(join(wtB, "src", "pkg", "shared.py"), "\n\ndef gamma():\n    return 3\n");
  const dirty = await worktreeFingerprint(wtB);
  assert.notEqual(dirty, clean);
  assert.equal(await worktreeFingerprint(wtA), clean);

  // Untracked content counts, and reverting restores the fingerprint.
  git(wtB, "checkout", "--", "src/pkg/shared.py");
  assert.equal(await worktreeFingerprint(wtB), clean);
  writeFileSync(join(wtB, "src", "pkg", "extra.py"), "def delta():\n    return 4\n");
  assert.notEqual(await worktreeFingerprint(wtB), clean);

  // A different repository is never the same worktree, even file for file.
  assert.notEqual(await worktreeFingerprint(repository(parent, "other")), clean);

  // No git, no cheap content identity, so no sharing.
  const plain = join(parent, "plain");
  mkdirSync(plain);
  assert.equal(await worktreeFingerprint(plain), null);
});

test(
  "a second worktree with the same content reuses the first graph index",
  { timeout: 300_000 },
  (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-share-"));
    const dataDir = join(parent, "data");
    const env = { ...process.env, CODEQ_DATA_DIR: dataDir };
    delete env.CODEQ_CWD;
    t.after(() => stopDaemon(dataDir));
    const { wtA, wtB } = twins(parent);

    const first = cliJson(["graph", "alpha_one"], { cwd: wtA, env });
    assert.equal(first.ok, true, first.stderr);
    assert.equal(first.payload.root, wtA);
    assert.ok(names(first.payload).includes("alpha_one"), JSON.stringify(first.payload));
    assert.equal(hasGraph(dataDir, wtA), true);
    assert.equal(metadata(dataDir, wtA).sharedGraphRoot, undefined);

    const shared = cliJson(["graph", "alpha_one"], { cwd: wtB, env });
    assert.equal(shared.ok, true, shared.stderr);
    assert.equal(shared.payload.root, wtB);
    assert.deepEqual(
      JSON.parse(JSON.stringify(shared.payload.symbols)),
      JSON.parse(JSON.stringify(first.payload.symbols)),
      "a shared index must answer exactly like the index it reuses",
    );
    assert.equal(
      hasGraph(dataDir, wtB),
      false,
      "the second worktree must not build a second graph database",
    );
    assert.equal(metadata(dataDir, wtB).sharedGraphRoot, wtA);
    assert.equal(
      metadata(dataDir, wtB).graphFingerprint,
      metadata(dataDir, wtA).graphFingerprint,
    );

    // Changing the second worktree invalidates the share: it must answer about
    // its own content, which means an index of its own.
    appendFileSync(
      join(wtB, "src", "pkg", "shared.py"),
      "\n\ndef gamma_three():\n    return beta_two()\n",
    );
    const changed = cliJson(["graph", "gamma_three"], { cwd: wtB, env });
    assert.equal(changed.ok, true, changed.stderr);
    assert.ok(names(changed.payload).includes("gamma_three"), JSON.stringify(changed.payload));
    assert.equal(hasGraph(dataDir, wtB), true);
    assert.equal(metadata(dataDir, wtB).sharedGraphRoot, undefined);
    assert.notEqual(
      metadata(dataDir, wtB).graphFingerprint,
      metadata(dataDir, wtA).graphFingerprint,
    );

    // The worktree that owns the index never saw the edit.
    const untouched = cliJson(["graph", "gamma_three"], { cwd: wtA, env });
    assert.equal(untouched.ok, true, untouched.stderr);
    assert.equal(names(untouched.payload).includes("gamma_three"), false);
    const stillThere = cliJson(["graph", "alpha_one"], { cwd: wtA, env });
    assert.ok(names(stillThere.payload).includes("alpha_one"));
  },
);

test(
  "a worktree that changes between the match and the query re-indexes itself",
  { timeout: 300_000 },
  (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-share-stale-"));
    const dataDir = join(parent, "data");
    const env = { ...process.env, CODEQ_DATA_DIR: dataDir };
    delete env.CODEQ_CWD;
    t.after(() => stopDaemon(dataDir));
    const { wtA, wtB } = twins(parent);

    assert.equal(cliJson(["graph", "alpha_one"], { cwd: wtA, env }).ok, true);
    assert.equal(cliJson(["graph", "alpha_one"], { cwd: wtB, env }).ok, true);
    assert.equal(metadata(dataDir, wtB).sharedGraphRoot, wtA);

    // The source worktree moves on. Its watcher keeps writing into the index
    // it owns, so the attached worktree must stop reading it.
    appendFileSync(
      join(wtA, "src", "pkg", "shared.py"),
      "\n\ndef only_in_a():\n    return 5\n",
    );
    const afterSourceChanged = cliJson(["graph", "only_in_a"], { cwd: wtB, env });
    assert.equal(afterSourceChanged.ok, true, afterSourceChanged.stderr);
    assert.equal(names(afterSourceChanged.payload).includes("only_in_a"), false);
    assert.equal(hasGraph(dataDir, wtB), true);
    assert.equal(metadata(dataDir, wtB).sharedGraphRoot, undefined);
  },
);
