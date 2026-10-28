import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createFramedParser, encodeMessage } from "../src/mcp.js";
import { isSidecarTail } from "../src/sidecar.js";

const bin = fileURLToPath(new URL("../bin/codeq.js", import.meta.url));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function waitFor(messages, predicate, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const match = messages.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for MCP message: ${JSON.stringify(messages)}`);
}

test("MCP find/grep/graph reuse the daemon and do not write .codegraph", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "codeq-mcp-it-"));
  const repo = join(parent, "app");
  const dataDir = join(parent, "data");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(
    join(repo, "src", "session.ts"),
    "export function createSession() { return { id: 1 }; }\n",
  );
  git(repo, "init", "-b", "main");
  git(repo, "add", ".");
  git(
    repo,
    "-c",
    "user.name=codeq-test",
    "-c",
    "user.email=codeq@example.invalid",
    "commit",
    "-m",
    "fixture",
  );

  const child = spawn(process.execPath, [bin, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: repo,
    env: { ...process.env, CODEQ_DATA_DIR: dataDir },
  });
  t.after(() => {
    child.kill("SIGTERM");
    const pidFile = join(dataDir, "daemon", "daemon.pid");
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(pid) && pid > 1) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
    }
  });

  const messages = [];
  const parse = createFramedParser((message) => messages.push(message));
  child.stdout.on("data", (chunk) => parse(chunk));
  const send = (message) => child.stdin.write(encodeMessage(message));

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "codeq-live", version: "0" },
    },
  });
  await waitFor(messages, (message) => message.id === 1, 5_000);

  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "find", arguments: { query: "session.ts" } },
  });
  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "grep", arguments: { pattern: "createSess.*", regex: false } },
  });
  send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "graph", arguments: { query: "createSession" } },
  });
  send({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "grep", arguments: { pattern: ".*", regex: true } },
  });
  send({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: {
      name: "grep",
      arguments: { pattern: "createSess.*", regex: true },
    },
  });
  const find = await waitFor(messages, (message) => message.id === 2, 30_000);
  const literalDots = await waitFor(messages, (message) => message.id === 3, 30_000);
  const graph = await waitFor(messages, (message) => message.id === 4, 120_000);
  const wildcard = await waitFor(messages, (message) => message.id === 5, 10_000);
  const regexGrep = await waitFor(messages, (message) => message.id === 9, 30_000);

  const findPayload = find.result.structuredContent;
  const grepPayload = regexGrep.result.structuredContent;
  const graphPayload = graph.result.structuredContent;

  assert.equal(find.result.isError, undefined);
  assert.equal(regexGrep.result.isError, undefined);
  assert.equal(graph.result.isError, undefined, graph.result.content[0].text);
  assert.match(find.result.content[0].text, /^\[(ready|indexing|degraded)\]/);
  assert.match(find.result.content[0].text, /lastSuccessfulSync|root /);
  assert.equal(findPayload.command, undefined);
  assert.ok(findPayload.paths?.some((item) => item.endsWith("session.ts")));
  assert.match(find.result.content[0].text, /^src\/session\.ts$/m);

  assert.equal(literalDots.result.isError, undefined);
  assert.equal(literalDots.result.structuredContent.hits.length, 0);
  assert.match(literalDots.result.content[0].text, /0 matches/);
  assert.match(literalDots.result.content[0].text, /regex:true if this was a regular expression/);

  assert.ok(grepPayload.hits.some((item) => item.path.endsWith("session.ts")));
  assert.equal("mode" in grepPayload, false);
  assert.equal(regexGrep.result.content[0].text.includes("[fuzzy]"), false);
  assert.match(regexGrep.result.content[0].text, /^src\/session\.ts:1 /m);

  const graphText = graph.result.content[0].text;
  assert.equal(graphText.includes("```"), false);
  assert.equal(/verbatim/i.test(graphText), false);
  assert.equal(/already performed/i.test(graphText), false);
  assert.equal(graphText.includes("codegraph_explore"), false);
  assert.match(graphText, /exact createSession/);
  assert.match(graphText, /createSession/);
  assert.equal(graphText.includes("open these files"), false);
  assert.equal("sourceIncluded" in graphPayload, false);
  assert.equal("files" in graphPayload, false);
  assert.ok(
    graphPayload.entries.some((entry) => entry.path.endsWith("session.ts")),
  );
  assert.ok(graphPayload.entries.every((entry) => !entry.path.startsWith("../")));
  assert.equal(wildcard.result.isError, true);
  assert.match(wildcard.result.content[0].text, /matches everything/);

  send({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "graph", arguments: { query: "createSession", detail: "full" } },
  });
  send({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "grep", arguments: { pattern: "createSessionn", regex: false } },
  });
  send({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "grep", arguments: { pattern: "createSessionn", regex: false, fuzzy: true } },
  });

  const graphFull = await waitFor(messages, (message) => message.id === 6, 120_000);
  const fullText = graphFull.result.content[0].text;
  assert.equal("sourceIncluded" in graphFull.result.structuredContent, false);
  assert.equal(fullText.includes("```"), false);
  const stripSidecar = (text) =>
    String(text)
      .split("\n")
      .filter((line) => !isSidecarTail(line))
      .join("\n");
  assert.equal(
    stripSidecar(fullText.split("\n").slice(1).join("\n")),
    stripSidecar(graph.result.content[0].text.split("\n").slice(1).join("\n")),
  );
  assert.equal(fullText.split("\n").some(isSidecarTail), true);
  assert.equal(graph.result.content[0].text.split("\n").some(isSidecarTail), true);

  const typo = await waitFor(messages, (message) => message.id === 7, 30_000);
  assert.equal(typo.result.structuredContent.hits.length, 0);
  assert.equal(typo.result.content[0].text.split("\n")[0].includes("[fuzzy]"), false);
  assert.match(typo.result.content[0].text, /0 matches/);
  assert.equal(typo.result.content[0].text.includes("regex"), false);
  assert.match(typo.result.content[0].text, /fuzzy:true/);

  const approximate = await waitFor(messages, (message) => message.id === 8, 30_000);
  assert.equal("mode" in approximate.result.structuredContent, false);
  assert.match(approximate.result.content[0].text.split("\n")[0], /^\[\w+\]\[fuzzy\]/);
  assert.match(approximate.result.content[0].text, /DIFFERENT identifiers/);

  assert.equal(existsSync(join(repo, ".codegraph")), false);
});

test("MCP grep context, count, and ignoreCase reach the daemon", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "codeq-mcp-ux-"));
  const repo = join(parent, "app");
  const dataDir = join(parent, "data");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(
    join(repo, "src", "review.ts"),
    [
      "const before = 1;",
      "export class AgentReview {",
      "  ok = true;",
      "}",
      "const after = 2;",
      "",
    ].join("\n"),
  );
  git(repo, "init", "-b", "main");
  git(repo, "add", ".");
  git(
    repo,
    "-c",
    "user.name=codeq-test",
    "-c",
    "user.email=codeq@example.invalid",
    "commit",
    "-m",
    "fixture",
  );

  const child = spawn(process.execPath, [bin, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: repo,
    env: { ...process.env, CODEQ_DATA_DIR: dataDir },
  });
  t.after(() => {
    child.kill("SIGTERM");
    const pidFile = join(dataDir, "daemon", "daemon.pid");
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(pid) && pid > 1) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
    }
  });

  const messages = [];
  const parse = createFramedParser((message) => messages.push(message));
  child.stdout.on("data", (chunk) => parse(chunk));
  const send = (message) => child.stdin.write(encodeMessage(message));

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "codeq-live-ux", version: "0" },
    },
  });
  await waitFor(messages, (message) => message.id === 1, 5_000);

  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "grep", arguments: { pattern: "AgentReview", regex: false, context: 2 } },
  });
  const neighbors = await waitFor(messages, (message) => message.id === 2, 30_000);
  assert.equal(neighbors.result.isError, undefined, neighbors.result.content[0].text);
  assert.match(neighbors.result.content[0].text.split("\n")[0], /root /);
  assert.match(neighbors.result.content[0].text, /via /);
  assert.match(neighbors.result.content[0].text, /const before = 1;/);
  assert.match(neighbors.result.content[0].text, /export class AgentReview \{/);
  assert.match(neighbors.result.content[0].text, /ok = true;/);

  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "grep", arguments: { pattern: "agentreview", regex: false } },
  });
  const smart = await waitFor(messages, (message) => message.id === 3, 30_000);
  assert.ok(smart.result.structuredContent.hits.length > 0, smart.result.content[0].text);

  send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "grep",
      arguments: { pattern: "agentreview", regex: false, ignoreCase: false },
    },
  });
  const sensitive = await waitFor(messages, (message) => message.id === 4, 30_000);
  assert.equal(sensitive.result.structuredContent.hits.length, 0, sensitive.result.content[0].text);

  send({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "grep", arguments: { pattern: "AgentReview", regex: false, count: true } },
  });
  const counted = await waitFor(messages, (message) => message.id === 5, 30_000);
  assert.deepEqual(counted.result.structuredContent.hits, []);
  assert.ok(counted.result.structuredContent.matchCount >= 1);
  assert.match(counted.result.content[0].text, /match(?:es)? in \d+ files?/);
  assert.equal(counted.result.content[0].text.includes("export class"), false);
});

test("MCP truncated grep continues through truncation.retry and returns the omitted hits", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "codeq-mcp-retry-"));
  const repo = join(parent, "app");
  const dataDir = join(parent, "data");
  mkdirSync(join(repo, "src"), { recursive: true });
  // One identifier on every line of 20 files: a single grep page (16) cannot
  // hold them all, so the first reply must truncate.
  for (let index = 0; index < 20; index += 1) {
    writeFileSync(
      join(repo, "src", `f${index}.ts`),
      `export const needle_marker_${index} = ${index};\n`,
    );
  }
  git(repo, "init", "-b", "main");
  git(repo, "add", ".");
  git(
    repo,
    "-c",
    "user.name=codeq-test",
    "-c",
    "user.email=codeq@example.invalid",
    "commit",
    "-m",
    "fixture",
  );

  const child = spawn(process.execPath, [bin, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: repo,
    env: { ...process.env, CODEQ_DATA_DIR: dataDir },
  });
  t.after(() => {
    child.kill("SIGTERM");
    const pidFile = join(dataDir, "daemon", "daemon.pid");
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(pid) && pid > 1) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
    }
  });

  const messages = [];
  const parse = createFramedParser((message) => messages.push(message));
  child.stdout.on("data", (chunk) => parse(chunk));
  const send = (message) => child.stdin.write(encodeMessage(message));

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "codeq-live-retry", version: "0" },
    },
  });
  await waitFor(messages, (message) => message.id === 1, 5_000);

  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "grep",
      arguments: { pattern: "needle_marker", regex: false, context: 0 },
    },
  });
  const first = await waitFor(messages, (message) => message.id === 2, 60_000);
  const page = first.result.structuredContent;
  assert.equal(page.truncated, true, first.result.content[0].text);
  assert.equal(page.hits.length, 16);
  assert.ok(page.truncation, "truncated reply carries truncation");
  // The continuation is executable as-is: merge retry into the same call.
  assert.deepEqual(Object.keys(page.truncation.retry), ["cursor"]);
  const seen = new Set(page.hits.map((hit) => hit.path));

  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "grep",
      arguments: {
        pattern: "needle_marker",
        regex: false,
        context: 0,
        ...page.truncation.retry,
      },
    },
  });
  const second = await waitFor(messages, (message) => message.id === 3, 60_000);
  const next = second.result.structuredContent;
  assert.equal(second.result.isError, undefined, second.result.content[0].text);
  // Page 2 is exactly the hits page 1 omitted — no overlap, full coverage.
  assert.equal(next.hits.length, 4);
  for (const hit of next.hits) {
    assert.equal(seen.has(hit.path), false, `${hit.path} was already on page 1`);
    seen.add(hit.path);
  }
  assert.equal(seen.size, 20);
  assert.equal(next.truncated, false);
  assert.equal("truncation" in next, false);
});
