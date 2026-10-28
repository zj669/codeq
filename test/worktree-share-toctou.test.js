import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const platformName = `@colbymchenry/codegraph-${process.platform}-${process.arch}`;
const platformRoot = dirname(require.resolve(`${platformName}/package.json`));
const {
  CURRENT_SCHEMA_VERSION,
} = require(join(platformRoot, "lib", "dist", "db", "migrations.js"));

const worker = fileURLToPath(new URL("../src/graph-worker.js", import.meta.url));
// The bundled runtime the daemon spawns for graph workers (root-context.js
// picks the first existing candidate; on this platform it is the flat binary).
const bundledNode = [
  join(platformRoot, "node"),
  join(platformRoot, "node", "bin", "node"),
  join(platformRoot, "bin", "node"),
].find((candidate) => existsSync(candidate));

// The shared path reads the source worktree's database through
// CODEQ_CODEGRAPH_DATA_DIRS exactly the way root-context spawns it. These
// tests drive that worker directly — it is the surface the fix lives on — so
// each case ends at a real "ready" line or a real non-zero exit.
function spawnSharedWorker(root, graphDir) {
  return spawn(bundledNode, ["--liftoff-only", worker, root], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CODEQ_CODEGRAPH_DATA_DIRS: JSON.stringify({ [root]: graphDir }),
      CODEQ_GRAPH_SHARED: "1",
    },
  });
}

function onceReady(child, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`worker never reported ready; stderr: ${stderr}`));
      }
    }, timeoutMs);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.type === "ready" && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(message);
          return;
        }
      }
    });
    child.once("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(
          new Error(
            `worker exited before ready (${signal || code}); stderr: ${stderr}`,
          ),
        );
      }
    });
  });
}

function request(child, id, payload) {
  return new Promise((resolve) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.type === "response" && message.id === id) {
          child.stdout.off("data", onData);
          resolve(message);
          return;
        }
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
  });
}

function schemaVersion(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT MAX(version) AS version FROM schema_versions")
      .get();
    return row?.version ?? 0;
  } finally {
    db.close();
  }
}

function repository(parent) {
  const root = join(parent, "src-root");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.py"), "def alpha_one():\n    return 1\n");
  spawnSync("git", ["init", "-b", "main"], { cwd: root });
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync(
    "git",
    [
      "-c",
      "user.name=codeq-test",
      "-c",
      "user.email=codeq@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
    { cwd: root },
  );
  return realpathSync(root);
}

// A source database in the state the owner publishes: built by the real
// writer path, then closed so no lock or WAL is held.
function buildSourceIndex(t, parent) {
  const root = repository(parent);
  const graphDir = join(parent, "source-graph");
  const env = {
    ...process.env,
    CODEQ_CODEGRAPH_DATA_DIRS: JSON.stringify({ [root]: graphDir }),
  };
  const built = spawnSync(
    bundledNode,
    [
      "--liftoff-only",
      worker,
      root,
    ],
    {
      env,
      encoding: "utf8",
      timeout: 300_000,
      // Closing stdin is what makes the worker exit after ready; without input
      // it would idle on the query loop until the timeout killed it.
      input: "",
    },
  );
  assert.match(
    built.stdout,
    /"type":"ready"/,
    `source index build failed: ${built.stderr}`,
  );
  return { root, graphDir };
}

test(
  "a shared worker opens the source database read-only and answers queries",
  { timeout: 300_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-share-ro-"));
    const { root, graphDir } = buildSourceIndex(t, parent);
    const dbPath = join(graphDir, "codegraph.db");
    assert.equal(existsSync(dbPath), true);

    const child = spawnSharedWorker(root, graphDir);
    t.after(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    });
    const ready = await onceReady(child);
    assert.equal(ready.watching, false);

    const reply = await request(child, 1, { query: "alpha_one" });
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    assert.ok(
      (reply.symbols || []).some((symbol) => symbol.name === "alpha_one"),
      JSON.stringify(reply),
    );

    // The database must be untouched by the read: same schema version, and a
    // second read-only handle can still open it (nothing left half-migrated).
    assert.equal(schemaVersion(dbPath), CURRENT_SCHEMA_VERSION);
  },
);

test(
  "a shared worker falls back while the source database is being migrated",
  { timeout: 300_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-share-migrating-"));
    const { root, graphDir } = buildSourceIndex(t, parent);
    const dbPath = join(graphDir, "codegraph.db");

    // A migration in flight looks like this to a reader: the schema_versions
    // ledger is behind the runtime's version (committed — WAL makes an
    // uncommitted ledger delete invisible to other connections), and the
    // migrator holds an open write transaction. The read-only open must
    // notice the version gap and refuse — the daemon then builds the
    // follower its own index rather than serving half-migrated rows.
    const migrator = new DatabaseSync(dbPath);
    t.after(() => {
      try {
        migrator.exec("ROLLBACK");
      } catch {}
      try {
        migrator.close();
      } catch {}
    });
    migrator
      .prepare("DELETE FROM schema_versions WHERE version = ?")
      .run(CURRENT_SCHEMA_VERSION);
    migrator.exec("PRAGMA busy_timeout = 100");
    migrator.exec("BEGIN");
    migrator
      .prepare("UPDATE files SET indexed_at = indexed_at WHERE 1 = 0")
      .run();

    const child = spawnSharedWorker(root, graphDir);
    t.after(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    });
    const exit = await new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    assert.notEqual(exit.code, 0, "worker must fail rather than read a migrating DB");
    // The migrator's ledger stays untouched: the failed open wrote nothing.
    migrator.exec("ROLLBACK");
    assert.ok(schemaVersion(dbPath) < CURRENT_SCHEMA_VERSION);
  },
);

test(
  "a shared worker falls back on a source database with an older schema",
  { timeout: 300_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-share-oldschema-"));
    const { root, graphDir } = buildSourceIndex(t, parent);
    const dbPath = join(graphDir, "codegraph.db");

    // Same detection surface without a live writer: a database whose version
    // ledger predates this runtime — here by exactly one version, so the
    // pending set is a single idempotent migration. Under the old
    // CodeGraph.open path the worker would have applied it in place — a
    // successful write into the source's index — and come ready; the
    // read-only open must refuse so the caller builds its own index.
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE schema_versions SET version = ? WHERE version = ?").run(
      CURRENT_SCHEMA_VERSION - 1,
      CURRENT_SCHEMA_VERSION,
    );
    db.close();

    const child = spawnSharedWorker(root, graphDir);
    t.after(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    });
    const exit = await new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    assert.notEqual(exit.code, 0, "worker must fail rather than migrate the source DB");

    // The source ledger is exactly as the test left it — the failed open wrote
    // nothing, so the owner's next open still sees the pending migration.
    assert.equal(schemaVersion(dbPath), CURRENT_SCHEMA_VERSION - 1);
  },
);

test(
  "a shared worker answers with the source database mid-sync WAL writes",
  { timeout: 300_000 },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "codeq-share-wal-"));
    const { root, graphDir } = buildSourceIndex(t, parent);
    const dbPath = join(graphDir, "codegraph.db");

    // A writer mid-transaction is the normal state of a living source index,
    // not a failure: WAL readers coexist, so the shared worker must still come
    // up and answer.
    const writer = new DatabaseSync(dbPath);
    t.after(() => {
      try {
        writer.exec("ROLLBACK");
      } catch {}
      try {
        writer.close();
      } catch {}
    });
    writer.exec("PRAGMA busy_timeout = 5000");
    writer.exec("BEGIN");
    writer
      .prepare("UPDATE files SET indexed_at = indexed_at WHERE 1 = 0")
      .run();

    const child = spawnSharedWorker(root, graphDir);
    t.after(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    });
    const ready = await onceReady(child);
    assert.equal(ready.watching, false);
    const reply = await request(child, 1, { query: "alpha_one" });
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    writer.exec("ROLLBACK");
  },
);
