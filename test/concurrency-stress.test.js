import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { RootContext } from "../src/root-context.js";
import { rootBucket } from "../src/paths.js";

const execFileAsync = promisify(execFile);
const bin = fileURLToPath(new URL("../bin/codeq.js", import.meta.url));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(parent, name) {
  const root = join(parent, name);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "session.ts"),
    "export function createSession() { return { id: 1 }; }\n",
  );
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(
    root,
    "-c",
    "user.name=codeq-test",
    "-c",
    "user.email=codeq@example.invalid",
    "commit",
    "-qm",
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
      code: error.code,
      killed: error.killed,
    }),
  );
}

// root.json is the shared ledger: every query touch() republishes it
// (atomically, temp + rename), and GC plus findSharedGraph read it from other
// processes. Parallel contexts hammering one bucket is the multi-agent shape:
// two overlapping publishes must never tear the file, and the value a reader
// sees must never regress to an older lastAccessedAt once a newer one landed.
test(
  "parallel contexts hammering one bucket keep root.json valid and monotone",
  { timeout: 120_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-meta-hammer-"));
    const dataDir = join(parent, "data");
    const repo = repository(parent, "app");
    const bucket = rootBucket(dataDir, repo);

    // A synthetic shared-graph holder is the second writer shape: it touches
    // the source bucket's root.json through the same touch() path. It never
    // awaits an index, so its writes are pure metadata traffic.
    const { wtA, wtB } = twins(parent);
    const sourceBucket = rootBucket(dataDir, wtB);
    mkdirSync(sourceBucket.bucket, { recursive: true });
    writeFileSync(
      sourceBucket.metadata,
      `${JSON.stringify({
        root: wtB,
        schema: 1,
        lastAccessedAt: new Date(0).toISOString(),
      })}\n`,
    );
    const follower = new RootContext(wtA, dataDir);
    follower.sharedGraph = {
      key: sourceBucket.key,
      bucket: sourceBucket.bucket,
      graphDir: sourceBucket.graphDir,
      root: wtB,
      fingerprint: "synthetic",
      lock: sourceBucket.graphLock,
    };

    const contexts = Array.from(
      { length: 8 },
      () => new RootContext(repo, dataDir),
    );
    contexts.push(follower);
    t.after(() => {
      for (const context of contexts) context.dispose();
    });

    // Phase 1: parallel contexts touching one bucket. Every mid-flight read
    // must be valid JSON, and once the storm ends the newest publish must win —
    // a torn rename or lost update leaves a stale or broken root.json.
    const storm = 40;
    for (let round = 0; round < storm; round += 1) {
      for (const context of contexts) context.touch();
      // A slice for the queued writeFile+rename pairs, then read what an
      // outside process sees mid-flight. Before the first publish the file
      // legitimately does not exist yet.
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!existsSync(bucket.metadata)) continue;
      const parsed = JSON.parse(readFileSync(bucket.metadata, "utf8"));
      assert.equal(parsed.root, repo, `torn root.json at round ${round}`);
      const seen = Date.parse(parsed.lastAccessedAt);
      assert.ok(
        Number.isFinite(seen),
        `unparseable lastAccessedAt at round ${round}`,
      );
    }
    const deadline = Date.now() + 10_000;
    let newestSeen = 0;
    for (;;) {
      const meta = JSON.parse(readFileSync(bucket.metadata, "utf8"));
      newestSeen = Math.max(newestSeen, Date.parse(meta.lastAccessedAt));
      const stale = contexts.some(
        (context) => context !== follower && context.lastAccess > newestSeen,
      );
      if (!stale) break;
      if (Date.now() >= deadline) {
        assert.fail(
          `lost update: a context touched at ${Math.max(
            ...contexts
              .filter((context) => context !== follower)
              .map((context) => context.lastAccess),
          )} but root.json still shows ${newestSeen}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // Phase 2: the read-modify-write race proper. The source's own context
    // republishes root.json atomically (temp + rename, full document, including
    // graphFingerprint the sharers rely on). The follower touches the same
    // file with a synchronous read-modify-write. If the touch reads the file
    // after the owner's publish computed the new document but before its
    // rename lands — or writes a stale copy over the rename — the fingerprint
    // the owner just advertised disappears and listGraphSources stops seeing
    // the index as shareable.
    const owner = new RootContext(wtB, dataDir);
    owner.graphFingerprint = "owner-fingerprint";
    t.after(() => owner.dispose());
    // The owner's #writeMetadata is async and fire-and-forget; run many
    // publish-vs-touch interleavings and then verify the surviving document
    // still carries the owner's fingerprint.
    for (let round = 0; round < 200; round += 1) {
      owner.touch();
      follower.touch();
      if (round % 10 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const sourceMeta = JSON.parse(
      readFileSync(sourceBucket.metadata, "utf8"),
    );
    assert.equal(sourceMeta.root, wtB, "torn shared-source root.json");
    assert.equal(
      sourceMeta.graphFingerprint,
      "owner-fingerprint",
      `touchGraphSource clobbered the owner's publish: ${JSON.stringify(
        sourceMeta,
      )}`,
    );
  },
);

// The real surface: N agent processes (separate node runs sharing one daemon
// over one socket) mixing reads, a cold twin worktree that shares the first's
// graph, and a daemon restart mid-storm. Invariants: every call terminates,
// every reply that arrived is well-formed, a restart failure is a clean error
// (never torn output or a hang), exactly one daemon exists afterwards, and the
// log shows no bind or SQLite races.
test(
  "parallel agents hammering find/grep/graph across a daemon restart stay clean",
  { timeout: 300_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-hammer-"));
    const dataDir = join(parent, "data");
    const env = { ...process.env, CODEQ_DATA_DIR: dataDir };
    delete env.CODEQ_CWD;
    const { wtA, wtB } = twins(parent);
    t.after(() => stopDaemon(dataDir));

    // Warm wtA's graph so wtB's cold queries attach to a shared source — the
    // follower then touches wtA's bucket while wtA's own queries rewrite it.
    const warm = await cliJson(["graph", "createSession"], { cwd: wtA, env });
    assert.equal(warm.ok, true, warm.stderr || warm.stdout);

    const agents = [];
    const callsPerAgent = 6;
    for (let agent = 0; agent < 4; agent += 1) {
      const cwd = agent % 2 === 0 ? wtA : wtB;
      agents.push(
        (async () => {
          const replies = [];
          for (let call = 0; call < callsPerAgent; call += 1) {
            const command = ["find", "grep", "graph"][(agent + call) % 3];
            const reply = await cliJson([command, "createSession"], {
              cwd,
              env,
            });
            replies.push({ agent, call, command, reply });
          }
          return replies;
        })(),
      );
    }

    // Kill the daemon mid-storm: in-flight queries must fail cleanly and the
    // next caller must resurrect exactly one daemon, not a bind race.
    setTimeout(() => stopDaemon(dataDir), 400).unref();

    const settled = (await Promise.all(agents)).flat();
    let failed = 0;
    for (const { agent, call, command, reply } of settled) {
      if (!reply.ok) {
        failed += 1;
        // A call that caught the restart may fail — but only with a clean
        // error, never a hang (the harness timeout would have fired) and
        // never torn stdout that half-parsed as JSON.
        assert.equal(
          reply.stdout.trim(),
          "",
          `agent ${agent} call ${call} (${command}) leaked stdout on failure`,
        );
        continue;
      }
      assert.equal(reply.payload.command, command);
      assert.match(reply.payload.status, /ready|indexing|degraded/);
      assert.equal(
        typeof reply.payload.root,
        "string",
        `agent ${agent} call ${call}: ${JSON.stringify(reply.payload).slice(0, 300)}`,
      );
    }

    // The daemon survived the storm: whoever restarted it, exactly one answers.
    const final = await cliJson(["find", "session.ts"], { cwd: wtA, env });
    assert.equal(final.ok, true, final.stderr);
    const registry = JSON.parse(
      readFileSync(join(dataDir, "daemon", "registry.json"), "utf8"),
    );
    assert.ok(registry.pid > 1);
    const log = existsSync(join(dataDir, "daemon", "logs", "daemon.log"))
      ? readFileSync(join(dataDir, "daemon", "logs", "daemon.log"), "utf8")
      : "";
    assert.equal(/EADDRINUSE/.test(log), false, log);
    assert.equal(/database is locked/.test(log), false, log);
    assert.equal(/duplicate column name/.test(log), false, log);

    // Every bucket's metadata still parses — a torn root.json is exactly what
    // the storm looks for.
    for (const root of [wtA, wtB]) {
      const meta = rootBucket(dataDir, root).metadata;
      if (!existsSync(meta)) continue;
      const parsed = JSON.parse(readFileSync(meta, "utf8"));
      assert.equal(parsed.root, root, `torn metadata for ${root}`);
    }
    process.stderr.write(
      `[stress] ${settled.length} calls, ${failed} failed across restart\n`,
    );
  },
);
