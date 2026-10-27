import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { rename, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FileFinder } from "@ff-labs/fff-node";
import {
  encodeNextGrepCursor,
  GREP_COUNT_CURSOR_ERROR,
  grepCursorOffset,
  openGrepCursor,
  toFffCursor,
} from "./grep-cursor.js";
import {
  assertGrepPattern,
  grepCaseOptions,
  ignoreCaseCursorValue,
} from "./grep-mode.js";
import { acquireLock } from "./lock.js";
import {
  clampGrepContext,
  CONTEXT_CAP,
  COUNT_SCAN_CAP,
  RANK_WINDOW,
} from "./limits.js";
import { applyFindWindow, applyGrepWindow } from "./path-tier.js";
import {
  ensurePrivateDir,
  ensurePrivateFile,
  rootBucket,
} from "./paths.js";
import { findSharedGraph, touchGraphSource } from "./graph-share.js";
import { worktreeFingerprint } from "./worktree.js";
import { planFindSearch, runFindSearch } from "./find-glob.js";

const require = createRequire(import.meta.url);

const GRAPH_LOCK_TIMEOUT_MS = 15 * 60 * 1_000;

function unwrap(result, operation) {
  if (!result.ok) throw new Error(`${operation}: ${result.error}`);
  return result.value;
}

function pageMeta(options = {}) {
  return {
    requestedLimit:
      Number.isSafeInteger(options.limit) && options.limit > 0
        ? options.limit
        : null,
    pageCap: RANK_WINDOW,
  };
}

function fffGrepOptions({ mode, ignoreCase, context }) {
  return {
    mode,
    ...grepCaseOptions(ignoreCase),
    pageSize: RANK_WINDOW,
    beforeContext: context,
    afterContext: context,
  };
}

function mapGrepHit(item) {
  return {
    path: item.relativePath,
    line: item.lineNumber,
    column: item.col + 1,
    text: item.lineContent,
    contextBefore: item.contextBefore || [],
    contextAfter: item.contextAfter || [],
  };
}

function bundledNode() {
  const platformRoot = dirname(
    require.resolve(
      `@colbymchenry/codegraph-${process.platform}-${process.arch}/package.json`,
    ),
  );
  const candidates = [
    join(platformRoot, process.platform === "win32" ? "node.exe" : "node"),
    join(platformRoot, "node", "bin", process.platform === "win32" ? "node.exe" : "node"),
    join(platformRoot, "bin", process.platform === "win32" ? "node.exe" : "node"),
  ];
  const executable = candidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
  if (!executable) {
    throw new Error("CodeGraph bundled Node runtime is missing");
  }
  return executable;
}

export class RootContext {
  constructor(root, dataDir) {
    this.root = root;
    this.dataDir = dataDir;
    this.location = rootBucket(dataDir, root);
    this.lastAccess = Date.now();
    this.active = 0;
    this.status = "indexing";
    this.fffWarning = null;
    this.graphWarning = null;
    this.fffWatchFailed = false;
    this.fffWatcherReady = true;
    this.metadataSequence = 0;
    this.lastSuccessfulSync = null;
    this.finder = null;
    this.graphReady = false;
    this.graphProcess = null;
    this.graphPending = new Map();
    this.graphSequence = 0;
    this.graphProgressListeners = new Set();
    this.fffUnwatch = null;
    this.fffPromise = this.#initializeFff();
    this.graphPromise = null;
    // Set once a graph index exists for this root: the content fingerprint it
    // was built from, and the root that owns it when it is not ours.
    this.graphFingerprint = null;
    this.sharedGraph = null;
  }

  // Other processes parse root.json (index sharing, tests): a torn write
  // reads as invalid JSON, so publish atomically. The temp name is unique
  // per call — concurrent touches write and rename independently.
  async #writeMetadata() {
    ensurePrivateDir(this.location.bucket);
    const temp = `${this.location.metadata}.${process.pid}.${++this.metadataSequence}.tmp`;
    await writeFile(
      temp,
      `${JSON.stringify(
        {
          root: this.root,
          schema: 1,
          codegraphVersion: "1.6.0",
          lastAccessedAt: new Date(this.lastAccess).toISOString(),
          ...(this.graphFingerprint
            ? { graphFingerprint: this.graphFingerprint }
            : {}),
          ...(this.sharedGraph ? { sharedGraphRoot: this.sharedGraph.root } : {}),
        },
        null,
        2,
      )}\n`,
    );
    await rename(temp, this.location.metadata);
    ensurePrivateFile(this.location.metadata);
  }

  async #initializeFff() {
    await this.#writeMetadata();
    const created = FileFinder.create({
      basePath: this.root,
      aiMode: true,
      disableWatch: process.env.CODEQ_FFF_DISABLE_WATCH === "1",
    });
    this.finder = unwrap(created, "FFF initialization failed");
    this.#subscribeFffWatch();
    const scanned = unwrap(
      await this.finder.waitForIndexReady(60_000),
      "FFF initial scan failed",
    );
    if (!scanned) {
      this.fffWarning = "FFF initial scan is still running";
    }
    this.#noteFffFreshness(this.finder);
    this.#refreshStatus();
    return this.finder;
  }

  #subscribeFffWatch() {
    if (!this.finder?.watch) return;
    const watched = this.finder.watch((events) => {
      if (!events?.some((event) => event.kind === "rescan")) return;
      this.fffWarning = "FFF missed filesystem events and is rescanning";
      this.#refreshStatus();
      try {
        this.finder.scanFiles();
      } catch {}
    });
    if (watched.ok) {
      this.fffUnwatch = watched.value;
      return;
    }
    // No live events: without a rescan the index goes silently stale.
    this.fffWatchFailed = true;
    this.fffWarning = `FFF watcher failed: ${watched.error || "unknown error"}`;
    this.#refreshStatus();
  }

  // With no watcher the only fresh answer is a rescan; scanFiles is
  // incremental and asynchronous, so each query stays cheap while the
  // index catches up.
  #rescanIfWatcherDown() {
    if (!this.fffWatchFailed && this.fffWatcherReady) return;
    try {
      this.finder?.scanFiles();
    } catch {}
  }

  #noteFffFreshness(finder) {
    const progressResult = finder.getScanProgress?.();
    if (!progressResult?.ok) return;
    const snap = progressResult.value;
    if (snap.isScanning) return;
    this.fffWatcherReady = snap.isWatcherReady !== false;
    if (this.fffWarning === "FFF initial scan is still running") {
      this.fffWarning = null;
    }
    if (snap.isWatcherReady === false) {
      this.fffWarning =
        this.fffWarning || "FFF watcher is not covering this root";
    } else if (this.fffWarning === "FFF watcher is not covering this root") {
      this.fffWarning = null;
    }
    if (snap.isWatcherReady && !this.lastSuccessfulSync) {
      this.lastSuccessfulSync = new Date().toISOString();
    }
  }

  #refreshStatus() {
    if (this.fffWarning || this.graphWarning) {
      this.status = "degraded";
      return;
    }
    if (this.finder && this.graphReady) {
      this.status = "ready";
      return;
    }
    this.status = "indexing";
  }

  touch() {
    this.lastAccess = Date.now();
    if (this.sharedGraph) touchGraphSource(this.sharedGraph, this.lastAccess);
    void this.#writeMetadata().catch(() => {});
  }

  async use(operation) {
    this.active += 1;
    this.touch();
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.touch();
    }
  }

  startGraphIndex(onProgress = () => {}) {
    this.graphProgressListeners.add(onProgress);
    if (!this.graphPromise) {
      this.graphPromise = this.#initializeGraph().catch((error) => {
        // A rejected promise must not be reused: the next query retries.
        this.graphPromise = null;
        this.graphWarning = `CodeGraph indexing failed: ${error.message}`;
        this.#refreshStatus();
        throw error;
      });
      this.graphPromise.catch(() => {});
    }
    return this.graphPromise.finally(() => {
      this.graphProgressListeners.delete(onProgress);
    });
  }

  // Opening a graph migrates and may index the database, which one SQLite writer
  // at a time can do. The lock lives next to the database so it covers every
  // process that could reach the same bucket, and is released once the worker
  // reports ready — queries after that run concurrently.
  async #initializeGraph() {
    const fingerprint = await worktreeFingerprint(this.root);
    const shared = await findSharedGraph(this.dataDir, {
      root: this.root,
      fingerprint,
      verify: (candidate) => worktreeFingerprint(candidate),
    });
    const held = await acquireLock(this.location.graphLock, {
      timeoutMs: GRAPH_LOCK_TIMEOUT_MS,
      label: `codegraph ${this.root}`,
    });
    try {
      if (shared) {
        try {
          return await this.#openGraph(fingerprint, shared);
        } catch (error) {
          // The source bucket can be reclaimed or replaced between the match
          // and the open; build our own index rather than fail the query.
          this.#teardownGraph(`shared graph unusable: ${error.message}`);
        }
      }
      return await this.#openGraph(fingerprint, null);
    } finally {
      held.release?.();
    }
  }

  async #openGraph(fingerprint, shared) {
    this.sharedGraph = shared;
    const graphDir = shared ? shared.graphDir : this.location.graphDir;
    if (shared) touchGraphSource(shared, this.lastAccess);
    else ensurePrivateDir(graphDir);
    const worker = fileURLToPath(new URL("./graph-worker.js", import.meta.url));
    const child = spawn(
      bundledNode(),
      ["--liftoff-only", worker, this.root],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CODEQ_CODEGRAPH_DATA_DIRS: JSON.stringify({
            [this.root]: graphDir,
          }),
          ...(shared ? { CODEQ_GRAPH_SHARED: "1" } : {}),
        },
      },
    );
    this.graphProcess = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      process.stderr.write(`[codegraph:${this.location.key.slice(0, 8)}] ${chunk}`);
    });
    child.stdout.setEncoding("utf8");

    return new Promise((resolve, reject) => {
      let output = "";
      let settled = false;
      const fail = (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      child.once("error", fail);
      child.once("exit", (code, signal) => {
        // teardown/dispose already accounted for this child; a stale exit
        // must not touch the worker that replaced it.
        if (this.graphProcess !== child) return;
        this.graphProcess = null;
        this.graphReady = false;
        const error = new Error(
          `CodeGraph worker exited (${signal || code || "unknown"})`,
        );
        if (settled) {
          // Past ready the init promise had resolved: clear it so the next
          // query spawns a fresh worker instead of writing to a dead one.
          this.graphPromise = null;
          this.graphWarning = error.message;
        }
        fail(error);
        for (const pending of this.graphPending.values()) pending.reject(error);
        this.graphPending.clear();
        this.#refreshStatus();
      });
      child.stdout.on("data", (chunk) => {
        output += chunk;
        for (;;) {
          const newline = output.indexOf("\n");
          if (newline < 0) break;
          const line = output.slice(0, newline);
          output = output.slice(newline + 1);
          if (!line) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.type === "progress") {
            for (const listener of this.graphProgressListeners) listener(message);
          } else if (message.type === "ready") {
            this.graphReady = true;
            this.lastSuccessfulSync = new Date().toISOString();
            this.graphWarning = null;
            // A shared index is read-only here by design, so its worker never
            // watches; this root revalidates the fingerprint on every query.
            if (!message.watching && !shared) {
              this.graphWarning = "CodeGraph watcher could not be started";
            }
            void this.#recordGraphFingerprint(fingerprint, shared).catch(
              () => {},
            );
            this.#refreshStatus();
            if (!settled) {
              settled = true;
              resolve();
            }
          } else if (message.type === "sync") {
            this.lastSuccessfulSync = message.at;
            this.graphWarning = null;
            this.#refreshStatus();
          } else if (message.type === "degraded") {
            this.graphWarning = `CodeGraph watcher degraded: ${message.reason}`;
            this.#refreshStatus();
          } else if (message.type === "response") {
            const pending = this.graphPending.get(message.id);
            if (!pending) continue;
            this.graphPending.delete(message.id);
            if (message.error) pending.reject(new Error(message.error));
            else {
              pending.resolve({
                text: message.result,
                symbols: Array.isArray(message.symbols) ? message.symbols : [],
              });
            }
          }
        }
      });
    });
  }

  // Publish the fingerprint only once the content it describes survived the
  // whole index run: a tree edited mid-index would otherwise offer another
  // worktree a database that matches neither fingerprint.
  async #recordGraphFingerprint(fingerprint, shared) {
    if (!fingerprint) return;
    if (!shared && (await worktreeFingerprint(this.root)) !== fingerprint) return;
    this.graphFingerprint = fingerprint;
    await this.#writeMetadata();
  }

  #teardownGraph(reason) {
    this.sharedGraph = null;
    this.graphFingerprint = null;
    this.graphReady = false;
    const error = new Error(reason);
    for (const pending of this.graphPending.values()) pending.reject(error);
    this.graphPending.clear();
    try {
      this.graphProcess?.stdin.end();
      this.graphProcess?.kill("SIGTERM");
    } catch {}
    this.graphProcess = null;
  }

  // A shared index is another worktree's database. It answers for this root
  // only while both trees still hash to the fingerprint it was built from, so
  // any edit on either side drops the share and re-indexes here.
  async #revalidateSharedGraph(onProgress) {
    const shared = this.sharedGraph;
    const [mine, theirs] = await Promise.all([
      worktreeFingerprint(this.root),
      worktreeFingerprint(shared.root),
    ]);
    // A concurrent query may have dropped the share while we were hashing;
    // whatever it started is the index to wait for.
    if (this.sharedGraph !== shared) {
      await this.startGraphIndex(onProgress);
      return;
    }
    if (mine === shared.fingerprint && theirs === shared.fingerprint) return;
    this.#teardownGraph("shared graph index no longer matches this worktree");
    this.graphPromise = null;
    await this.startGraphIndex(onProgress);
  }

  metadata() {
    if (this.finder) this.#noteFffFreshness(this.finder);
    this.#refreshStatus();
    return {
      root: this.root,
      status: this.status,
      fffWarning: this.fffWarning,
      graphWarning: this.graphWarning,
      lastSuccessfulSync: this.lastSuccessfulSync,
    };
  }

  async find(query, options) {
    const finder = await this.fffPromise;
    this.#rescanIfWatcherDown();
    const plan = planFindSearch(query, options.constraint);
    const { value, globFallback } = runFindSearch(plan, (needle) =>
      unwrap(
        finder.fileSearch(needle, { pageSize: RANK_WINDOW }),
        "FFF file search failed",
      ),
    );
    const mapped = value.items.map((item, index) => ({
      path: item.relativePath,
      size: item.size,
      modified: item.modified,
      gitStatus: item.gitStatus,
      score: value.scores[index]?.total ?? null,
      matchType: value.scores[index]?.matchType ?? null,
    }));
    return {
      ...this.metadata(),
      query,
      total: value.totalMatched,
      indexed: value.totalFiles ?? null,
      results: applyFindWindow(mapped, options.limit),
      preserveOrder: true,
      ...pageMeta(options),
      ...(globFallback ? { globFallback } : {}),
    };
  }

  async grep(pattern, options) {
    const regex = Boolean(options.regex);
    const fuzzyRequested = Boolean(options.fuzzy);
    const mode = assertGrepPattern(pattern, { regex });
    const finder = await this.fffPromise;
    this.#rescanIfWatcherDown();
    const constraints = [];
    if (options.constraint) constraints.push(options.constraint);
    if (options.glob) constraints.push(options.glob);
    const query = [...constraints, pattern].join(" ");
    const context = clampGrepContext(options.context);
    const contextCapped =
      Number.isSafeInteger(options.context) && options.context > CONTEXT_CAP;
    const ignoreCaseBound = ignoreCaseCursorValue(options.ignoreCase);
    const search = {
      root: this.root,
      pattern,
      glob: options.glob || "",
      constraint: options.constraint || "",
      regex,
      fuzzy: fuzzyRequested,
      context,
      ignoreCase: ignoreCaseBound,
    };
    if (options.count) {
      if (options.cursor) throw new Error(GREP_COUNT_CURSOR_ERROR);
      return this.#grepCount({
        finder,
        query,
        pattern,
        mode,
        regex,
        fuzzyRequested,
        ignoreCase: options.ignoreCase,
      });
    }
    const grepOptions = fffGrepOptions({
      mode,
      ignoreCase: options.ignoreCase,
      context,
    });
    let windowStart = 0;
    let rankedOffset = 0;
    if (options.cursor) {
      const opened = openGrepCursor(options.cursor, search);
      grepOptions.mode = opened.mode;
      windowStart = opened.window;
      rankedOffset = opened.offset;
      if (windowStart > 0) grepOptions.cursor = toFffCursor(windowStart);
    }
    let value = unwrap(finder.grep(query, grepOptions), "FFF content search failed");
    let usedFuzzy = grepOptions.mode === "fuzzy";
    if (
      !options.cursor &&
      fuzzyRequested &&
      value.items.length === 0 &&
      mode !== "regex"
    ) {
      const fuzzy = unwrap(
        finder.grep(query, {
          ...grepOptions,
          mode: "fuzzy",
          cursor: null,
          beforeContext: 0,
          afterContext: 0,
        }),
        "FFF fuzzy content search failed",
      );
      if (fuzzy.items.length > 0) {
        value = fuzzy;
        usedFuzzy = true;
      }
    }
    const mapped = value.items.map(mapGrepHit);
    const { ranked, page } = applyGrepWindow(
      mapped,
      pattern,
      options.limit,
      rankedOffset,
    );
    const pageMode = usedFuzzy ? "fuzzy" : grepOptions.mode;
    const nextCursor = encodeNextGrepCursor(
      { ...search, mode: pageMode },
      {
        rankedLength: ranked.length,
        offset: rankedOffset,
        pageLength: page.length,
        windowStart,
        fffNextOffset: grepCursorOffset(value.nextCursor),
      },
    );
    return {
      ...this.metadata(),
      pattern,
      mode: pageMode,
      regex,
      fuzzyRequested,
      shown: page.length,
      nextCursor,
      results: page,
      context,
      contextCapped,
      ...pageMeta(options),
    };
  }

  async #grepCount({
    finder,
    query,
    pattern,
    mode,
    regex,
    fuzzyRequested,
    ignoreCase,
  }) {
    const grepOptions = fffGrepOptions({
      mode,
      ignoreCase,
      context: 0,
    });
    let value = unwrap(finder.grep(query, grepOptions), "FFF content search failed");
    let usedFuzzy = grepOptions.mode === "fuzzy";
    if (fuzzyRequested && value.items.length === 0 && mode !== "regex") {
      const fuzzy = unwrap(
        finder.grep(query, { ...grepOptions, mode: "fuzzy", cursor: null }),
        "FFF fuzzy content search failed",
      );
      if (fuzzy.items.length > 0) {
        value = fuzzy;
        usedFuzzy = true;
        grepOptions.mode = "fuzzy";
      }
    }
    let matchCount = 0;
    const files = new Set();
    let moreRemain = false;
    let current = value;
    while (true) {
      for (const item of current.items) {
        if (matchCount >= COUNT_SCAN_CAP) {
          moreRemain = true;
          break;
        }
        matchCount += 1;
        files.add(item.relativePath);
      }
      if (moreRemain) break;
      const next = grepCursorOffset(current.nextCursor);
      if (!Number.isSafeInteger(next) || next <= 0) break;
      if (current.items.length === 0) break;
      current = unwrap(
        finder.grep(query, { ...grepOptions, cursor: toFffCursor(next) }),
        "FFF content search failed",
      );
    }
    return {
      ...this.metadata(),
      pattern,
      mode: usedFuzzy ? "fuzzy" : grepOptions.mode,
      regex,
      fuzzyRequested,
      count: true,
      matchCount,
      fileCount: files.size,
      countTruncated: moreRemain,
      shown: 0,
      nextCursor: null,
      results: [],
      context: 0,
      contextCapped: false,
      ...pageMeta({}),
    };
  }

  async explore(query, options, onProgress) {
    await this.startGraphIndex(onProgress);
    if (this.sharedGraph) await this.#revalidateSharedGraph(onProgress);
    const scoped = options.constraint
      ? `${query} path:${options.constraint.replace(/\/$/, "")}`
      : query;
    const id = ++this.graphSequence;
    const payload = await new Promise((resolve, reject) => {
      const worker = this.graphProcess;
      if (!worker || worker.exitCode !== null || worker.signalCode !== null) {
        reject(
          new Error(this.graphWarning || "CodeGraph worker is not running"),
        );
        return;
      }
      this.graphPending.set(id, { resolve, reject });
      worker.stdin.write(`${JSON.stringify({ id, query: scoped })}\n`);
    });
    const text = typeof payload === "string" ? payload : payload.text;
    const symbols = typeof payload === "string" ? [] : payload.symbols || [];
    return {
      ...this.metadata(),
      query,
      constraint: options.constraint || null,
      result: text,
      symbols,
    };
  }

  dispose() {
    try {
      this.fffUnwatch?.();
    } catch {}
    this.fffUnwatch = null;
    try {
      this.finder?.destroy();
    } catch {}
    const error = new Error("root context was evicted");
    for (const pending of this.graphPending.values()) pending.reject(error);
    this.graphPending.clear();
    try {
      this.graphProcess?.stdin.end();
      this.graphProcess?.kill("SIGTERM");
    } catch {}
    this.finder = null;
    this.graphReady = false;
    this.graphProcess = null;
  }
}
