#!/usr/bin/env node

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { graphSearch } from "./symbol-index.js";

const require = createRequire(import.meta.url);
const root = process.argv[2];
if (!root) throw new Error("graph worker requires a project root");

const runtime = require("@colbymchenry/codegraph");
const CodeGraph = runtime.CodeGraph || runtime.default || runtime;
const platformName = `@colbymchenry/codegraph-${process.platform}-${process.arch}`;
const platformRoot = dirname(require.resolve(`${platformName}/package.json`));
const { ToolHandler } = require(
  join(platformRoot, "lib", "dist", "mcp", "index.js"),
);
const {
  DatabaseConnection,
  getDatabasePath,
} = require(join(platformRoot, "lib", "dist", "db", "index.js"));
const {
  CURRENT_SCHEMA_VERSION,
  getCurrentVersion,
} = require(join(platformRoot, "lib", "dist", "db", "migrations.js"));
const { QueryBuilder } = require(
  join(platformRoot, "lib", "dist", "db", "queries.js"),
);

let graph;
let handler;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

// The index may belong to another worktree with identical content. codeq only
// points us there while that is true, and owns the invalidation, so this
// process must only read: no sync pass, no watcher, no second writer.
const shared = process.env.CODEQ_GRAPH_SHARED === "1";

// A shared database belongs to the source worktree's own codeq context, whose
// writers may open it at any moment without holding our lock. CodeGraph.open
// is not safe against that: it issues write pragmas, runs schema migrations,
// and fires a WAL-heal worker, so a follower whose open raced an owner-side
// migration could write into someone else's database or read a half-migrated
// schema. The shared open therefore bypasses every write path — raw read-only
// SQLite, no pragmas, no migrations, no heals — and treats a database that
// needs migrating as a reason for the caller to build its own index instead.
// DatabaseConnection.open still applies a connection-level busy_timeout, which
// a raw node:sqlite handle lacks; mirror it here or a racing owner write turns
// a read into "database is locked" instead of waiting the writer out.
function openSharedReadonly(root) {
  const { DatabaseSync } = require("node:sqlite");
  const dbPath = getDatabasePath(root);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    if (getCurrentVersion(db) < CURRENT_SCHEMA_VERSION) {
      throw new Error("shared database schema is older than this runtime");
    }
  } catch (error) {
    try {
      db.close();
    } catch {}
    throw error;
  }
  return db;
}

// getPendingFiles only tracks files the watcher saw; getChangedFiles diffs the
// index against disk and covers a non-watching (shared) graph too. Union both
// so "files whose indexed lines may no longer match the file" is complete.
function staleFiles() {
  const files = new Set();
  try {
    for (const entry of graph.getPendingFiles?.() || []) files.add(entry.path);
  } catch {}
  try {
    const changed = graph.getChangedFiles?.();
    for (const list of [changed?.added, changed?.modified, changed?.removed]) {
      for (const path of list || []) files.add(path);
    }
  } catch {}
  return [...files];
}

async function initialize() {
  if (shared) {
    const dbPath = getDatabasePath(root);
    const db = openSharedReadonly(root);
    graph = new CodeGraph(
      new DatabaseConnection(db, dbPath, "node-sqlite"),
      new QueryBuilder(db),
      root,
    );
    // The stock heal reopens through DatabaseConnection.open — a read-write
    // handle that runs migrations and WAL heals on somebody else's database.
    // A replaced source file means the owner rebuilt it, so reopen through
    // the same read-only path instead; a database that no longer qualifies
    // (older schema, unreadable) makes the query fail and the caller's
    // fingerprint revalidation drops the share on its next check.
    graph.reopenIfReplaced = () => {
      if (!graph.db.isReplacedOnDisk()) return false;
      const fresh = openSharedReadonly(root);
      const stale = graph.db;
      graph.db = new DatabaseConnection(fresh, dbPath, "node-sqlite");
      graph.queries = new QueryBuilder(fresh);
      graph.wireLayers();
      try {
        stale.close();
      } catch {}
      return true;
    };
  } else if (CodeGraph.isInitialized(root)) {
    graph = await CodeGraph.open(root, { sync: true });
  } else {
    graph = await CodeGraph.init(root, { index: false });
    await graph.indexAll({
      onProgress: (progress) => {
        send({
          type: "progress",
          phase: progress.phase || "indexing graph",
          current:
            progress.processedFiles ??
            progress.current ??
            progress.indexedFiles ??
            0,
          total: progress.totalFiles ?? progress.total ?? 0,
        });
      },
    });
  }
  const watching =
    !shared &&
    graph.watch({
      onSyncComplete: () =>
        send({ type: "sync", at: new Date().toISOString() }),
      onSyncError: (error) =>
        send({ type: "degraded", reason: `auto-sync failed: ${error.message}` }),
      onDegraded: (reason) => send({ type: "degraded", reason }),
    });
  handler = new ToolHandler(graph);
  send({ type: "ready", watching });
}

function shutdown() {
  try {
    handler?.closeAll();
  } catch {}
  try {
    graph?.close();
  } catch {}
  process.exit(0);
}

await initialize();

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    send({ type: "response", id: null, error: `invalid request: ${error.message}` });
    return;
  }
  // Queries run concurrently; a "what is stale" poll must not queue behind a
  // slow search, so it answers on its own message type rather than response.
  if (request.command === "stale") {
    send({ type: "stale-report", id: request.id, files: staleFiles() });
    return;
  }
  graphSearch(graph, request.query, async (query) => {
    const result = await handler.execute("codegraph_explore", { query });
    if (result.isError) {
      throw new Error(result.content.map((part) => part.text).join("\n"));
    }
    return result.content.map((part) => part.text).join("\n");
  })
    .then(({ result, symbols }) => {
      send({
        type: "response",
        id: request.id,
        result,
        symbols,
        stale: staleFiles(),
      });
    })
    .catch((error) =>
      send({ type: "response", id: request.id, error: error.message }),
    );
});

lines.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
