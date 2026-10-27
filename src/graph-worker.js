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

let graph;
let handler;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

// The index may belong to another worktree with identical content. codeq only
// points us there while that is true, and owns the invalidation, so this
// process must only read: no sync pass, no watcher, no second writer.
const shared = process.env.CODEQ_GRAPH_SHARED === "1";

async function initialize() {
  if (shared) {
    graph = await CodeGraph.open(root, { sync: false });
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
      });
    })
    .catch((error) =>
      send({ type: "response", id: request.id, error: error.message }),
    );
});

lines.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
