import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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

test("skip-worktree and assume-unchanged files shape the fingerprint", async () => {
  const parent = mkdtempSync(join(tmpdir(), "codeq-fp-flags-"));
  const { wtA, wtB } = twins(parent);
  const clean = await worktreeFingerprint(wtA);
  assert.equal(await worktreeFingerprint(wtB), clean);

  // skip-worktree hides edits from status, but the real bytes still decide
  // whether one graph can answer for both trees.
  git(wtB, "update-index", "--skip-worktree", "src/pkg/shared.py");
  const cleanFlag = await worktreeFingerprint(wtB);
  assert.notEqual(cleanFlag, clean, "the flag alone is content-relevant state");

  appendFileSync(join(wtB, "src", "pkg", "shared.py"), "\n\ndef hidden():\n    return 8\n");
  const dirtyFlag = await worktreeFingerprint(wtB);
  assert.notEqual(dirtyFlag, cleanFlag, "flagged content must not pass for clean");
  assert.notEqual(dirtyFlag, clean);

  // Same flag, same bytes: the trees really are interchangeable.
  git(wtA, "update-index", "--skip-worktree", "src/pkg/shared.py");
  assert.equal(await worktreeFingerprint(wtA), cleanFlag);
  git(wtB, "update-index", "--no-skip-worktree", "src/pkg/shared.py");
  git(wtB, "checkout", "--", "src/pkg/shared.py");
  git(wtB, "update-index", "--skip-worktree", "src/pkg/shared.py");
  assert.equal(await worktreeFingerprint(wtB), cleanFlag);

  // assume-unchanged is a different promise than skip-worktree, even when the
  // file on disk still matches the index.
  git(wtA, "update-index", "--no-skip-worktree", "src/pkg/shared.py");
  git(wtA, "update-index", "--assume-unchanged", "src/pkg/shared.py");
  const assumed = await worktreeFingerprint(wtA);
  assert.notEqual(assumed, clean);
  assert.notEqual(assumed, cleanFlag, "assume-unchanged is not skip-worktree");

  // A dirty assume-unchanged file fingerprints by its own bytes too.
  appendFileSync(join(wtA, "src", "pkg", "shared.py"), "\n\ndef hidden_two():\n    return 9\n");
  assert.notEqual(await worktreeFingerprint(wtA), assumed);
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
  "a follower that already owns an index drops it once the shared one answers",
  { timeout: 300_000 },
  (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-follower-gc-"));
    const dataDir = join(parent, "data");
    const env = { ...process.env, CODEQ_DATA_DIR: dataDir };
    delete env.CODEQ_CWD;
    t.after(() => stopDaemon(dataDir));
    const { wtA, wtB } = twins(parent);

    // Both worktrees end up owning a database: wtB indexes while dirty (its
    // fingerprint differs, so wtA cannot share it), wtA indexes clean.
    appendFileSync(
      join(wtB, "src", "pkg", "shared.py"),
      "\n\ndef only_in_b():\n    return 9\n",
    );
    const own = cliJson(["graph", "alpha_one"], { cwd: wtB, env });
    assert.equal(own.ok, true, own.stderr);
    assert.equal(hasGraph(dataDir, wtB), true);
    assert.equal(cliJson(["graph", "alpha_one"], { cwd: wtA, env }).ok, true);
    assert.equal(hasGraph(dataDir, wtA), true);

    // Content identical again: on the next fresh context wtB should attach to
    // wtA's index, and its own database — built for content it no longer
    // holds — becomes garbage to collect now, not at TTL.
    git(wtB, "checkout", "--", "src/pkg/shared.py");
    stopDaemon(dataDir);

    const shared = cliJson(["graph", "alpha_one"], { cwd: wtB, env });
    assert.equal(shared.ok, true, shared.stderr);
    assert.equal(metadata(dataDir, wtB).sharedGraphRoot, wtA);
    assert.equal(
      hasGraph(dataDir, wtB),
      false,
      "once a shared index answers, the superseded own database is garbage",
    );

    // Nothing else in the bucket was touched: metadata still records the root.
    assert.equal(metadata(dataDir, wtB).root, wtB);

    // The share keeps answering after the deletion.
    const again = cliJson(["graph", "beta_two"], { cwd: wtB, env });
    assert.equal(again.ok, true, again.stderr);
    assert.ok(names(again.payload).includes("beta_two"), JSON.stringify(again.payload));
    assert.equal(hasGraph(dataDir, wtB), false);
  },
);

test(
  "an old own index survives while no shared index exists yet",
  { timeout: 300_000 },
  (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-follower-ttl-"));
    const dataDir = join(parent, "data");
    const env = { ...process.env, CODEQ_DATA_DIR: dataDir };
    delete env.CODEQ_CWD;
    t.after(() => stopDaemon(dataDir));
    const { wtB } = twins(parent);

    // Baseline for the repro: with no source index anywhere, the worktree's
    // own database is the only usable index and nothing may remove it — it
    // stays until the TTL sweep, which is the behaviour this issue shortens
    // only once a shared index proves usable.
    assert.equal(cliJson(["graph", "alpha_one"], { cwd: wtB, env }).ok, true);
    assert.equal(hasGraph(dataDir, wtB), true);
    const again = cliJson(["graph", "beta_two"], { cwd: wtB, env });
    assert.equal(again.ok, true, again.stderr);
    assert.equal(hasGraph(dataDir, wtB), true);
    assert.equal(metadata(dataDir, wtB).sharedGraphRoot, undefined);
  },
);

test(
  "a follower keeps its own index while the source cannot be opened",
  { timeout: 300_000 },
  (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-follower-nosource-"));
    const dataDir = join(parent, "data");
    const env = { ...process.env, CODEQ_DATA_DIR: dataDir };
    delete env.CODEQ_CWD;
    t.after(() => stopDaemon(dataDir));
    const { wtA, wtB } = twins(parent);

    // wtB owns a database built while it was dirty, wtA owns the clean one;
    // wtB is clean again so its next fresh context would share wtA's — except
    // the source is gone: remove wtA's worktree and database between the
    // daemon restarts, so no shared index can ever answer.
    appendFileSync(
      join(wtB, "src", "pkg", "shared.py"),
      "\n\ndef only_in_b():\n    return 9\n",
    );
    assert.equal(cliJson(["graph", "alpha_one"], { cwd: wtB, env }).ok, true);
    git(wtB, "checkout", "--", "src/pkg/shared.py");
    assert.equal(cliJson(["graph", "alpha_one"], { cwd: wtA, env }).ok, true);
    assert.equal(hasGraph(dataDir, wtB), true);
    stopDaemon(dataDir);

    rmSync(wtA, { recursive: true, force: true });
    rmSync(rootBucket(dataDir, wtA).bucket, { recursive: true, force: true });

    const still = cliJson(["graph", "alpha_one"], { cwd: wtB, env });
    assert.equal(still.ok, true, still.stderr);
    assert.ok(names(still.payload).includes("alpha_one"), JSON.stringify(still.payload));
    assert.equal(
      hasGraph(dataDir, wtB),
      true,
      "the only usable index must survive while no shared index answers",
    );
    assert.equal(metadata(dataDir, wtB).sharedGraphRoot, undefined);
  },
);

function cliJsonAsync(args, { cwd, env, timeout = 120_000 }) {
  return execFileAsync(process.execPath, [bin, "--json", ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  }).then(
    ({ stdout }) => ({ ok: true, payload: JSON.parse(stdout) }),
    (error) => ({
      ok: false,
      stdout: error.stdout?.toString() || "",
      stderr: error.stderr?.toString() || "",
    }),
  );
}

test(
  "two worktrees cold-starting together converge on one shared index",
  { timeout: 300_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-share-race-"));
    const dataDir = join(parent, "data");
    const env = { ...process.env, CODEQ_DATA_DIR: dataDir };
    delete env.CODEQ_CWD;
    t.after(() => stopDaemon(dataDir));
    const { wtA, wtB } = twins(parent);

    // Fired in the same tick against a cold daemon: before the fix each root
    // saw no published fingerprint and indexed its own full copy.
    const [first, second] = await Promise.all([
      cliJsonAsync(["graph", "alpha_one"], { cwd: wtA, env }),
      cliJsonAsync(["graph", "alpha_one"], { cwd: wtB, env }),
    ]);
    assert.equal(first.ok, true, first.stderr);
    assert.equal(second.ok, true, second.stderr);
    assert.ok(names(first.payload).includes("alpha_one"), JSON.stringify(first.payload));
    assert.ok(names(second.payload).includes("alpha_one"), JSON.stringify(second.payload));

    const owners = [wtA, wtB].filter((root) => hasGraph(dataDir, root));
    assert.equal(
      owners.length,
      1,
      `exactly one worktree may own the index, got ${JSON.stringify(owners)}`,
    );
    const [owner] = owners;
    const follower = owner === wtA ? wtB : wtA;
    assert.equal(metadata(dataDir, follower).sharedGraphRoot, owner);
    assert.equal(
      metadata(dataDir, follower).graphFingerprint,
      metadata(dataDir, owner).graphFingerprint,
    );
    assert.equal(metadata(dataDir, owner).sharedGraphRoot, undefined);
  },
);

test(
  "a follower converges on its own index when the claimed build fails",
  { timeout: 300_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-share-fail-"));
    const dataDir = join(parent, "data");
    const env = { ...process.env, CODEQ_DATA_DIR: dataDir };
    delete env.CODEQ_CWD;
    t.after(() => stopDaemon(dataDir));
    const { wtA, wtB } = twins(parent);

    // Poison wtA's database path so its worker can never finish indexing: the
    // claim is still taken and released, but no fingerprint is ever published.
    const doomed = rootBucket(dataDir, wtA).graphDir;
    mkdirSync(join(doomed, "codegraph.db"), { recursive: true });

    // wtA must be the one holding the claim when wtB arrives, so the follower
    // exercises wait-then-rebuild instead of winning the claim itself. The
    // winner's bucket lock appears only once it is inside the build.
    const failedPromise = cliJsonAsync(["graph", "alpha_one"], {
      cwd: wtA,
      env,
    });
    const building = join(rootBucket(dataDir, wtA).bucket, "codegraph.lock");
    const deadline = Date.now() + 120_000;
    while (!existsSync(building)) {
      if (Date.now() >= deadline) assert.fail("wtA never reached its build");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const survived = await cliJsonAsync(["graph", "alpha_one"], {
      cwd: wtB,
      env,
    });
    const failed = await failedPromise;
    assert.equal(
      failed.ok,
      false,
      "the poisoned root must fail rather than serve a half index",
    );
    assert.equal(survived.ok, true, survived.stderr);
    assert.ok(
      names(survived.payload).includes("alpha_one"),
      JSON.stringify(survived.payload),
    );
    assert.equal(
      hasGraph(dataDir, wtB),
      true,
      "with no shared source to reuse, the follower builds its own index",
    );
    assert.equal(metadata(dataDir, wtB).sharedGraphRoot, undefined);
    assert.equal(metadata(dataDir, wtA).graphFingerprint, undefined);
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
