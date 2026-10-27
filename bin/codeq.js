#!/usr/bin/env node

import { queryDaemon } from "../src/client.js";
import { formatMcpToolResult, freshnessLine } from "../src/mcp-format.js";
import { runMcpServer } from "../src/mcp.js";
import { maybeRerank } from "../src/jev.js";

const USAGE = `Usage:
  codeq [--root PATH] [--json] find  <query>   [--path PATH] [--limit N]
  codeq [--root PATH] [--json] grep  <pattern> [--path PATH] [--glob GLOB] [--context N] [--limit N] [--count] [--ignore-case] [--case-sensitive] [--regex] [--fuzzy] [--cursor TOKEN]
  codeq [--root PATH] [--json] graph <query>   [--path PATH]
  codeq mcp

Human output is the locator map the MCP tools return: the resolved root on
stderr, then the files or spans to open next. --json is the daemon/diagnostic
result (including explore dump and jev metadata) after the same rerank.`;

const MCP_USAGE = `Usage:
  codeq mcp

Run a stdio MCP server that exposes find, grep, and graph. The server reuses
the per-user codeq daemon. Handshake (initialize / tools/list) does not index.
Indexing starts on the first tools/call that has a real target: path/root on
that call, else roots/list if the client gave a non-HOME folder, else a spawn
cwd that is not $HOME or /. For Cursor, run the codeq-mcp wrapper (Node 22,
no npx) rather than this command directly. Pass path or root to search a
different repository.`;

function fail(message, code = 2) {
  process.stderr.write(`codeq: ${message}\n\n${USAGE}\n`);
  process.exit(code);
}

function positiveInteger(value, name, allowZero = false) {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    (allowZero ? parsed < 0 : parsed < 1)
  ) {
    fail(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return parsed;
}

function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (argv.length === 0) fail("a command is required");

  const commands = new Set(["find", "grep", "graph"]);
  const commandIndex = argv.findIndex((arg) => commands.has(arg));
  if (commandIndex < 0) fail(`unknown command: ${argv.find((arg) => !arg.startsWith("-")) || argv[0]}`);
  const command = argv[commandIndex];
  const options = {
    command,
    cwd: process.cwd(),
    cwdSource: "shell cwd",
    json: false,
  };
  const positionals = [];
  const takesValue = new Set([
    "--root",
    "--path",
    "--limit",
    "--glob",
    "--context",
    "--cursor",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    if (index === commandIndex) continue;
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--count") {
      if (command !== "grep") fail("--count is not valid for " + command);
      options.count = true;
      continue;
    }
    if (arg === "--ignore-case") {
      if (command !== "grep") fail("--ignore-case is not valid for " + command);
      if (options.ignoreCase === false) {
        fail("cannot use --ignore-case and --case-sensitive together");
      }
      options.ignoreCase = true;
      continue;
    }
    if (arg === "--case-sensitive") {
      if (command !== "grep") fail("--case-sensitive is not valid for " + command);
      if (options.ignoreCase === true) {
        fail("cannot use --ignore-case and --case-sensitive together");
      }
      options.ignoreCase = false;
      continue;
    }
    if (arg === "--fuzzy") {
      if (command !== "grep") fail("--fuzzy is not valid for " + command);
      options.fuzzy = true;
      continue;
    }
    if (arg === "--regex") {
      if (command !== "grep") fail("--regex is not valid for " + command);
      options.regex = true;
      continue;
    }
    if (arg === "--full" || arg === "--detail") {
      fail(
        "0.3.13 has no --full or --detail; replies are locators (use --json for the daemon dump)",
      );
    }
    if (takesValue.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        fail(`${arg} requires a value`);
      }
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) fail(`unknown option: ${arg}`);
    positionals.push(arg);
  }

  if (positionals.length === 0) fail(`${command} requires a query`);
  options.query = positionals.join(" ");

  const valid = {
    find: new Set(["root", "path", "limit"]),
    grep: new Set(["root", "path", "glob", "context", "limit", "cursor"]),
    graph: new Set(["root", "path"]),
  }[command];
  for (const key of ["root", "path", "limit", "glob", "context", "cursor"]) {
    if (options[key] !== undefined && !valid.has(key)) {
      fail(`--${key} is not valid for ${command}`);
    }
  }
  if (options.limit !== undefined) {
    options.limit = positiveInteger(options.limit, "--limit");
  }
  if (options.context !== undefined) {
    options.context = positiveInteger(options.context, "--context", true);
  }
  return options;
}

function printStatus(result) {
  process.stderr.write(`${freshnessLine(result)}\n`);
}

function printHuman(command, result) {
  printStatus(result);
  const formatted = formatMcpToolResult(command, result);
  process.stdout.write(`${formatted.map}\n`);
}

async function runCli(argv) {
  const request = parseArguments(argv);
  const { json, ...wireRequest } = request;
  const controller = new AbortController();
  const cancel = () => {
    controller.abort();
    process.exit(130);
  };
  process.once("SIGINT", cancel);
  const result = await queryDaemon(wireRequest, {
    signal: controller.signal,
    onProgress: (message) => {
      const detail =
        message.message ||
        `${message.phase}${message.total ? ` ${message.current}/${message.total}` : ""}`;
      process.stderr.write(`[indexing] ${detail}\n`);
    },
  });
  process.removeListener("SIGINT", cancel);
  const ranked = await maybeRerank(request.command, wireRequest, result);
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ command: request.command, ...ranked }, null, 2)}\n`,
    );
  } else {
    printHuman(request.command, ranked);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "mcp") {
    const rest = argv.slice(1);
    if (rest.includes("--help") || rest.includes("-h")) {
      process.stdout.write(`${MCP_USAGE}\n`);
      process.exit(0);
    }
    if (rest.length > 0) fail("mcp does not take additional arguments");
    await runMcpServer();
    return;
  }
  await runCli(argv);
}

main().catch((error) => {
  process.stderr.write(`codeq: ${error.message}\n`);
  process.exit(1);
});
