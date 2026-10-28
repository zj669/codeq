#!/usr/bin/env node
// codeq eval harness - runs questions.json against a repo via the codeq CLI
// (--json) and scores hit@1/3/5 plus latency.
// Usage: node eval/run.js [root] [questions.json] [out.json]
//   root defaults to $CODEQ_EVAL_ROOT, else the pinned FastAPI checkout under
//   the user cache (run eval/fetch-fastapi.sh to fetch it).
// Ground truth: expected file must appear in results (find/grep: results[].path,
// graph: symbols/callers/callees paths). Rank = first position.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const EVAL_DIR = fileURLToPath(new URL(".", import.meta.url));
const CLI = fileURLToPath(new URL("../bin/codeq.js", import.meta.url));
const CACHE = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "codeq-eval",
);
const DEFAULT_ROOT = join(CACHE, "fastapi");
// The daemon socket is shared per data dir, so without this the eval would be
// served by whatever checkout's daemon is already running — the numbers must
// measure this one. The daemon is keyed by package version, so also isolate
// per checkout. CODEQ_DATA_DIR stays authoritative when the caller sets it.
const CHECKOUT = fileURLToPath(new URL("..", import.meta.url));
const DATA_DIR =
  process.env.CODEQ_DATA_DIR ||
  join(
    CACHE,
    `data-${createHash("sha256").update(CHECKOUT).digest("hex").slice(0, 8)}`,
  );
const ENV = { ...process.env, CODEQ_DATA_DIR: DATA_DIR };
for (const key of Object.keys(ENV)) {
  if (key.startsWith("CODEQ_JEV_")) delete ENV[key];
}

const ROOT = process.argv[2] || process.env.CODEQ_EVAL_ROOT || DEFAULT_ROOT;
const QFILE = process.argv[3] || join(EVAL_DIR, "questions.json");
const OUT = process.argv[4] || join(EVAL_DIR, "results.json");

if (!existsSync(ROOT)) {
  process.stderr.write(
    `eval root does not exist: ${ROOT}\n` +
      "Run eval/fetch-fastapi.sh to fetch the pinned benchmark repo, " +
      "or pass a repo root: node eval/run.js /path/to/repo\n",
  );
  process.exit(2);
}
const questions = JSON.parse(readFileSync(QFILE, "utf8"));

async function runOne(q) {
  const start = Date.now();
  const args = ["--root", ROOT, "--json", q.tool];
  if (q.tool === "grep") args.push(q.query, "--limit", "16");
  else args.push(q.query);
  try {
    const { stdout } = await exec("node", [CLI, ...args], {
      timeout: 120000,
      cwd: ROOT,
      maxBuffer: 10 * 1024 * 1024,
      env: ENV,
    });
    const ms = Date.now() - start;
    const data = JSON.parse(stdout);
    let paths = [];
    if (q.tool === "find" || q.tool === "grep") {
      paths = (data.results || []).map((r) => r.path);
    } else if (q.tool === "graph") {
      const syms = data.symbols || [];
      const symPaths = syms.map((s) => s.path);
      const callerPaths = syms.flatMap((s) => (s.callers || []).map((c) => c.path));
      // Symbol rank is the "where defined" signal; caller rank is the "who calls"
      // signal. A question passes if its expected file is a top-3 symbol, or a
      // top-3 caller (who-calls questions), or appears in the flattened top-5.
      const symRank = symPaths.indexOf(q.expected) + 1;
      const callerRank = callerPaths.indexOf(q.expected) + 1;
      for (const s of syms) {
        paths.push(s.path);
        for (const c of s.callers || []) paths.push(c.path);
        for (const c of s.callees || []) paths.push(c.path);
      }
      const flatRank = paths.indexOf(q.expected) + 1;
      const rank = symRank || callerRank || flatRank;
      const hit1 = symRank === 1 || callerRank === 1;
      const hit3 = (symRank >= 1 && symRank <= 3) || (callerRank >= 1 && callerRank <= 3);
      const hit5 = hit3 || (flatRank >= 1 && flatRank <= 5);
      return { ...q, ms, rank, symRank, callerRank, flatRank, hit1, hit3, hit5, top: symPaths.slice(0, 3) };
    }
    const rank = paths.indexOf(q.expected) + 1; // 0 if absent
    return { ...q, ms, rank, hit1: rank === 1, hit3: rank >= 1 && rank <= 3, hit5: rank >= 1 && rank <= 5, top: paths.slice(0, 3) };
  } catch (e) {
    return { ...q, ms: Date.now() - start, rank: 0, hit1: false, hit3: false, hit5: false, error: String(e.message).slice(0, 200) };
  }
}

// Warm the daemon and both indexes so no question absorbs indexing cost.
await exec("node", [CLI, "--root", ROOT, "--json", "find", "warmup"], {
  timeout: 120000,
  cwd: ROOT,
  env: ENV,
}).catch(() => {});
await exec("node", [CLI, "--root", ROOT, "--json", "graph", "warmup"], {
  timeout: 120000,
  cwd: ROOT,
  env: ENV,
}).catch(() => {});

const results = [];
for (const q of questions) {
  const r = await runOne(q);
  results.push(r);
  console.log(`${r.id} ${r.tool} rank=${r.rank} ${r.ms}ms ${r.error ? "ERR " + r.error : ""}`);
}
const pct = (arr, f) => ((arr.filter(f).length / arr.length) * 100).toFixed(1) + "%";
const lat = results.map((r) => r.ms).sort((a, b) => a - b);
const summary = {
  n: results.length,
  hit1: pct(results, (r) => r.hit1),
  hit3: pct(results, (r) => r.hit3),
  hit5: pct(results, (r) => r.hit5),
  meanMs: lat.length
    ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length)
    : 0,
  p95Ms: lat[Math.ceil(lat.length * 0.95) - 1],
  byTool: Object.fromEntries(
    ["find", "grep", "graph"].map((t) => {
      const s = results.filter((r) => r.tool === t);
      return [
        t,
        {
          n: s.length,
          hit1: pct(s, (r) => r.hit1),
          hit3: pct(s, (r) => r.hit3),
          hit5: pct(s, (r) => r.hit5),
          meanMs: Math.round(s.reduce((a, r) => a + r.ms, 0) / s.length),
        },
      ];
    }),
  ),
};
console.log(JSON.stringify(summary, null, 2));
writeFileSync(
  OUT,
  JSON.stringify({ summary, results, root: ROOT, date: new Date().toISOString() }, null, 2),
);
