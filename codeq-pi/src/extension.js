/**
 * Native Pi extension factory. Registers find / grep / graph with those names
 * so they override Pi builtins (rg / fd). queryDaemon is injected by the
 * default entry and must only run inside execute, never while registering.
 *
 * Pi's default active set is read, bash, edit, write, then extension names, so
 * bash is listed before codeq. setActiveTools / selectedTools can reorder; if
 * Pi still emits builtins first, a leading guideline still tells the model not
 * to bash ls/grep/rg/find. Bash stays registered and is not intercepted.
 */
import { Type } from "typebox";
import {
  EMPTY_TOOL_MENU,
  requireGrepRegex,
} from "@zj669/codeq/src/mcp-format.js";
import { GREP_CONTEXT_DEFAULT } from "@zj669/codeq/src/limits.js";

const PATH_DESCRIPTION =
  "Narrow this call inside the selected root; never selects an index. Relative paths are relative to that root.";

const ROOT_DESCRIPTION =
  "Repository/checkout/worktree for this call; overrides cwd/Git detection. Set it for cross-repo/worktree queries.";

const FIND_DESCRIPTION =
  "Pick this when you have a file name or path fragment and need its real path — codeq fuzzy file/path lookup, including dotfiles, not Pi's builtin fd. Query is a path fragment, not a glob. If you already know the directory and filename, Read it; do not find to confirm.";

const GREP_DESCRIPTION =
  "codeq content search; this is not rg and not Pi's builtin rg. regex is required: false for a literal string, true for a regular expression. Pass fuzzy:true for approximate/different identifiers. Each hit shows one neighbor line by default; pass context (at most 3) for more, 0 for locators only; this is not rg and not host Read. After locators are returned, do not Read hit files whole, and do not find that basename. Returns matching lines.";

const GRAPH_DESCRIPTION =
  "codeq graph: pick this when the question names a symbol — an identifier, or a short question about how X works, where X is defined, or who calls / uses X; it answers these in one call where grep would take several. Returns an entry span, direct callees, and direct callers — a map, not an answer or source. The how-it-works entry span plus direct neighborhood is the locate; if you still Read, Read only that span, not the whole file; do not then find or grep the same name. For who-calls or where-used, use the callers locators; do not grep that name first. Bounded neighborhood, not an exhaustive callgraph. There is no callers tool.";

function pathField() {
  return Type.Optional(Type.String({ description: PATH_DESCRIPTION }));
}

function rootField() {
  return Type.Optional(Type.String({ description: ROOT_DESCRIPTION }));
}

function limitField() {
  return Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "Page size 1-48 (default 16). Values above 48 are capped; use cursor for more.",
    }),
  );
}

function stripAt(value) {
  if (typeof value !== "string") return value;
  return value.startsWith("@") ? value.slice(1) : value;
}

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value, name, allowZero = false) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed < 1)) {
    throw new Error(
      `${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`,
    );
  }
  return parsed;
}

function prepareShared(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const next = { ...args };
  if (next.path !== undefined) next.path = stripAt(next.path);
  if (next.root !== undefined) next.root = stripAt(next.root);
  delete next.cwd;
  delete next.literal;
  delete next.detail;
  return next;
}

function prepareFindArgs(args) {
  const next = prepareShared(args);
  if (!next || typeof next !== "object") return next;
  if (typeof next.query !== "string" && typeof next.pattern === "string") {
    next.query = next.pattern;
  }
  delete next.pattern;
  return next;
}

function prepareGrepArgs(args) {
  const next = prepareShared(args);
  if (!next || typeof next !== "object") return next;
  if (typeof next.pattern !== "string" && typeof next.query === "string") {
    next.pattern = next.query;
  }
  delete next.query;
  return next;
}

function sessionCwd(ctx) {
  const cwd = ctx?.cwd;
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw new Error("codeq tools require session ctx.cwd");
  }
  return cwd;
}

function toolRequest(name, params, cwd) {
  if (name === "find") {
    if (typeof params.query !== "string" || params.query.trim() === "") {
      throw new Error(EMPTY_TOOL_MENU);
    }
    const request = {
      command: "find",
      cwd,
      query: params.query,
    };
    if (params.path !== undefined) request.path = String(params.path);
    if (params.root !== undefined) request.root = String(params.root);
    if (params.limit !== undefined) {
      request.limit = positiveInteger(params.limit, "limit");
    }
    return request;
  }
  if (name === "grep") {
    if (typeof params.pattern !== "string" || params.pattern.trim() === "") {
      throw new Error(EMPTY_TOOL_MENU);
    }
    const request = {
      command: "grep",
      cwd,
      query: params.pattern,
    };
    if (params.path !== undefined) request.path = String(params.path);
    if (params.root !== undefined) request.root = String(params.root);
    if (params.glob !== undefined) request.glob = String(params.glob);
    if (params.fuzzy !== undefined) request.fuzzy = Boolean(params.fuzzy);
    request.regex = requireGrepRegex(params.regex);
    if (params.cursor !== undefined) request.cursor = String(params.cursor);
    if (params.limit !== undefined) {
      request.limit = positiveInteger(params.limit, "limit");
    }
    if (params.context !== undefined) {
      request.context = positiveInteger(params.context, "context", true);
    } else if (params.count !== true && params.cursor === undefined) {
      request.context = GREP_CONTEXT_DEFAULT;
    }
    if (params.count !== undefined) request.count = Boolean(params.count);
    if (params.ignoreCase !== undefined) {
      request.ignoreCase = Boolean(params.ignoreCase);
    }
    return request;
  }
  if (name === "graph") {
    if (typeof params.query !== "string" || params.query.trim() === "") {
      throw new Error(EMPTY_TOOL_MENU);
    }
    const request = {
      command: "graph",
      cwd,
      query: params.query,
    };
    if (params.path !== undefined) request.path = String(params.path);
    if (params.root !== undefined) request.root = String(params.root);
    return request;
  }
  throw new Error(`unknown tool: ${name}`);
}

function paint(theme, color, text) {
  return theme?.fg ? theme.fg(color, text) : text;
}

/** Fallback when Pi calls render() without a width (tests / first paint). */
export const SAFE_TUI_WIDTH = 76;

export function tuiWidth(width) {
  if (!Number.isFinite(width) || width < 1) return SAFE_TUI_WIDTH;
  return Math.max(1, Math.floor(width));
}

/**
 * Wrap one plain (no ANSI) line for Pi's TUI. Prefers a break before `via`
 * and after the freshness `root ` prefix so those tokens stay intact;
 * hard-wraps unbreakable paths. Model-facing locator text is not passed here.
 */
export function wrapTuiLine(text, width) {
  const max = tuiWidth(width);
  const line = String(text ?? "");
  if (line.length <= max) return [line];

  const viaAt = line.indexOf(" via ");
  if (viaAt > 0 && viaAt <= max) {
    return [line.slice(0, viaAt), ...wrapTuiLine(line.slice(viaAt + 1), max)];
  }

  const prefix = line.match(/^(\[[^\]]+\](?:\[[^\]]+\])* root )/);
  if (prefix && prefix[1].length < max && prefix[1].length < line.length) {
    return [
      line.slice(0, prefix[1].length).trimEnd(),
      ...wrapTuiLine(line.slice(prefix[1].length), max),
    ];
  }

  const lines = [];
  let rest = line;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    if (cut < Math.floor(max / 2)) {
      const slash = rest.lastIndexOf("/", max);
      cut = slash >= Math.floor(max / 3) ? slash : max;
    }
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut);
    if (rest.startsWith(" ")) rest = rest.slice(1);
  }
  if (rest.length > 0) lines.push(rest);
  return lines;
}

export const CODEQ_TOOL_NAMES = ["find", "grep", "graph"];

export const CODEQ_BEFORE_BASH_GUIDELINE =
  "Use find, grep, and graph for files and contents; do not use bash for ls, grep, rg, or find. Keep bash for real shell work.";

export function prioritizeCodeqTools(names) {
  if (!Array.isArray(names)) return [];
  const seen = new Set();
  const out = [];
  for (const name of CODEQ_TOOL_NAMES) {
    if (names.includes(name) && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  for (const name of names) {
    if (typeof name === "string" && name.length > 0 && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function leadGuideline(list, guideline) {
  if (!Array.isArray(list)) return [guideline];
  if (list[0] === guideline) return list;
  const next = list.filter((line) => line !== guideline);
  next.unshift(guideline);
  return next;
}

export function applyCodeqPromptOrder(options) {
  if (!options || typeof options !== "object") return options;
  const original = Array.isArray(options.selectedTools)
    ? options.selectedTools.slice()
    : [];
  if (Array.isArray(options.selectedTools)) {
    options.selectedTools = prioritizeCodeqTools(options.selectedTools);
  }
  options.promptGuidelines = leadGuideline(
    options.promptGuidelines,
    CODEQ_BEFORE_BASH_GUIDELINE,
  );
  const originalFirst = original[0];
  if (
    originalFirst &&
    !CODEQ_TOOL_NAMES.includes(originalFirst) &&
    options.toolGuidelines &&
    typeof options.toolGuidelines === "object"
  ) {
    options.toolGuidelines[originalFirst] = leadGuideline(
      options.toolGuidelines[originalFirst],
      CODEQ_BEFORE_BASH_GUIDELINE,
    );
  }
  return options;
}

export function applyCodeqActiveTools(pi) {
  if (
    !pi ||
    typeof pi.getActiveTools !== "function" ||
    typeof pi.setActiveTools !== "function"
  ) {
    return;
  }
  let active;
  try {
    active = pi.getActiveTools();
  } catch {
    return;
  }
  if (!Array.isArray(active) || active.length === 0) return;
  const names = [];
  for (const item of active) {
    const name = typeof item === "string" ? item : item?.name;
    if (typeof name === "string" && name.length > 0) names.push(name);
  }
  if (names.length === 0) return;
  const next = prioritizeCodeqTools(names);
  if (next.length === 0) return;
  if (next.length === names.length && next.every((name, i) => name === names[i])) {
    return;
  }
  try {
    pi.setActiveTools(next);
  } catch {
    // before_agent_start still reorders selectedTools / promptGuidelines.
  }
}

function paintWrapped(lines, theme, color) {
  return lines.map((line) => paint(theme, color, line));
}

function textComponent(text, theme, color) {
  const source = String(text).split("\n");
  return {
    render(width) {
      const max = tuiWidth(width);
      const out = [];
      for (const line of source) {
        out.push(...paintWrapped(wrapTuiLine(line, max), theme, color));
      }
      return out;
    },
    invalidate() {},
  };
}

function renderCall(name, args, theme) {
  const title = paint(theme, "toolTitle", theme?.bold ? theme.bold(name) : name);
  const focus =
    name === "grep"
      ? trimString(args?.pattern)
      : trimString(args?.query) || trimString(args?.pattern);
  const path = trimString(args?.path) || trimString(args?.root) || ".";
  const plain = focus ? `${name} ${focus} in ${path}` : `${name} ${path}`;
  const styled = focus
    ? `${title} ${paint(theme, "accent", focus)} ${paint(theme, "toolOutput", `in ${path}`)}`
    : `${title} ${paint(theme, "toolOutput", path)}`;
  return {
    render(width) {
      const max = tuiWidth(width);
      if (plain.length <= max) return [styled];
      return paintWrapped(wrapTuiLine(plain, max), theme, "toolOutput");
    },
    invalidate() {},
  };
}

function renderResult(result, options, theme) {
  const output =
    result?.content?.find((part) => part.type === "text")?.text?.trim() ?? "";
  if (!output) {
    return textComponent("No output", theme, "muted");
  }
  const color = result?.isError ? "error" : "toolOutput";
  const lines = output.split("\n");
  const shown = options?.expanded ? lines : lines.slice(0, 8);
  const more =
    lines.length > shown.length
      ? `... (${lines.length - shown.length} more lines)`
      : null;
  return {
    render(width) {
      const max = tuiWidth(width);
      const out = [];
      for (const line of shown) {
        out.push(...paintWrapped(wrapTuiLine(line, max), theme, color));
      }
      if (more) {
        out.push(...paintWrapped(wrapTuiLine(more, max), theme, "muted"));
      }
      return out;
    },
    invalidate() {},
  };
}

function progressText(progress = {}) {
  return (
    progress.message ||
    `${progress.phase || "indexing"}${
      progress.total ? ` ${progress.current}/${progress.total}` : ""
    }`
  );
}

export function createCodeqExtension({
  query,
  format,
  rerank = async (_name, _request, result) => result,
} = {}) {
  if (typeof query !== "function") {
    throw new Error("createCodeqExtension requires query");
  }
  if (typeof format !== "function") {
    throw new Error("createCodeqExtension requires format");
  }

  function executeTool(name) {
    return async function execute(_toolCallId, params, signal, onUpdate, ctx) {
      try {
        if (signal?.aborted) {
          throw new Error("request cancelled");
        }
        const cwd = sessionCwd(ctx);
        const request = toolRequest(name, params ?? {}, cwd);
        const result = await query(request, {
          signal,
          onProgress: (progress) => {
            onUpdate?.({
              content: [{ type: "text", text: progressText(progress) }],
              details: {},
            });
          },
        });
        const ranked = await rerank(name, request, result);
        const formatted = format(name, ranked);
        return {
          content: [{ type: "text", text: formatted.text }],
          details: formatted.structuredContent ?? {},
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error?.message || String(error),
            },
          ],
          details: {},
          isError: true,
        };
      }
    };
  }

  const tools = [
    {
      name: "find",
      label: "find",
      description: FIND_DESCRIPTION,
      promptSnippet: "Find files by name or path (codeq / FFF, not fd)",
      promptGuidelines: [
        CODEQ_BEFORE_BASH_GUIDELINE,
        "find is codeq path search, not a glob tool and not fd: pass profile, not **/*profile*.",
        "find: if you already know the directory and filename, Read it; do not find to confirm. Returned paths are repo-relative — join them to the root on the reply's first line for host Read, or pass one to grep path:.",
        "find matches the whole indexed path, including dotfiles such as .cursor/rules. Use grep for contents and graph for call chains.",
        "find searches one repository per call. Pass root for another checkout; pass path to narrow inside the selected root. Never merge results across repositories.",
      ],
      parameters: Type.Object({
        query: Type.String({
          description:
            "Path fragment, matched fuzzily (foo.py, profiles/app, SKILL.md). Not a glob: pass profile, not **/*profile*. Dotfiles are indexed.",
        }),
        path: pathField(),
        root: rootField(),
        limit: limitField(),
      }),
      prepareArguments: prepareFindArgs,
      execute: executeTool("find"),
      renderCall(args, theme) {
        return renderCall("find", args, theme);
      },
      renderResult,
    },
    {
      name: "grep",
      label: "grep",
      description: GREP_DESCRIPTION,
      promptSnippet: "Search file contents (codeq / FFF, not rg)",
      promptGuidelines: [
        CODEQ_BEFORE_BASH_GUIDELINE,
        "grep is codeq content search, not rg. regex is required: false for a literal string, true for a regular expression.",
        "grep is exact by default: zero hits means zero hits. Pass fuzzy: true only for approximate/different identifiers; those replies are labelled [fuzzy].",
        "grep: after locators are returned, do not Read hit files whole, and do not find that basename.",
        "grep searches one repository per call. Pass root for another checkout; pass path to narrow. Continuation uses an opaque cursor bound to the same search.",
      ],
      parameters: Type.Object({
        pattern: Type.String({
          description:
            "literal string when regex is false. This is not rg: dots, brackets, and $ are literal unless regex is true.",
        }),
        path: pathField(),
        root: rootField(),
        glob: Type.Optional(
          Type.String({
            description:
              "Optional glob used to constrain matches, for example **/*.ts",
          }),
        ),
        regex: Type.Boolean({
          description:
            "Required. true = regular expression; false = literal. foo.ts, process.env, and array[0] are literals. This is not rg.",
        }),
        fuzzy: Type.Optional(
          Type.Boolean({
            description:
              "Default false. Approximate matching for different identifiers, labelled [fuzzy]. NOT the same identifier.",
          }),
        ),
        cursor: Type.Optional(
          Type.String({
            description:
              "Opaque continuation from a previous grep nextCursor. Bound to the same root, pattern, glob, path, regex, fuzzy, context, and ignoreCase. A mismatch is an error, not page 1.",
          }),
        ),
        limit: limitField(),
        context: Type.Optional(
          Type.Integer({
            minimum: 0,
            description:
              "Neighboring source lines around each hit. Default 1, maximum 3; pass 0 for locators only. Not rg and not host Read.",
          }),
        ),
        count: Type.Optional(
          Type.Boolean({
            description:
              "When true, return match and file counts only, with no locators. Ignores context. Does not accept cursor.",
          }),
        ),
        ignoreCase: Type.Optional(
          Type.Boolean({
            description:
              "This is not rg. Omit for smart-case; true forces case-insensitive matching; false is case-sensitive.",
          }),
        ),
      }),
      prepareArguments: prepareGrepArgs,
      execute: executeTool("grep"),
      renderCall(args, theme) {
        return renderCall("grep", args, theme);
      },
      renderResult,
    },
    {
      name: "graph",
      label: "graph",
      description: GRAPH_DESCRIPTION,
      promptSnippet: "Explore the code graph (codeq / CodeGraph)",
      promptGuidelines: [
        CODEQ_BEFORE_BASH_GUIDELINE,
        "graph is codeq CodeGraph explore, not a written answer. Pick it when the question names a symbol — identifiers, how X works, where X is defined, or who calls / uses X — not a multi-paragraph question. A 'who calls X' or 'how does X work' question goes to graph first, not grep.",
        "graph: the how-it-works entry span plus direct neighborhood is the locate; if you still Read, Read only that span, not the whole file; do not then find or grep the same name. For who-calls or where-used, use the callers locators; do not grep that name first. There is no callers tool.",
        "graph searches one repository per call. Pass root for another checkout; pass path to narrow. Replies are locators, never source.",
      ],
      parameters: Type.Object({
        query: Type.String({
          description:
            'Identifiers, or a short question about how X works, where X is defined, or who calls / uses X. Identifier-shaped queries match the graph; a multi-paragraph question does not.',
        }),
        path: pathField(),
        root: rootField(),
      }),
      prepareArguments: prepareShared,
      execute: executeTool("graph"),
      renderCall(args, theme) {
        return renderCall("graph", args, theme);
      },
      renderResult,
    },
  ];

  return function codeqPi(pi) {
    for (const tool of tools) {
      pi.registerTool(tool);
    }
    pi.on("session_start", () => {
      applyCodeqActiveTools(pi);
    });
    pi.on("before_agent_start", (event) => {
      applyCodeqActiveTools(pi);
      applyCodeqPromptOrder(event?.systemPromptOptions);
    });
  };
}
