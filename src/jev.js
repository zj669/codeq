import { neighborhood } from "./graph-map.js";
import { JEV_CANDIDATE_CAP, JEV_TIMEOUT_MS } from "./limits.js";
import { isExactFindMatch, pathTier } from "./path-tier.js";

export { JEV_TIMEOUT_MS, JEV_CANDIDATE_CAP };

const NOUL_TRUE =
  "This hit is useful next-read evidence for answering the request query (a definition or implementation of the named function).";
const NOUL_FALSE =
  "This hit does not help answer the request query (a test, alias, comment, or unrelated mention).";

function trimEnv(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

export function jevConfig(env = process.env) {
  return {
    key: trimEnv(env.CODEQ_JEV_KEY),
    url: trimEnv(env.CODEQ_JEV_URL),
    model: trimEnv(env.CODEQ_JEV_MODEL),
    timeoutMs: JEV_TIMEOUT_MS,
  };
}

export function jevEnabled(env = process.env) {
  return Boolean(jevConfig(env).key);
}

export function jevClientOptions(env = process.env) {
  const config = jevConfig(env);
  return {
    apiKey: config.key,
    ...(config.url ? { baseURL: config.url } : {}),
    ...(config.model ? { defaultModel: config.model } : {}),
    logLevel: "off",
    timeout: config.timeoutMs,
    retry: {
      maxRetries: 0,
      apiTimeoutError: false,
      apiConnectionError: false,
    },
  };
}

export function skipReason(error) {
  const status = error?.status ?? error?.statusCode ?? error?.status_code;
  if (Number.isInteger(status) && status >= 400 && status < 500) return "http_4xx";
  if (Number.isInteger(status) && status >= 500 && status < 600) return "http_5xx";
  const message = String(error?.message || error || "").toLowerCase();
  const name = String(error?.name || "").toLowerCase();
  if (
    name.includes("timeout") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    name === "aborterror"
  ) {
    return "timeout";
  }
  return "error";
}

function compact(record) {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (value == null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

function requestLayer(command, request, result) {
  return compact({
    query: request.query ?? result.query ?? result.pattern ?? "",
    tool: command,
    path: request.path,
    glob: request.glob,
    matchMode: result.mode,
  });
}

export function extractCandidates(command, request, result) {
  if (command === "find") {
    return (result.results || []).map((item, index) => ({
      index,
      kind: "find",
      pinned: pathTier(item.path) === 0 && isExactFindMatch(item.matchType),
      anchor: item.path,
      record: compact({
        path: item.path,
        matchType: item.matchType,
      }),
    }));
  }
  if (command === "grep") {
    return (result.results || []).map((item, index) => ({
      index,
      kind: "grep",
      pinned: false,
      anchor: `${item.path}:${item.line}`,
      record: compact({
        path: item.path,
        line: item.line,
        column: item.column,
        text: item.text,
        ...((item.contextBefore || []).length > 0 || (item.contextAfter || []).length > 0
          ? {
              before: item.contextBefore || [],
              match: item.text,
              after: item.contextAfter || [],
            }
          : {}),
      }),
    }));
  }
  if (command === "graph") {
    const map = neighborhood({ ...result, entryOrder: null, calleeOrder: null });
    const entries = map.entries.map((entry, index) => ({
      index,
      kind: "entry",
      pinned: Boolean(entry.pinned),
      anchor: `${entry.path}:${entry.startLine}`,
      record: compact({
        symbol: entry.symbol,
        path: entry.path,
        startLine: entry.startLine,
        endLine: entry.endLine,
        kind: entry.kind,
      }),
    }));
    const callees = map.callees.map((callee, index) => ({
      index: entries.length + index,
      kind: "callee",
      pinned: false,
      anchor: `${callee.path}:${callee.line}`,
      record: compact({
        name: callee.name,
        path: callee.path,
        line: callee.line,
        endLine: callee.endLine,
      }),
    }));
    const callers = map.callers.map((caller, index) => ({
      index: entries.length + callees.length + index,
      kind: "caller",
      pinned: false,
      anchor: `${caller.path}:${caller.line}`,
      record: compact({
        name: caller.name,
        path: caller.path,
        line: caller.line,
        endLine: caller.endLine,
      }),
    }));
    return [...entries, ...callees, ...callers];
  }
  return [];
}

function buildState(command, request, result, candidates) {
  const hits = {};
  for (const candidate of candidates) hits[candidate.anchor] = candidate.record;
  return { request: requestLayer(command, request, result), hits };
}

function permute(items, order, keyOf) {
  if (!Array.isArray(order) || order.length === 0) return items;
  const remaining = [...items];
  const out = [];
  for (const key of order) {
    const index = remaining.findIndex((item) => keyOf(item) === key);
    if (index < 0) continue;
    out.push(remaining.splice(index, 1)[0]);
  }
  out.push(...remaining);
  return out;
}

function sortVisible(candidates, ranked) {
  const byIndex = new Map(ranked.map((item) => [item.index, item]));
  const noulOf = (candidate) => byIndex.get(candidate.index)?.noul ?? 0;
  const pinned = candidates.filter((candidate) => candidate.pinned);
  const rest = candidates
    .filter((candidate) => !candidate.pinned)
    .sort((left, right) => {
      const noul = noulOf(right) - noulOf(left);
      if (noul !== 0) return noul;
      return left.index - right.index;
    });
  return [...pinned, ...rest];
}

function sortGrepByTierThenNoul(candidates, ranked) {
  const byIndex = new Map(ranked.map((item) => [item.index, item]));
  const noulOf = (candidate) => byIndex.get(candidate.index)?.noul ?? 0;
  const buckets = new Map();
  for (const candidate of candidates) {
    const tier = pathTier(candidate.record.path);
    if (!buckets.has(tier)) buckets.set(tier, []);
    buckets.get(tier).push(candidate);
  }
  const ordered = [];
  for (const tier of [...buckets.keys()].sort((a, b) => a - b)) {
    const bucket = buckets.get(tier);
    bucket.sort((left, right) => {
      const noul = noulOf(right) - noulOf(left);
      if (noul !== 0) return noul;
      return left.index - right.index;
    });
    ordered.push(...bucket);
  }
  return ordered;
}

function applyRanking(command, result, candidates, ranked) {
  const ordered =
    command === "grep"
      ? sortGrepByTierThenNoul(candidates, ranked)
      : sortVisible(candidates, ranked);
  if (command === "graph") {
    return {
      ...result,
      entryOrder: ordered
        .filter((item) => item.kind === "entry")
        .map((item) => item.anchor),
      calleeOrder: ordered
        .filter((item) => item.kind === "callee")
        .map((item) => item.anchor),
      callerOrder: ordered
        .filter((item) => item.kind === "caller")
        .map((item) => item.anchor),
    };
  }
  const keys = ordered.map((item) => item.anchor);
  const results = permute(
    result.results || [],
    keys,
    command === "find"
      ? (item) => item.path
      : (item) => `${item.path}:${item.line}`,
  );
  if (results.length !== (result.results || []).length) return result;
  return {
    ...result,
    results,
    preserveOrder: true,
  };
}

async function defaultSystemOne(payload, env = process.env) {
  const { TypeSafeClient, noul } = await import("@typesafe-ai/sdk");
  const config = jevConfig(env);
  const client = new TypeSafeClient(jevClientOptions(env));
  const questions = {};
  for (const [key, question] of Object.entries(payload.questions)) {
    questions[key] = noul(question.instructions, question.criteria);
  }
  return client.systemOne({
    ...(config.model ? { model: config.model } : {}),
    state: payload.state,
    questions,
  });
}

function questionsFor(candidates) {
  const questions = {};
  for (const [index, candidate] of candidates.entries()) {
    questions[`n${index}`] = {
      type: "noul",
      instructions: `Does the hit \`${candidate.anchor}\` help answer the request query?`,
      criteria: { true: NOUL_TRUE, false: NOUL_FALSE },
    };
  }
  return questions;
}

function readAnswers(answers, candidates) {
  return candidates.map((candidate, index) => {
    const noulAnswer = answers[`n${index}`];
    const value =
      noulAnswer && typeof noulAnswer.noul === "number" ? noulAnswer.noul : 0;
    return { index: candidate.index, noul: value };
  });
}

function withJev(result, jev) {
  return { ...result, jev };
}

function defaultLiteralGrep(request, result) {
  if (request?.regex === true || request?.fuzzy === true) return false;
  const mode = result?.mode;
  if (mode === "regex" || mode === "fuzzy") return false;
  return true;
}

export function prodShortlistSkip(command, request, result) {
  if (command !== "grep" && command !== "find") return false;
  if (command === "grep" && !defaultLiteralGrep(request, result)) return false;
  const results = result?.results || [];
  if (results.length === 0 || results.length > JEV_CANDIDATE_CAP) return false;
  return results.every((item) => pathTier(item.path) === 0);
}

export function exactNeighborhoodSkip(command, request, result) {
  if (command !== "graph") return false;
  if (neighborhood(result).entries.length < 1) return false;
  const candidates = extractCandidates(command, request, result);
  return candidates.length >= 1 && candidates.length <= JEV_CANDIDATE_CAP;
}

export function tierOrderSkip(command, request, result) {
  if (command !== "find") return false;
  const results = result?.results || [];
  if (results.length < 2 || results.length > JEV_CANDIDATE_CAP) return false;
  let sawProd = false;
  let sawAux = false;
  for (const item of results) {
    if (pathTier(item.path) === 0) sawProd = true;
    else sawAux = true;
    if (sawProd && sawAux) return true;
  }
  return false;
}

export function mixedGrepSkip(command, request, result) {
  if (command !== "grep") return false;
  if (!defaultLiteralGrep(request, result)) return false;
  const results = result?.results || [];
  if (results.length < 2 || results.length > JEV_CANDIDATE_CAP) return false;
  const counts = new Map();
  for (const item of results) {
    const tier = pathTier(item.path);
    counts.set(tier, (counts.get(tier) || 0) + 1);
  }
  if (counts.size < 2) return false;
  for (const count of counts.values()) {
    if (count !== 1) return false;
  }
  return true;
}

export async function rerank(
  command,
  request,
  result,
  { systemOne, env = process.env } = {},
) {
  const candidates = extractCandidates(command, request, result);
  if (candidates.length <= 1 || candidates.length > JEV_CANDIDATE_CAP) {
    return result;
  }
  const call = systemOne || ((payload) => defaultSystemOne(payload, env));
  const payload = {
    state: buildState(command, request, result, candidates),
    questions: questionsFor(candidates),
  };
  const response = await call(payload);
  if (!response?.answers) return result;
  const ranked = readAnswers(response.answers, candidates);
  const next = applyRanking(command, result, candidates, ranked);
  if (command !== "graph") {
    const before = (result.results || []).length;
    const after = (next.results || []).length;
    if (after !== before) return result;
  }
  return next;
}

export async function maybeRerank(command, request, result, options) {
  const env = options?.env ?? process.env;
  if (!jevEnabled(env)) {
    return withJev(result, { applied: false, skipped: "no_key" });
  }
  const candidates = extractCandidates(command, request, result);
  if (candidates.length <= 1) {
    return withJev(result, { applied: false, skipped: "too_few" });
  }
  if (candidates.length > JEV_CANDIDATE_CAP) {
    return withJev(result, { applied: false, skipped: "too_many" });
  }
  if (prodShortlistSkip(command, request, result)) {
    return withJev(
      { ...result, preserveOrder: true },
      { applied: false, skipped: "prod_shortlist" },
    );
  }
  if (exactNeighborhoodSkip(command, request, result)) {
    return withJev(
      { ...result, preserveOrder: true },
      { applied: false, skipped: "exact_neighborhood" },
    );
  }
  if (tierOrderSkip(command, request, result)) {
    return withJev(
      { ...result, preserveOrder: true },
      { applied: false, skipped: "tier_order" },
    );
  }
  if (mixedGrepSkip(command, request, result)) {
    return withJev(
      { ...result, preserveOrder: true },
      { applied: false, skipped: "mixed_grep" },
    );
  }
  try {
    // JEV_TIMEOUT_MS must bound the reply, not only the SDK call: a rerank
    // that outlives the budget (hung socket the client timeout misses, slow
    // payload build) must not hold the query hostage. Race the rerank against
    // a budget timer; the loser keeps the engine page and reports timeout.
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), JEV_TIMEOUT_MS);
    });
    try {
      const next = await Promise.race([
        rerank(command, request, result, options),
        timeout,
      ]);
      return withJev(next, { applied: true });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return withJev(result, { applied: false, skipped: skipReason(error) });
  }
}
