import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { queryDaemon } from "./client.js";
import { GREP_CONTEXT_DEFAULT } from "./limits.js";
import {
  EMPTY_TOOL_MENU,
  formatMcpToolResult,
  MCP_INSTRUCTIONS,
  requireGrepRegex,
} from "./mcp-format.js";
import { isUnusableWorkspace } from "./paths.js";
import { maybeRerank } from "./jev.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

const ROOTS_LIST_TIMEOUT_MS = 5_000;

const PATH_PROPERTY = {
  type: "string",
  description:
    "Narrow this call inside the selected root; never selects an index. Relative paths are relative to that root.",
};

const ROOT_PROPERTY = {
  type: "string",
  description:
    "Repository/checkout/worktree for this call; overrides cwd/Git detection. Set it for cross-repo/worktree queries.",
};

export const NO_WORKSPACE_ERROR =
  "no workspace (spawned from home). Pass path or root to a repository on this call.";

const LIMIT_PROPERTY = {
  type: "integer",
  minimum: 1,
  description:
    "Page size 1-48 (default 16). Values above 48 are capped; use cursor for more.",
};

const LOCATOR_SCHEMA = {
  status: { type: ["string", "null"] },
  root: { type: ["string", "null"] },
  truncated: { type: "boolean" },
  indexReady: {
    type: "boolean",
    description:
      "false while the index is still building or degraded — results are provisional, retry the query when status is ready.",
  },
  poolBusy: {
    type: "boolean",
    description:
      "true when several distinct roots are being indexed at once. One call still serves exactly one root; retry later or pass root to narrow.",
  },
  stalePaths: {
    type: "array",
    description:
      "Files that changed on disk after the index was built; locators in them may have drifted — Read the file to confirm.",
    items: { type: "string" },
  },
};

const OUTPUT_SCHEMA_NOTE =
  "Text has the retrieval facts; ignoring this object only loses machine navigation, pagination, and diagnostics.";

const TRUNCATION_SCHEMA = {
  type: "object",
  description:
    "Present only when truncated is true. The page is partial: re-issue the same tool once with retry merged into the arguments — it is the continuation, already computed. shown is this page's locator count, total/remaining when known, next describes the retry. Do not re-run the query unchanged or re-check with host tools.",
  properties: {
    shown: { type: "integer" },
    total: { type: "integer" },
    remaining: { type: "integer" },
    omitted: { type: "object" },
    next: { type: "string" },
    retry: {
      type: "object",
      description:
        "Arguments to merge into the same tool's arguments for the one continuation call — e.g. {cursor} for grep, {limit} or {path} for find, {query} or {path} for graph. Absent when nothing narrower is known; the text then carries the only advice.",
    },
  },
  required: ["shown", "next"],
};

const TOOLS = [
  {
    name: "find",
    title: "Find files",
    description:
      "Pick this when you have a file name or path fragment and need its real path — it answers 'where is X' in one call where host Glob or shell ls/find would scan. Fuzzy file/path lookup, including dotfiles. Query is a path fragment, not a glob. If you already know the directory and filename, Read it; do not find to confirm.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Path fragment, matched fuzzily (foo.py, profiles/app, SKILL.md). Not a glob: pass profile, not **/*profile*. Dotfiles are indexed.",
        },
        path: PATH_PROPERTY,
        root: ROOT_PROPERTY,
        limit: LIMIT_PROPERTY,
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      description: OUTPUT_SCHEMA_NOTE,
      properties: {
        ...LOCATOR_SCHEMA,
        paths: { type: "array", items: { type: "string" } },
        truncation: TRUNCATION_SCHEMA,
        globFallback: {
          type: "object",
          properties: {
            from: { type: "string" },
            to: { type: "string" },
          },
        },
      },
      required: ["status", "root", "truncated", "paths"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "grep",
    title: "Search file contents",
    description:
      "Content search; this is not rg. regex is required: false for a literal string, true for a regular expression. After this pattern has already returned locators, do not open host Ripgrep on the same token. Pass fuzzy:true for approximate/different identifiers. Each hit shows one neighbor line by default; pass context (at most 3) for more, 0 for locators only; this is not rg and not host Read. After locators are returned, do not Read hit files whole — each hit carries read:{path,offset,limit} for the host Read tool. Do not find that basename. Returns matching lines.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "literal string when regex is false. This is not rg: dots, brackets, and $ are literal unless regex is true.",
        },
        path: PATH_PROPERTY,
        root: ROOT_PROPERTY,
        glob: {
          type: "string",
          description: "Optional glob used to constrain matches, for example **/*.ts",
        },
        regex: {
          type: "boolean",
          description:
            "Required. true = regular expression; false = literal. foo.ts, process.env, and array[0] are literals. This is not rg.",
        },
        fuzzy: {
          type: "boolean",
          description:
            "Default false. Approximate matching for different identifiers, labelled [fuzzy]. NOT the same identifier.",
        },
        cursor: {
          type: "string",
          description:
            "Opaque continuation from a previous grep nextCursor. Bound to the same root, pattern, glob, path, regex, fuzzy, context, and ignoreCase. A mismatch is an error, not page 1.",
        },
        limit: LIMIT_PROPERTY,
        context: {
          type: "integer",
          minimum: 0,
          description:
            "Neighboring source lines around each hit. Default 1, maximum 3; pass 0 for locators only. Not rg and not host Read.",
        },
        count: {
          type: "boolean",
          description:
            "When true, return match and file counts only, with no locators. Ignores context. Does not accept cursor.",
        },
        ignoreCase: {
          type: "boolean",
          description:
            "This is not rg. Omit for smart-case; true forces case-insensitive matching; false is case-sensitive.",
        },
      },
      required: ["pattern", "regex"],
    },
    outputSchema: {
      type: "object",
      description: OUTPUT_SCHEMA_NOTE,
      properties: {
        ...LOCATOR_SCHEMA,
        hits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              line: { type: "integer" },
              column: { type: "integer" },
              text: { type: "string" },
              read: {
                type: "object",
                description:
                  "Host Read parameters for this hit: path, offset, limit. Use instead of reading the whole file.",
                properties: {
                  path: { type: "string" },
                  offset: { type: "integer" },
                  limit: { type: "integer" },
                },
              },
              stale: {
                type: "boolean",
                description:
                  "The file changed after the index; this line may have drifted — Read the file to confirm.",
              },
              before: { type: "array", items: { type: "string" } },
              after: { type: "array", items: { type: "string" } },
            },
          },
        },
        nextCursor: { type: "string" },
        truncation: TRUNCATION_SCHEMA,
        matchCount: { type: "integer" },
        fileCount: { type: "integer" },
      },
      required: ["status", "root", "truncated", "hits"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "graph",
    title: "Explore the code graph",
    description:
      'Pick this when the question names a symbol: an identifier, or a short question about how X works, where X is defined, or who calls / uses X — it answers these in one call where grep would take several. Returns an entry span, direct callees, and direct callers — a map, not an answer or source. The how-it-works entry span plus direct neighborhood is the locate; if you still Read, Read only that span, not the whole file; do not then find or grep the same name. For who-calls or where-used, use the callers locators; do not grep that name first. Bounded neighborhood, not an exhaustive callgraph. There is no callers tool.',
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Identifiers, or a short question about how X works, where X is defined, or who calls / uses X. Identifier-shaped queries match the graph; a multi-paragraph question does not.',
        },
        path: PATH_PROPERTY,
        root: ROOT_PROPERTY,
        wait: {
          type: "boolean",
          description:
            "Default true. On a fresh repository the first graph call blocks while the index builds (seconds). Pass wait:false to get a provisional reply immediately — indexReady false — and retry the same call once status is ready. Only this call is affected.",
        },
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      description: OUTPUT_SCHEMA_NOTE,
      properties: {
        ...LOCATOR_SCHEMA,
        entries: {
          type: "array",
          description:
            "Exact identifier hits, pinned first. Empty when there is no exact hit. When spanCapped is true the definition was too long to read as one span: startLine-endLine is only its head, the full definition ends at definitionEndLine, and members lists the way in.",
          items: {
            type: "object",
            properties: {
              symbol: { type: "string" },
              path: { type: "string" },
              startLine: { type: "integer" },
              endLine: { type: "integer" },
              stale: { type: "boolean" },
              kind: { type: "string" },
              spanCapped: { type: "boolean" },
              definitionEndLine: { type: "integer" },
              definitionLines: { type: "integer" },
            },
          },
        },
        members: {
          type: "array",
          description:
            "Callable entry points inside a spanCapped entry, most-called first. Read one of these instead of the whole definition.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              path: { type: "string" },
              line: { type: "integer" },
              endLine: { type: "integer" },
              stale: { type: "boolean" },
            },
          },
        },
        callees: {
          type: "array",
          description:
            "Direct callees of the reading entries: name, file, and definition line.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              path: { type: "string" },
              line: { type: "integer" },
              endLine: { type: "integer" },
              stale: { type: "boolean" },
            },
          },
        },
        callers: {
          type: "array",
          description:
            "Direct callers of the reading entries: name, file, and definition line.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              path: { type: "string" },
              line: { type: "integer" },
              endLine: { type: "integer" },
              stale: { type: "boolean" },
            },
          },
        },
        truncation: TRUNCATION_SCHEMA,
      },
      required: ["status", "root", "truncated", "entries"],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
];

export function negotiateProtocolVersion(requested) {
  if (PROTOCOL_VERSIONS.includes(requested)) return requested;
  return PROTOCOL_VERSIONS[0];
}

export function encodeMessage(message, framing = "content-length") {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (framing === "ndjson") {
    return Buffer.concat([body, Buffer.from("\n", "utf8")]);
  }
  if (framing !== "content-length") {
    throw new Error(`unknown MCP framing: ${framing}`);
  }
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
    body,
  ]);
}

function parseJsonMessage(raw, framing) {
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch (error) {
    error.framing = framing;
    throw error;
  }
}

export function createFramedParser(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      let start = 0;
      while (
        start < buffer.length &&
        (buffer[start] === 0x0a || buffer[start] === 0x0d)
      ) {
        start += 1;
      }
      if (start > 0) buffer = buffer.subarray(start);
      if (buffer.length === 0) return;

      if (buffer[0] === 0x7b || buffer[0] === 0x5b) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        let line = buffer.subarray(0, newline);
        if (line.length > 0 && line[line.length - 1] === 0x0d) {
          line = line.subarray(0, line.length - 1);
        }
        buffer = buffer.subarray(newline + 1);
        onMessage(parseJsonMessage(line, "ndjson"), "ndjson");
        continue;
      }

      const headerEnd = findHeaderEnd(buffer);
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const length = parseContentLength(header);
      if (length === null) {
        const error = new Error("MCP message is missing Content-Length");
        error.framing = "content-length";
        throw error;
      }
      const bodyStart = headerEnd;
      if (buffer.length < bodyStart + length) return;
      const body = buffer.subarray(bodyStart, bodyStart + length);
      buffer = buffer.subarray(bodyStart + length);
      onMessage(parseJsonMessage(body, "content-length"), "content-length");
    }
  };
}

function findHeaderEnd(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf >= 0) return crlf + 4;
  const lf = buffer.indexOf("\n\n");
  if (lf >= 0) return lf + 2;
  return -1;
}

function parseContentLength(header) {
  for (const line of header.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    if (name === "content-length") {
      const value = Number(line.slice(separator + 1).trim());
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`invalid Content-Length: ${line}`);
      }
      return value;
    }
  }
  return null;
}

function defaultCwd(override) {
  if (override) return override;
  return process.cwd();
}

function fileUriToPath(uri) {
  if (typeof uri !== "string" || !uri.startsWith("file:")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

function positiveInteger(value, name, allowZero = false) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    (allowZero ? parsed < 0 : parsed < 1)
  ) {
    throw new Error(
      `${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`,
    );
  }
  return parsed;
}

function toolRequest(name, args, cwd) {
  if (name === "find") {
    if (typeof args.query !== "string" || args.query.trim() === "") {
      throw new Error(EMPTY_TOOL_MENU);
    }
    const request = {
      command: "find",
      cwd,
      query: args.query,
    };
    if (args.path !== undefined) request.path = String(args.path);
    if (args.root !== undefined) request.root = String(args.root);
    if (args.limit !== undefined) {
      request.limit = positiveInteger(args.limit, "limit");
    }
    return request;
  }
  if (name === "grep") {
    if (typeof args.pattern !== "string" || args.pattern.trim() === "") {
      throw new Error(EMPTY_TOOL_MENU);
    }
    const request = {
      command: "grep",
      cwd,
      query: args.pattern,
    };
    if (args.path !== undefined) request.path = String(args.path);
    if (args.root !== undefined) request.root = String(args.root);
    if (args.glob !== undefined) request.glob = String(args.glob);
    if (args.fuzzy !== undefined) request.fuzzy = Boolean(args.fuzzy);
    request.regex = requireGrepRegex(args.regex);
    if (args.cursor !== undefined) request.cursor = String(args.cursor);
    if (args.limit !== undefined) {
      request.limit = positiveInteger(args.limit, "limit");
    }
    if (args.context !== undefined) {
      request.context = positiveInteger(args.context, "context", true);
    } else if (args.count !== true && args.cursor === undefined) {
      // Cursor calls omit context on purpose: the bound token carries it.
      request.context = GREP_CONTEXT_DEFAULT;
    }
    if (args.count !== undefined) request.count = Boolean(args.count);
    if (args.ignoreCase !== undefined) {
      request.ignoreCase = Boolean(args.ignoreCase);
    }
    return request;
  }
  if (name === "graph") {
    if (typeof args.query !== "string" || args.query.trim() === "") {
      throw new Error(EMPTY_TOOL_MENU);
    }
    const request = {
      command: "graph",
      cwd,
      query: args.query,
    };
    if (args.path !== undefined) request.path = String(args.path);
    if (args.root !== undefined) request.root = String(args.root);
    if (args.wait !== undefined) request.wait = Boolean(args.wait);
    return request;
  }
  throw new Error(`unknown tool: ${name}`);
}

function jsonRpcError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

export function createMcpServer({
  query = queryDaemon,
  cwd: fallbackCwd,
  rerank = maybeRerank,
} = {}) {
  const spawnCwd = defaultCwd(fallbackCwd);
  let workspaceCwd = isUnusableWorkspace(spawnCwd) ? null : spawnCwd;
  let workspaceCwdSource = workspaceCwd ? "spawn cwd" : null;
  let clientSupportsRoots = false;
  let rootsPromise = Promise.resolve();
  const pending = new Map();
  const inFlight = new Map();
  let nextServerId = 1;
  let send = () => {};

  const serverInfo = {
    name: "codeq",
    version,
  };

  async function requestClient(method, params, timeoutMs, framing) {
    const id = `codeq-${nextServerId++}`;
    const result = new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      if (timeoutMs) {
        waiter.timer = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          reject(new Error(`${method} timeout`));
        }, timeoutMs);
      }
      pending.set(id, waiter);
    });
    send({ jsonrpc: "2.0", id, method, params }, framing);
    return result;
  }

  async function refreshRoots(framing) {
    if (!clientSupportsRoots) return;
    try {
      const result = await requestClient(
        "roots/list",
        undefined,
        ROOTS_LIST_TIMEOUT_MS,
        framing,
      );
      const roots = result?.roots || [];
      for (const entry of roots) {
        const path = fileUriToPath(entry?.uri);
        if (path && !isUnusableWorkspace(path)) {
          workspaceCwd = path;
          workspaceCwdSource = "roots/list";
          return;
        }
      }
    } catch {}
  }

  function sessionCwd(args) {
    if (args?.cwd != null && String(args.cwd).trim() !== "") {
      if (!isUnusableWorkspace(args.cwd)) {
        return { cwd: String(args.cwd), source: "cwd argument" };
      }
    }
    return { cwd: workspaceCwd, source: workspaceCwd ? workspaceCwdSource : null };
  }

  async function callTool(name, args, meta, signal, framing) {
    await rootsPromise;
    const session = sessionCwd(args);
    const cwd = session.cwd;
    const hasPath = args?.path != null && String(args.path).trim() !== "";
    const hasRoot = args?.root != null && String(args.root).trim() !== "";
    if (!cwd && !hasPath && !hasRoot) {
      throw new Error(NO_WORKSPACE_ERROR);
    }
    const request = toolRequest(name, args ?? {}, cwd || spawnCwd);
    request.cwdSource = session.source ?? "spawn cwd";
    const result = await query(request, {
      signal,
      onProgress: (progress) => {
        if (meta?.progressToken === undefined) return;
        send(
          {
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: {
              progressToken: meta.progressToken,
              progress: progress.current ?? 0,
              total: progress.total,
              message:
                progress.message ||
                `${progress.phase || "indexing"}${
                  progress.total ? ` ${progress.current}/${progress.total}` : ""
                }`,
            },
          },
          framing,
        );
      },
    });
    const ranked = await rerank(name, request, result);
    const formatted = formatMcpToolResult(name, ranked);
    return {
      content: [{ type: "text", text: formatted.text }],
      structuredContent: formatted.structuredContent,
    };
  }

  async function handleMessage(message, framing = "content-length") {
    const reply = (payload) => send(payload, framing);

    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      reply(jsonRpcError(null, -32600, "invalid request"));
      return;
    }

    if (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (waiter.timer) clearTimeout(waiter.timer);
      if (message.error) {
        waiter.reject(new Error(message.error.message || "client error"));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }

    const { id, method, params } = message;
    const isNotification = id === undefined;

    if (method === "notifications/cancelled") {
      const requestId = params?.requestId;
      inFlight.get(requestId)?.abort();
      return;
    }
    if (method === "notifications/initialized") {
      rootsPromise = refreshRoots(framing);
      return;
    }
    if (method === "notifications/roots/list_changed") {
      rootsPromise = refreshRoots(framing);
      return;
    }
    if (isNotification) return;

    if (method === "initialize") {
      clientSupportsRoots = Boolean(params?.capabilities?.roots);
      reply({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
          capabilities: {
            tools: {},
          },
          serverInfo,
          instructions: MCP_INSTRUCTIONS,
        },
      });
      return;
    }

    if (method === "ping") {
      reply({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    if (method === "tools/list") {
      reply({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;
    }

    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (typeof name !== "string" || name.trim() === "") {
        reply({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: EMPTY_TOOL_MENU }],
            isError: true,
          },
        });
        return;
      }
      if (!TOOLS.some((tool) => tool.name === name)) {
        reply({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `unknown tool: ${name}` }],
            isError: true,
          },
        });
        return;
      }
      const controller = new AbortController();
      inFlight.set(id, controller);
      try {
        const result = await callTool(
          name,
          args,
          params?._meta,
          controller.signal,
          framing,
        );
        reply({ jsonrpc: "2.0", id, result });
      } catch (error) {
        reply({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: error.message || String(error),
              },
            ],
            isError: true,
          },
        });
      } finally {
        inFlight.delete(id);
      }
      return;
    }

    reply(jsonRpcError(id ?? null, -32601, `method not found: ${method}`));
  }

  return {
    attach(input, output) {
      send = (message, framing = "content-length") => {
        if (output.writableEnded || output.destroyed) return;
        output.write(encodeMessage(message, framing));
      };
      const parse = createFramedParser((message, framing) => {
        handleMessage(message, framing).catch((error) => {
          process.stderr.write(`codeq mcp: ${error.message}\n`);
        });
      });
      input.on("data", (chunk) => {
        try {
          parse(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        } catch (error) {
          send(
            jsonRpcError(null, -32700, error.message),
            error.framing || "content-length",
          );
        }
      });
    },
    handleMessage,
    setSend(fn) {
      send = fn;
    },
    get cwd() {
      return workspaceCwd;
    },
  };
}

export async function runMcpServer(options = {}) {
  const server = createMcpServer(options);
  process.stdin.resume();
  server.attach(process.stdin, process.stdout);
  await new Promise((resolve) => {
    process.stdin.on("end", resolve);
    process.stdin.on("close", resolve);
  });
}
