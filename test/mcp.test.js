import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  createFramedParser,
  createMcpServer,
  encodeMessage,
  negotiateProtocolVersion,
  NO_WORKSPACE_ERROR,
} from "../src/mcp.js";
import { EMPTY_TOOL_MENU, GREP_REGEX_REQUIRED } from "../src/mcp-format.js";

const { version } = createRequire(import.meta.url)("../package.json");

function collectMessages(stream) {
  const messages = [];
  const parse = createFramedParser((message) => messages.push(message));
  stream.on("data", (chunk) => {
    parse(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  return messages;
}

async function waitFor(messages, predicate, timeout = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const match = messages.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for MCP message: ${JSON.stringify(messages)}`);
}

async function withServer(options, fn) {
  const input = new PassThrough();
  const output = new PassThrough();
  const raw = [];
  output.on("data", (chunk) => {
    raw.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
  });
  const messages = collectMessages(output);
  const server = createMcpServer({
    cwd: "/tmp/workspace",
    query: async (request) => ({
      root: request.root || request.cwd,
      status: "ready",
      fffWarning: null,
      graphWarning: null,
      total: 0,
      results: [],
      result: "graph-output",
      request,
    }),
    ...options,
  });
  server.attach(input, output);
  await fn({
    input,
    messages,
    send(message, framing = "content-length") {
      input.write(encodeMessage(message, framing));
    },
    writeRaw(buffer) {
      input.write(buffer);
    },
    rawOutput() {
      return Buffer.concat(raw);
    },
    waitFor(predicate) {
      return waitFor(messages, predicate);
    },
    server,
  });
  input.end();
}

test("negotiates a protocol version the server supports", () => {
  assert.equal(negotiateProtocolVersion("2024-11-05"), "2024-11-05");
  assert.equal(negotiateProtocolVersion("2025-03-26"), "2025-03-26");
  assert.equal(negotiateProtocolVersion("not-a-version"), "2025-06-18");
  assert.equal(negotiateProtocolVersion("2025-11-25"), "2025-06-18");
});

test("framed parser reassembles split headers and bodies", () => {
  const messages = [];
  const parse = createFramedParser((message) => messages.push(message));
  const encoded = encodeMessage({ jsonrpc: "2.0", id: 1, method: "ping" });
  parse(encoded.subarray(0, 8));
  parse(encoded.subarray(8, 20));
  parse(encoded.subarray(20));
  assert.deepEqual(messages, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
});

// OpenCode 1.18.31 stdin: 170-byte NDJSON initialize, hex ends 7d0a (`}\n`).
const OPENCODE_INITIALIZE = Buffer.from(
  "7b226d6574686f64223a22696e697469616c697a65222c22706172616d73223a7b2270726f746f636f6c56657273696f6e223a22323032352d31312d3235222c226361706162696c6974696573223a7b22726f6f7473223a7b7d7d2c22636c69656e74496e666f223a7b226e616d65223a226f70656e636f6465222c2276657273696f6e223a22312e31382e3331227d7d2c226a736f6e727063223a22322e30222c226964223a307d0a",
  "hex",
);

test("OpenCode NDJSON initialize is a complete frame without Content-Length", () => {
  assert.equal(OPENCODE_INITIALIZE.length, 170);
  assert.equal(OPENCODE_INITIALIZE[OPENCODE_INITIALIZE.length - 2], 0x7d);
  assert.equal(OPENCODE_INITIALIZE[OPENCODE_INITIALIZE.length - 1], 0x0a);
  assert.equal(OPENCODE_INITIALIZE.toString("utf8").includes("Content-Length"), false);

  const messages = [];
  const framings = [];
  const parse = createFramedParser((message, framing) => {
    messages.push(message);
    framings.push(framing);
  });
  parse(OPENCODE_INITIALIZE.subarray(0, 40));
  assert.equal(messages.length, 0);
  parse(OPENCODE_INITIALIZE.subarray(40, 90));
  assert.equal(messages.length, 0);
  parse(OPENCODE_INITIALIZE.subarray(90));
  assert.equal(messages.length, 1);
  assert.deepEqual(framings, ["ndjson"]);
  assert.equal(messages[0].method, "initialize");
  assert.equal(messages[0].id, 0);
  assert.equal(messages[0].params.protocolVersion, "2025-11-25");
  assert.deepEqual(messages[0].params.capabilities, { roots: {} });
  assert.equal(messages[0].params.clientInfo.name, "opencode");
});

test("NDJSON replies omit Content-Length and keep Content-Length replies framed", () => {
  const ndjson = encodeMessage({ jsonrpc: "2.0", id: 0, method: "ping" }, "ndjson");
  const ndjsonText = ndjson.toString("utf8");
  assert.equal(ndjsonText.includes("Content-Length"), false);
  assert.equal(ndjsonText.endsWith("\n"), true);
  assert.equal(ndjsonText.slice(0, -1).includes("\n"), false);

  const framed = encodeMessage({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.match(framed.toString("utf8"), /^Content-Length: \d+\r\n\r\n/);
});

test("OpenCode NDJSON handshake: initialize → initialized → tools/list → find", async () => {
  await withServer({}, async ({ send, writeRaw, waitFor, rawOutput, input }) => {
    writeRaw(OPENCODE_INITIALIZE);
    const init = await waitFor((message) => message.id === 0);
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "codeq");
    assert.equal(init.result.serverInfo.version, version);
    const initBytes = rawOutput().toString("utf8");
    assert.equal(initBytes.includes("Content-Length:"), false);
    assert.match(initBytes, /^\{/);
    assert.match(initBytes, /\}\n$/);

    send({ jsonrpc: "2.0", method: "notifications/initialized" }, "ndjson");
    const listRoots = await waitFor((message) => message.method === "roots/list");
    assert.equal(rawOutput().toString("utf8").includes("Content-Length:"), false);
    input.write(
      encodeMessage(
        {
          jsonrpc: "2.0",
          id: listRoots.id,
          result: { roots: [{ uri: "file:///tmp/workspace", name: "workspace" }] },
        },
        "ndjson",
      ),
    );

    send({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "ndjson");
    const listed = await waitFor((message) => message.id === 1);
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      ["find", "grep", "graph"],
    );

    send(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "find", arguments: { query: "app.ts" } },
      },
      "ndjson",
    );
    const find = await waitFor((message) => message.id === 2);
    assert.equal(find.result.isError, undefined);
    assert.match(find.result.content[0].text, /^\[ready\]/);

    send(
      {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: {
          requestId: 2,
          reason: "AbortError: The operation was aborted.",
        },
      },
      "ndjson",
    );

    const all = rawOutput().toString("utf8");
    assert.equal(all.includes("Content-Length:"), false);
    for (const line of all.split("\n").filter(Boolean)) {
      JSON.parse(line);
    }
  });
});

test("replies use the framing of each request", async () => {
  await withServer({}, async ({ send, waitFor, rawOutput }) => {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    });
    await waitFor((message) => message.id === 1);
    const afterFramed = rawOutput().toString("utf8");
    assert.match(afterFramed, /^Content-Length: /);

    const framedLength = rawOutput().length;
    send({ jsonrpc: "2.0", id: 2, method: "ping" }, "ndjson");
    await waitFor((message) => message.id === 2);
    const ndjsonReply = rawOutput().subarray(framedLength).toString("utf8");
    assert.equal(ndjsonReply.includes("Content-Length:"), false);
    assert.match(ndjsonReply, /^\{/);
    assert.match(ndjsonReply, /\}\n$/);
    assert.equal(JSON.parse(ndjsonReply.trim()).id, 2);
  });
});

test("initialize advertises only find, grep, and graph", async () => {
  await withServer({}, async ({ send, waitFor }) => {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    const init = await waitFor((message) => message.id === 1);
    assert.equal(init.result.protocolVersion, "2025-03-26");
    assert.equal(init.result.serverInfo.name, "codeq");
    assert.equal(init.result.serverInfo.version, version);
    assert.match(init.result.instructions, /never ask the user to init/i);
    assert.match(init.result.instructions, /first line names the resolved absolute root/);
    assert.match(init.result.instructions, /already located/);
    assert.equal(
      init.result.instructions.includes("Replies are locators. Read source with the host Read tool."),
      false,
    );
    assert.equal(/graph: how code works/i.test(init.result.instructions), false);
    assert.equal(init.result.instructions.includes("There is no callers tool"), false);
    assert.equal(/literal string, not rg/i.test(init.result.instructions), false);
    assert.equal(/detail:\s*"full"/i.test(init.result.instructions), false);
    assert.equal(/jev|noul|prod_shortlist|exact_neighborhood|tier_order/i.test(init.result.instructions), false);

    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = await waitFor((message) => message.id === 2);
    const names = listed.result.tools.map((tool) => tool.name);
    assert.deepEqual(names, ["find", "grep", "graph"]);
    for (const banned of [
      "start",
      "stop",
      "status",
      "sync",
      "rescan",
      "callers",
      "callees",
      "health",
    ]) {
      assert.equal(names.includes(banned), false);
    }
  });
});

test("tools map 1:1 onto daemon find/grep/graph requests", async () => {
  const seen = [];
  await withServer(
    {
      query: async (request) => {
        seen.push(request);
        return {
          root: "/repo",
          status: "indexing",
          fffWarning: null,
          graphWarning: null,
          total: 1,
          results: [{ path: "src/app.ts" }],
          result: "explore",
        };
      },
    },
    async ({ send, waitFor }) => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {} },
      });
      await waitFor((message) => message.id === 1);

      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "find",
          arguments: { query: "app.ts", path: "src", limit: 5 },
        },
      });
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "grep",
          arguments: {
            pattern: "TODO",
            glob: "**/*.ts",
            regex: true,
            cursor: "opaque",
            root: "/repo",
            limit: 8,
          },
        },
      });
      send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "graph",
          arguments: { query: "auth session", path: "../other" },
        },
      });

      const find = await waitFor((message) => message.id === 2);
      const grep = await waitFor((message) => message.id === 3);
      const graph = await waitFor((message) => message.id === 4);

      assert.equal(find.result.isError, undefined);
      assert.equal("command" in find.result.structuredContent, false);
      assert.deepEqual(find.result.structuredContent.paths, ["src/app.ts"]);
      assert.equal("hits" in grep.result.structuredContent, true);
      assert.equal("entries" in graph.result.structuredContent, true);
      assert.equal("complete" in graph.result.structuredContent, false);
      assert.equal(typeof graph.result.structuredContent.truncated, "boolean");
      assert.match(find.result.content[0].text, /^\[indexing\]/);

      assert.deepEqual(seen[0], {
        command: "find",
        cwd: "/tmp/workspace",
        cwdSource: "spawn cwd",
        query: "app.ts",
        path: "src",
        limit: 5,
      });
      assert.deepEqual(seen[1], {
        command: "grep",
        cwd: "/tmp/workspace",
        cwdSource: "spawn cwd",
        query: "TODO",
        glob: "**/*.ts",
        regex: true,
        cursor: "opaque",
        root: "/repo",
        limit: 8,
      });
      assert.deepEqual(seen[2], {
        command: "graph",
        cwd: "/tmp/workspace",
        cwdSource: "spawn cwd",
        query: "auth session",
        path: "../other",
      });
    },
  );
});

test("grep forwards context, count, and ignoreCase; count rejects cursor", async () => {
  const { GREP_COUNT_CURSOR_ERROR } = await import("../src/grep-cursor.js");
  const seen = [];
  await withServer(
    {
      query: async (request) => {
        seen.push(request);
        if (request.count && request.cursor) {
          throw new Error(GREP_COUNT_CURSOR_ERROR);
        }
        if (request.count) {
          return {
            root: "/repo",
            status: "ready",
            pattern: request.query,
            count: true,
            matchCount: 4,
            fileCount: 2,
            results: [],
          };
        }
        return {
          root: "/repo",
          status: "ready",
          pattern: request.query,
          mode: "plain",
          requestedLimit: request.limit ?? null,
          pageCap: 48,
          context: Math.min(request.context ?? 0, 3),
          contextCapped: (request.context ?? 0) > 3,
          results: Array.from({ length: request.limit || 1 }, (_, i) => ({
            path: `src/f${i}.ts`,
            line: i + 2,
            column: 1,
            text: "TODO",
            contextBefore: ["before"],
            contextAfter: ["after"],
          })),
        };
      },
    },
    async ({ send, waitFor }) => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      });
      await waitFor((message) => message.id === 1);

      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "grep",
          arguments: {
            pattern: "TODO",
            regex: false,
            context: 2,
            ignoreCase: false,
            limit: 30,
          },
        },
      });
      const neighbors = await waitFor((message) => message.id === 2);
      assert.equal(seen[0].context, 2);
      assert.equal(seen[0].ignoreCase, false);
      assert.equal(seen[0].limit, 30);
      assert.equal(neighbors.result.structuredContent.hits.length, 30);
      assert.match(neighbors.result.content[0].text, /^src\/f0\.ts:1 before$/m);
      assert.match(neighbors.result.content[0].text, /^src\/f0\.ts:2 TODO$/m);
      assert.equal(neighbors.result.content[0].text.split("\n")[0].includes("root /repo"), true);

      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "grep",
          arguments: { pattern: "TODO", regex: false, context: 10 },
        },
      });
      const capped = await waitFor((message) => message.id === 3);
      assert.equal(seen[1].context, 10);
      assert.match(capped.result.content[0].text, /context capped at 3/);

      send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "grep",
          arguments: { pattern: "TODO", regex: false, count: true },
        },
      });
      const counted = await waitFor((message) => message.id === 4);
      assert.equal(seen[2].count, true);
      assert.deepEqual(counted.result.structuredContent.hits, []);
      assert.equal(counted.result.structuredContent.matchCount, 4);
      assert.match(counted.result.content[0].text, /4 matches in 2 files/);
      assert.equal(counted.result.content[0].text.includes("src/f"), false);

      send({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "grep",
          arguments: {
            pattern: "TODO",
            regex: false,
            count: true,
            cursor: "opaque",
          },
        },
      });
      const rejected = await waitFor((message) => message.id === 5);
      assert.equal(rejected.result.isError, true);
      assert.equal(rejected.result.content[0].text, GREP_COUNT_CURSOR_ERROR);
    },
  );
});

test("grep without context defaults to 1; context: 0 stays locator-only", async () => {
  const seen = [];
  await withServer(
    {
      query: async (request) => {
        seen.push(request);
        return {
          root: "/repo",
          status: "ready",
          pattern: request.query,
          mode: "plain",
          context: request.context ?? 0,
          results: [
            {
              path: "src/f0.ts",
              line: 2,
              column: 1,
              text: "TODO",
              contextBefore: ["before"],
              contextAfter: ["after"],
            },
          ],
        };
      },
    },
    async ({ send, waitFor }) => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      });
      await waitFor((message) => message.id === 1);

      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "grep",
          arguments: { pattern: "TODO", regex: false },
        },
      });
      const defaulted = await waitFor((message) => message.id === 2);
      assert.equal(seen[0].context, 1);
      assert.match(defaulted.result.content[0].text, /^src\/f0\.ts:1 before$/m);
      assert.match(defaulted.result.content[0].text, /^src\/f0\.ts:2 TODO$/m);
      assert.match(defaulted.result.content[0].text, /^src\/f0\.ts:3 after$/m);

      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "grep",
          arguments: { pattern: "TODO", regex: false, context: 0 },
        },
      });
      const bare = await waitFor((message) => message.id === 3);
      assert.equal(seen[1].context, 0);
      assert.equal(bare.result.content[0].text.includes("before"), false);
      assert.equal(bare.result.content[0].text.includes("after"), false);

      send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "grep",
          arguments: { pattern: "TODO", regex: false, count: true },
        },
      });
      await waitFor((message) => message.id === 4);
      assert.equal(seen[2].context, undefined);

      // A cursor call omits context so the daemon adopts the token's bound
      // value instead of re-defaulting against it.
      send({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "grep",
          arguments: { pattern: "TODO", regex: false, cursor: "opaque" },
        },
      });
      await waitFor((message) => message.id === 5);
      assert.equal(seen[3].context, undefined);
      assert.equal(seen[3].cursor, "opaque");
    },
  );
});

test("unknown tools and daemon failures are tool errors, not extra commands", async () => {
  await withServer(
    {
      query: async () => {
        throw new Error("boom");
      },
    },
    async ({ send, waitFor }) => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      });
      await waitFor((message) => message.id === 1);

      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "sync", arguments: {} },
      });
      const unknown = await waitFor((message) => message.id === 2);
      assert.equal(unknown.result.isError, true);
      assert.match(unknown.result.content[0].text, /unknown tool/);

      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "find", arguments: { query: "x" } },
      });
      const failed = await waitFor((message) => message.id === 3);
      assert.equal(failed.result.isError, true);
      assert.equal(failed.result.content[0].text, "boom");
    },
  );
});

test("unnamed or empty tools/call returns the shared menu; a real unknown name does not", async () => {
  const seen = [];
  await withServer(
    {
      query: async (request) => {
        seen.push(request);
        return { root: "/repo", status: "ready", results: [] };
      },
    },
    async ({ send, waitFor }) => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      });
      await waitFor((message) => message.id === 1);

      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} });
      const unnamed = await waitFor((message) => message.id === 2);
      assert.equal(unnamed.result.isError, true);
      assert.equal(unnamed.result.content[0].text, EMPTY_TOOL_MENU);

      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "   ", arguments: {} },
      });
      const blankName = await waitFor((message) => message.id === 3);
      assert.equal(blankName.result.content[0].text, EMPTY_TOOL_MENU);

      send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "grep", arguments: {} },
      });
      const emptyGrep = await waitFor((message) => message.id === 4);
      assert.equal(emptyGrep.result.isError, true);
      assert.equal(emptyGrep.result.content[0].text, EMPTY_TOOL_MENU);
      assert.equal(
        emptyGrep.result.content[0].text.includes("grep requires pattern"),
        false,
      );

      send({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "find" },
      });
      const missingArgs = await waitFor((message) => message.id === 5);
      assert.equal(missingArgs.result.content[0].text, EMPTY_TOOL_MENU);

      send({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "graph", arguments: { query: "  " } },
      });
      const blankQuery = await waitFor((message) => message.id === 6);
      assert.equal(blankQuery.result.content[0].text, EMPTY_TOOL_MENU);

      send({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "search", arguments: { query: "x" } },
      });
      const unknown = await waitFor((message) => message.id === 7);
      assert.equal(unknown.result.isError, true);
      assert.equal(unknown.result.content[0].text, "unknown tool: search");
      assert.equal(unknown.result.content[0].text.includes("codeq needs"), false);

      send({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "grep", arguments: { pattern: "TODO" } },
      });
      const missingRegex = await waitFor((message) => message.id === 8);
      assert.equal(missingRegex.result.isError, true);
      assert.equal(missingRegex.result.content[0].text, GREP_REGEX_REQUIRED);
      assert.equal(missingRegex.result.content[0].text.includes("codeq needs"), false);
      assert.equal(missingRegex.result.content[0].text.includes("fuzzy"), false);

      send({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "grep", arguments: { pattern: "TODO", regex: "true" } },
      });
      const stringRegex = await waitFor((message) => message.id === 9);
      assert.equal(stringRegex.result.isError, true);
      assert.equal(stringRegex.result.content[0].text, GREP_REGEX_REQUIRED);

      assert.equal(seen.length, 0);
    },
  );
});

test("path/root and cwd switch a single root with no fusion", async () => {
  const seen = [];
  await withServer(
    {
      query: async (request) => {
        seen.push(request);
        return { root: request.root || request.path, status: "ready" };
      },
    },
    async ({ send, waitFor }) => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {} },
      });
      await waitFor((message) => message.id === 1);
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "find",
          arguments: {
            query: "main.go",
            cwd: "/repos/alpha",
            path: "../beta",
          },
        },
      });
      await waitFor((message) => message.id === 2);
      assert.deepEqual(seen[0], {
        command: "find",
        cwd: "/repos/alpha",
        query: "main.go",
        path: "../beta",
        cwdSource: "cwd argument",
      });
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "find", arguments: { query: "widget" } },
      });
      await waitFor((message) => message.id === 3);
      assert.equal(seen[1].cwd, "/tmp/workspace");
      assert.equal(seen[1].path, undefined);
      assert.equal(seen[1].root, undefined);
      assert.equal(seen[1].cwdSource, "spawn cwd");
    },
  );
});

test("omitting root searches the spawn cwd and the reply names it", async () => {
  const seen = [];
  await withServer(
    {
      cwd: "/repos/worktree",
      query: async (request) => {
        seen.push(request);
        return {
          root: request.root || request.cwd,
          rootSource: request.root ? "root" : "cwd",
          cwdSource: request.cwdSource,
          status: "ready",
          results: [],
          result: "graph-output",
        };
      },
    },
    async ({ send, waitFor }) => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {} },
      });
      await waitFor((message) => message.id === 1);

      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "graph",
          arguments: { query: "leagent_chat get_final_answer" },
        },
      });
      const defaulted = await waitFor((message) => message.id === 2);
      const defaultedText = defaulted.result.content[0].text;
      assert.equal(seen[0].cwd, "/repos/worktree");
      assert.equal(seen[0].root, undefined);
      assert.equal(
        defaultedText.split("\n")[0],
        "[ready] root /repos/worktree via cwd:spawn cwd",
      );
      const defaultedPayload = defaulted.result.structuredContent;
      assert.equal(defaultedPayload.root, "/repos/worktree");
      assert.equal("rootSource" in defaultedPayload, false);
      assert.equal("cwdSource" in defaultedPayload, false);
      assert.equal("entries" in defaultedPayload, true);

      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "graph",
          arguments: {
            query: "leagent_chat get_final_answer",
            root: "/repos/leagent",
          },
        },
      });
      const retried = await waitFor((message) => message.id === 3);
      const retriedText = retried.result.content[0].text;
      assert.equal(seen[1].root, "/repos/leagent");
      assert.equal(
        retriedText.split("\n")[0],
        "[ready] root /repos/leagent via root argument",
      );
      assert.equal("rootSource" in retried.result.structuredContent, false);
    },
  );
});

test("uses client roots as the session cwd, like pi-fff ctx.cwd", async () => {
  const seen = [];
  await withServer(
    {
      query: async (request) => {
        seen.push(request);
        return { root: request.cwd, status: "ready", results: [] };
      },
    },
    async ({ send, waitFor, input }) => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: { roots: { listChanged: true } },
        },
      });
      await waitFor((message) => message.id === 1);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const listRoots = await waitFor(
        (message) => message.method === "roots/list",
      );
      input.write(
        encodeMessage({
          jsonrpc: "2.0",
          id: listRoots.id,
          result: { roots: [{ uri: "file:///repos/workspace", name: "workspace" }] },
        }),
      );
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "find", arguments: { query: "pkg" } },
      });
      await waitFor((message) => message.id === 2);
      assert.equal(seen[0].cwd, "/repos/workspace");
      assert.equal(seen[0].cwdSource, "roots/list");

      send({ jsonrpc: "2.0", method: "notifications/roots/list_changed" });
      const relist = await waitFor(
        (message) => message.method === "roots/list" && message.id !== listRoots.id,
      );
      input.write(
        encodeMessage({
          jsonrpc: "2.0",
          id: relist.id,
          result: { roots: [{ uri: "file:///repos/other", name: "other" }] },
        }),
      );
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "find", arguments: { query: "pkg" } },
      });
      await waitFor((message) => message.id === 3);
      assert.equal(seen[1].cwd, "/repos/other");
    },
  );
});

test("HOME spawn handshake does not query; tools/call needs path or root", async () => {
  const seen = [];
  await withServer(
    {
      cwd: homedir(),
      query: async (request) => {
        seen.push(request);
        return { root: request.path || request.root, status: "ready", results: [] };
      },
    },
    async ({ send, waitFor }) => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {} },
      });
      await waitFor((message) => message.id === 1);
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      await waitFor((message) => message.id === 2);
      assert.equal(seen.length, 0);

      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "find", arguments: { query: "pkg" } },
      });
      const missing = await waitFor((message) => message.id === 3);
      assert.equal(missing.result.isError, true);
      assert.equal(missing.result.content[0].text, NO_WORKSPACE_ERROR);
      assert.match(missing.result.content[0].text, /pass path or root/i);
      assert.equal(missing.result.content[0].text.includes("refusing to index"), false);
      assert.equal(seen.length, 0);

      send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "find",
          arguments: { query: "pkg", path: "/repos/beta" },
        },
      });
      await waitFor((message) => message.id === 4);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].path, "/repos/beta");
      assert.equal(seen[0].cwd, homedir());
      assert.equal(seen[0].cwdSource, "spawn cwd");

      send({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "grep", arguments: {} },
      });
      const emptyFromHome = await waitFor((message) => message.id === 5);
      assert.equal(emptyFromHome.result.isError, true);
      assert.equal(emptyFromHome.result.content[0].text, NO_WORKSPACE_ERROR);
      assert.equal(seen.length, 1);
    },
  );
});

test("HOME spawn uses roots/list only when that folder is not HOME", async () => {
  const seen = [];
  await withServer(
    {
      cwd: homedir(),
      query: async (request) => {
        seen.push(request);
        return { root: request.cwd, status: "ready", results: [] };
      },
    },
    async ({ send, waitFor, input }) => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: { roots: { listChanged: true } },
        },
      });
      await waitFor((message) => message.id === 1);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const listRoots = await waitFor((message) => message.method === "roots/list");
      input.write(
        encodeMessage({
          jsonrpc: "2.0",
          id: listRoots.id,
          result: {
            roots: [
              { uri: `file://${homedir()}`, name: "home" },
              { uri: "file:///repos/workspace", name: "workspace" },
            ],
          },
        }),
      );
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "find", arguments: { query: "pkg" } },
      });
      await waitFor((message) => message.id === 2);
      assert.equal(seen[0].cwd, "/repos/workspace");
    },
  );
});

test("defaults to process.cwd and ignores CODEQ_CWD-style path env", async () => {
  const previous = process.env.CODEQ_CWD;
  process.env.CODEQ_CWD = "/env/should-not-win";
  const seen = [];
  try {
    await withServer(
      {
        cwd: undefined,
        query: async (request) => {
          seen.push(request);
          return { root: request.cwd, status: "ready", results: [] };
        },
      },
      async ({ send, waitFor }) => {
        send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {} },
        });
        await waitFor((message) => message.id === 1);
        send({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "find", arguments: { query: "pkg" } },
        });
        await waitFor((message) => message.id === 2);
        assert.equal(seen[0].cwd, process.cwd());
        assert.notEqual(seen[0].cwd, "/env/should-not-win");
      },
    );
  } finally {
    if (previous === undefined) delete process.env.CODEQ_CWD;
    else process.env.CODEQ_CWD = previous;
  }
});

test("tool schemas do not mention a workspace path env", async () => {
  await withServer({}, async ({ send, waitFor }) => {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {} },
    });
    await waitFor((message) => message.id === 1);
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = await waitFor((message) => message.id === 2);
    const blob = JSON.stringify(listed.result.tools);
    assert.equal(blob.includes("CODEQ_CWD"), false);
    assert.equal(/jev|noul|prod_shortlist|exact_neighborhood|tier_order/i.test(blob), false);
    const grep = listed.result.tools.find((tool) => tool.name === "grep");
    assert.equal(Boolean(grep.inputSchema.properties.limit), true);
    assert.equal(Boolean(grep.inputSchema.properties.detail), false);
    assert.equal(Boolean(grep.inputSchema.properties.context), true);
    assert.equal(Boolean(grep.inputSchema.properties.count), true);
    assert.equal(Boolean(grep.inputSchema.properties.ignoreCase), true);
    assert.equal(Boolean(grep.inputSchema.properties.regex), true);
    assert.deepEqual(grep.inputSchema.required, ["pattern", "regex"]);
    assert.equal(grep.inputSchema.required.includes("fuzzy"), false);
    assert.equal(Boolean(grep.inputSchema.properties.cursor), true);
    for (const tool of listed.result.tools) {
      assert.equal(Boolean(tool.inputSchema.properties.path), true);
      assert.equal(Boolean(tool.inputSchema.properties.root), true);
      assert.equal(Boolean(tool.inputSchema.properties.cwd), false);
      assert.equal(Boolean(tool.inputSchema.properties.detail), false);
    }
  });
});

test("instructions tell agents to check the root a reply resolved to", async () => {
  await withServer({}, async ({ send, waitFor }) => {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {} },
    });
    const init = await waitFor((message) => message.id === 1);
    assert.match(
      init.result.instructions,
      /first line names the resolved absolute root/,
    );
    assert.match(init.result.instructions, /retry the same call with root/i);
  });
});

test("tool descriptions say when to pass root and how to shape a query", async () => {
  await withServer({}, async ({ send, waitFor }) => {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {} },
    });
    const init = await waitFor((message) => message.id === 1);
    assert.equal(
      init.result.instructions.includes("map of the code to read next"),
      false,
    );
    assert.match(init.result.instructions, /retry the same call with root/i);

    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = await waitFor((message) => message.id === 2);
    const tools = Object.fromEntries(
      listed.result.tools.map((tool) => [tool.name, tool]),
    );
    for (const tool of Object.values(tools)) {
      assert.match(
        tool.inputSchema.properties.root.description,
        /overrides cwd\/Git detection/,
      );
      assert.match(
        tool.inputSchema.properties.path.description,
        /never selects an index/,
      );
      assert.equal(Boolean(tool.inputSchema.properties.cwd), false);
      assert.equal(Boolean(tool.inputSchema.properties.detail), false);
      assert.equal(Boolean(tool.outputSchema), true);
      assert.equal("complete" in (tool.outputSchema.properties || {}), false);
      assert.equal(Boolean(tool.outputSchema.properties.truncated), true);
      assert.match(
        tool.outputSchema.description,
        /ignoring this object only loses machine navigation/,
      );
    }
    assert.match(
      tools.grep.inputSchema.properties.fuzzy.description,
      /Default false/,
    );
    assert.match(
      tools.grep.inputSchema.properties.fuzzy.description,
      /NOT the same identifier/,
    );
    assert.match(tools.grep.inputSchema.properties.regex.description, /not rg/);
    assert.match(tools.grep.inputSchema.properties.regex.description, /Required/);
    assert.equal(
      tools.grep.inputSchema.properties.regex.description.includes("Default false"),
      false,
    );
    assert.equal(
      tools.grep.inputSchema.properties.regex.description.includes("Leave it off"),
      false,
    );
    assert.match(tools.grep.description, /regex is required/);
    assert.match(tools.grep.inputSchema.properties.cursor.description, /opaque/i);
    assert.match(tools.grep.inputSchema.properties.cursor.description, /context/);
    assert.match(tools.grep.inputSchema.properties.cursor.description, /ignoreCase/);
    assert.equal(tools.grep.description.includes("retries as fuzzy"), false);
    assert.match(tools.grep.description, /this is not rg/i);
    assert.match(
      tools.grep.description,
      /do not open host Ripgrep on the same token/i,
    );
    assert.match(tools.grep.description, /pass context \(at most 3\)/i);
    assert.match(tools.grep.description, /not host Read/i);
    assert.match(tools.grep.description, /do not Read hit files whole/);
    assert.match(tools.find.description, /do not find to confirm/);
    assert.match(
      tools.find.description,
      /Pick this when you have a file name or path fragment/,
    );
    assert.match(
      tools.grep.inputSchema.properties.limit.description,
      /1-48/,
    );
    assert.match(
      tools.find.inputSchema.properties.limit.description,
      /1-48/,
    );
    assert.equal(
      tools.find.inputSchema.properties.limit.description,
      tools.grep.inputSchema.properties.limit.description,
    );
    assert.equal(Boolean(tools.find.inputSchema.properties.context), false);
    assert.equal(Boolean(tools.graph.inputSchema.properties.context), false);
    assert.equal(Boolean(tools.find.inputSchema.properties.count), false);
    assert.equal(init.result.instructions.includes("Ripgrep"), false);
    assert.equal(tools.find.description.includes("a or b"), false);
    assert.match(tools.find.description, /not a glob/i);
    assert.match(tools.graph.description, /not an answer or source|a map, not an answer or source/);
    assert.match(tools.graph.description, /where X is defined/);
    assert.match(tools.graph.description, /who calls/);
    assert.match(tools.graph.description, /how-it-works entry span plus direct neighborhood is the locate/);
    assert.doesNotMatch(tools.graph.description, /For how-it-works, Read the entry/);
    assert.doesNotMatch(tools.graph.description, /Read the entry first/);
    assert.match(tools.graph.description, /direct callees, and direct callers/);
    assert.match(tools.graph.description, /There is no callers tool/);
    assert.match(
      tools.grep.inputSchema.properties.pattern.description,
      /literal string/,
    );
    assert.match(
      tools.graph.inputSchema.properties.query.description,
      /a multi-paragraph question does not/,
    );
    assert.match(
      tools.graph.inputSchema.properties.query.description,
      /where X is defined/,
    );
    assert.match(
      tools.graph.inputSchema.properties.query.description,
      /who calls/,
    );
    assert.equal(Boolean(tools.graph.outputSchema.properties.entries), true);
    assert.equal(Boolean(tools.graph.outputSchema.properties.callees), true);
    assert.equal(Boolean(tools.graph.outputSchema.properties.callers), true);
    assert.equal(Boolean(tools.graph.outputSchema.properties.exactHits), false);
    assert.equal(Boolean(tools.grep.outputSchema.properties.nextCursor), true);
  });
});

test("MCP replies start with freshness and keep a graph budget", async () => {
  const section = (path, first) =>
    [
      `**\`${path}\`** — symbol(function), +3 more`,
      "",
      "```javascript",
      ...Array.from({ length: 200 }, (_, i) => `${first + i}\tconst v${i} = ${i};`),
      "```",
      "",
    ].join("\n");
  await withServer(
    {
      query: async (request) => ({
        status: "degraded",
        fffWarning: "stale",
        graphWarning: null,
        lastSuccessfulSync: "2026-09-21T10:00:00.000Z",
        root: "/repo",
        query: request.query,
        result: [
          "Found 40 symbols across 2 files.",
          "",
          "**Source Code**",
          "",
          "> The code below is the **verbatim, current on-disk source** of these files. Treat each block as a Read you have already performed.",
          "",
          section("src/app.ts", 1),
          section("src/auth.ts", 40),
        ].join("\n"),
      }),
    },
    async ({ send, waitFor }) => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {} },
      });
      await waitFor((message) => message.id === 1);
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "graph", arguments: { query: "auth" } },
      });
      const graph = await waitFor((message) => message.id === 2);
      const text = graph.result.content[0].text;
      assert.match(text, /^\[degraded\] root \/repo lastSuccessfulSync /);
      assert.equal(text.includes("```"), false);
      assert.equal(/verbatim/i.test(text), false);
      assert.equal(/already performed/i.test(text), false);
      assert.ok(text.length <= 1_500, `locator map is ${text.length} chars`);
      const payload = graph.result.structuredContent;
      assert.equal("sourceIncluded" in payload, false);
      assert.equal("files" in payload, false);
      assert.equal("complete" in payload, false);
      assert.deepEqual(payload.entries, []);
      assert.match(text, /NO exact hit on auth/);
      assert.equal(text.includes("```"), false);
    },
  );
});

test("machine fields ride structuredContent, not a JSON copy in the text", async () => {
  await withServer(
    {
      query: async (request) => ({
        root: "/repo",
        status: "ready",
        rootSource: "cwd",
        cwdSource: "spawn cwd",
        query: request.query,
        pattern: request.query,
        total: 1,
        shown: 1,
        moreRemain: false,
        mode: "plain",
        results: [
          { path: "src/app.ts", line: 3, column: 5, text: "const app = 1;" },
        ],
      }),
    },
    async ({ send, waitFor }) => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      });
      await waitFor((message) => message.id === 1);
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "grep", arguments: { pattern: "app", regex: false } },
      });
      const grep = await waitFor((message) => message.id === 2);
      const text = grep.result.content[0].text;
      assert.equal("command" in grep.result.structuredContent, false);
      assert.equal(grep.result.structuredContent.truncated, false);
      assert.equal("nextCursor" in grep.result.structuredContent, false);
      assert.deepEqual(grep.result.structuredContent.hits, [
        {
          path: "src/app.ts",
          line: 3,
          column: 5,
          text: "const app = 1;",
          read: { path: "src/app.ts", offset: 1, limit: 11 },
        },
      ]);
      assert.equal(text.includes('"hits"'), false);
      assert.equal(text.includes('"command": "grep"'), false);
      assert.match(text, /^src\/app\.ts:3 const app = 1;$/m);
    },
  );
});

test("grep only goes fuzzy when the call asks for it", async () => {
  const seen = [];
  await withServer(
    {
      query: async (request) => {
        seen.push(request);
        return {
          root: "/repo",
          status: "ready",
          pattern: request.query,
          mode: "plain",
          shown: 0,
          moreRemain: false,
          results: [],
        };
      },
    },
    async ({ send, waitFor }) => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      });
      await waitFor((message) => message.id === 1);
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "grep", arguments: { pattern: "PG_DATABASE_URL", regex: false } },
      });
      const plain = await waitFor((message) => message.id === 2);
      assert.equal(seen[0].fuzzy, undefined);
      assert.equal(seen[0].regex, false);
      assert.equal(plain.result.content[0].text.split("\n")[0].includes("[fuzzy]"), false);
      assert.match(plain.result.content[0].text, /0 matches/);
      assert.match(plain.result.content[0].text, /check root above/);
      assert.match(plain.result.content[0].text, /fuzzy:true/);
      assert.equal(plain.result.content[0].text.includes("regex"), false);

      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "grep",
          arguments: { pattern: "PG_DATABASE_URL", regex: false, fuzzy: true },
        },
      });
      await waitFor((message) => message.id === 3);
      assert.equal(seen[1].fuzzy, true);
    },
  );
});

test("grep cursor errors surface as tool errors, not page 1", async () => {
  const { GREP_CURSOR_ERROR } = await import("../src/grep-cursor.js");
  await withServer(
    {
      query: async (request) => {
        if (request.cursor) throw new Error(GREP_CURSOR_ERROR);
        return { root: "/repo", status: "ready", results: [] };
      },
    },
    async ({ send, waitFor }) => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      });
      await waitFor((message) => message.id === 1);
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "grep",
          arguments: { pattern: "TODO", regex: false, cursor: "not-a-cursor" },
        },
      });
      const reply = await waitFor((message) => message.id === 2);
      assert.equal(reply.result.isError, true);
      assert.equal(reply.result.content[0].text, GREP_CURSOR_ERROR);
    },
  );
});

test("initialize instructions tell agents to pass path or root from HOME", async () => {
  await withServer(
    { cwd: homedir() },
    async ({ send, waitFor }) => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {} },
      });
      const init = await waitFor((message) => message.id === 1);
      assert.match(init.result.instructions, /Indexing starts on tools\/call/);
      assert.match(init.result.instructions, /pass path or root/i);
    },
  );
});

test("README default MCP snippet is the wrapper, no npx, no cwd field", () => {
  const readme = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"),
    "utf8",
  );
  assert.equal(readme.includes("CODEQ_CWD"), true);
  assert.match(readme, /Do not set `CODEQ_CWD`/);
  const firstSnippet = readme.split("```json")[1].split("```")[0];
  assert.match(firstSnippet, /"command": "codeq-mcp"/);
  assert.match(firstSnippet, /"args": \["\$\{workspaceFolder\}"\]/);
  assert.equal(firstSnippet.includes("npx"), false);
  assert.equal(firstSnippet.includes('"cwd"'), false);
  assert.equal(firstSnippet.includes("CODEQ_CWD"), false);
  assert.match(readme, /npx steals stdin/);
  assert.match(readme, /codeq-mcp/);
  assert.match(readme, new RegExp(`@zj669\\/codeq@${version.replaceAll(".", "\\.")}`));
  assert.match(readme, /docs\/mcp-install\.md/);
  assert.equal(readme.includes("leagent"), false);
  assert.equal(readme.includes("npx -y"), false);
});

test("repo MCP install guide covers harness clients without a second wrapper", () => {
  const guide = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "mcp-install.md"),
    "utf8",
  );
  assert.match(guide, new RegExp(`@zj669\\/codeq@${version.replaceAll(".", "\\.")}`));
  assert.match(
    guide,
    /claude mcp add --scope user --transport stdio codeq -- codeq mcp/,
  );
  assert.match(guide, /codex mcp add codeq -- codeq mcp/);
  assert.match(guide, /gemini mcp add -s user -t stdio codeq codeq mcp/);
  assert.match(guide, /agy mcp add -t stdio codeq codeq mcp/);
  assert.match(guide, /opencode mcp add codeq -- codeq mcp/);
  assert.match(guide, /"command": "codeq-mcp"/);
  assert.match(guide, /src\/pkg\/foo\.py/);
  assert.match(guide, /相对路径接到这次选中的 `root`/);
  assert.equal(guide.includes("leagent"), false);
  assert.equal(guide.includes("npx -y"), false);
  assert.equal(guide.includes('"command": "npx"'), false);
  assert.equal(guide.includes("codeq-mcp-framing"), false);
  assert.match(guide, /不要再套一层/);
  assert.match(guide, /Do not set `CODEQ_CWD`|不要.*设 `CODEQ_CWD`/);
});
