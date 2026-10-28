import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { rename, rm, writeFile } from "node:fs/promises";
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
  GREP_CAP,
  GREP_SCAN_CAP,
  pageLimit,
  RANK_WINDOW,
} from "./limits.js";
import { applyFindWindow, applyGrepWindow, pathTier } from "./path-tier.js";
import {
  ensurePrivateDir,
  ensurePrivateFile,
  rootBucket,
} from "./paths.js";
import {
  acquireGraphBuildClaim,
  findSharedGraph,
  releaseSupersededGraph,
  touchGraphSource,
} from "./graph-share.js";
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
    this.instance = randomBytes(3).toString("hex");
    this.metadataSequence = 0;
    this.lastSuccessfulSync = null;
    this.finder = null;
    this.graphReady = false;
    this.graphProcess = null;
    this.graphPending = new Map();
    this.graphSequence = 0;
    this.graphProgressListeners = new Set();
    // Files the graph watcher saw change but has not synced yet (unioned with
    // the worker's disk-vs-index diff). Their locators may point at old lines.
    this.graphStale = new Set();
    this.stalePollPending = null;
    this.fffUnwatch = null;
    this.fffPromise = this.#initializeFff();
    this.graphPromise = null;
    // Set once a graph index exists for this root: the content fingerprint it
    // was built from, and the root that owns it when it is not ours.
    this.graphFingerprint = null;
    this.sharedGraph = null;
  }

  // Other processes parse root.json (index sharing, tests): a torn write
  // reads as invalid JSON, so publish atomically. The temp name must be
  // unique per call and per writer: two contexts in this process can write
  // the same bucket (an evicted root's in-flight publish overlapping its
  // replacement's first), and a shared pid+sequence collides on the temp
  // file — the loser of the double rename gets ENOENT and its FFF init dies.
  async #writeMetadata() {
    ensurePrivateDir(this.location.bucket);
    const temp = `${this.location.metadata}.${process.pid}.${this.instance}.${++this.metadataSequence}.tmp`;
    try {
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
    } catch (error) {
      // The target stays whole on a failed write; drop our unique temp.
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async #initializeFff() {
    await this.#writeMetadata();
    const created = FileFinder.create({
      basePath: this.root,
      aiMode: true,
      disableWatch: process.env.CODEQ_FFF_DISABLE_WATCH === "1",
    });
    this.finder = unwrap(created, "FFF initialization failed");
    const scanned = unwrap(
      await this.finder.waitForIndexReady(60_000),
      "FFF initial scan failed",
    );
    if (!scanned) {
      this.fffWarning = "FFF initial scan is still running";
    }
    // watch() rejects until the first scan completes; subscribing earlier
    // marked every root watcher-dead, so each query rescan raced the grep.
    this.#subscribeFffWatch();
    this.#noteFffFreshness(this.finder);
    this.#refreshStatus();
    return this.finder;
  }

  #subscribeFffWatch() {
    if (!this.finder?.watch) return;
    let watched;
    try {
      watched = this.finder.watch((events) => {
        if (!events?.some((event) => event.kind === "rescan")) return;
        this.fffWarning = "FFF missed filesystem events and is rescanning";
        this.#refreshStatus();
        try {
          this.finder.scanFiles();
        } catch {}
      });
    } catch (error) {
      watched = { ok: false, error: error?.message || String(error) };
    }
    if (watched.ok) {
      this.fffUnwatch = watched.value;
      this.fffWatchFailed = false;
      if (this.fffWarning?.startsWith("FFF watcher failed")) {
        this.fffWarning = null;
      }
      this.#refreshStatus();
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
    // The first subscribe can run before the watcher arms (slow scans); retry
    // once fff reports it ready instead of staying in rescan mode forever.
    if (this.fffWatchFailed && snap.isWatcherReady) {
      this.#subscribeFffWatch();
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
    let shared = await findSharedGraph(this.dataDir, {
      root: this.root,
      fingerprint,
      verify: (candidate) => worktreeFingerprint(candidate),
    });
    // Identical worktrees cold-starting together all pass findSharedGraph
    // before anyone has published. The fingerprint claim serializes the first
    // build: followers wait here, then re-scan — the winner's bucket is now a
    // finished source they attach to instead of indexing a second copy. A
    // finished-but-failed build leaves the claim released with nothing to
    // share, so the next follower simply takes the claim and retries itself.
    const claim = fingerprint
      ? await acquireGraphBuildClaim(this.dataDir, {
          fingerprint,
          root: this.root,
        })
      : { release: null, waited: false };
    const waited = claim.waited;
    try {
      if (waited) {
        // We queued behind another root's build (or its claim timed out): the
        // winner's bucket is the one to read now, and a finished-but-failed
        // build simply finds nothing so we build our own.
        shared = await findSharedGraph(this.dataDir, {
          root: this.root,
          fingerprint,
          verify: (candidate) => worktreeFingerprint(candidate),
        });
      }
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
    } finally {
      claim.release?.();
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
          } else if (message.type === "stale") {
            for (const path of message.files || []) this.graphStale.add(path);
          } else if (message.type === "stale-report") {
            const pending = this.stalePollPending;
            if (pending && pending.id === message.id) {
              this.stalePollPending = null;
              this.graphStale = new Set(message.files || []);
              pending.resolve();
            }
          } else if (message.type === "ready") {
            this.graphReady = true;
            this.lastSuccessfulSync = new Date().toISOString();
            this.graphWarning = null;
            // A shared index is read-only here by design, so its worker never
            // watches; this root revalidates the fingerprint on every query.
            if (!message.watching && !shared) {
              this.graphWarning = "CodeGraph watcher could not be started";
            }
            // Not fire-and-forget: the build claim is only released once the
            // caller settles, and followers re-scan right after — the bucket
            // must already advertise the fingerprint they are waiting for.
            const publish = this.#recordGraphFingerprint(
              fingerprint,
              shared,
            ).catch(() => {});
            // Only now — the shared worker answered ready — is our own old
            // database provably redundant; deleting before ready could remove
            // the only usable index while the share still fails to open.
            if (shared) {
              releaseSupersededGraph(shared, this.location.graphDir);
            }
            this.#refreshStatus();
            if (!settled) {
              settled = true;
              // A cold-start follower wakes from the claim the moment the
              // build finishes and immediately re-scans sources; resolving
              // before root.json carries the fingerprint would send it off to
              // build a second index.
              void publish.finally(resolve);
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
              if (Array.isArray(message.stale)) {
                this.graphStale = new Set(message.stale);
              }
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
    this.graphStale = new Set();
    this.stalePollPending = null;
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

  // The worker owns the authoritative stale list; ask it for a fresh diff so
  // a query issued between "file written" and "watcher synced" still marks
  // that file's locators instead of serving old line numbers as current.
  #pollGraphStale() {
    const worker = this.graphProcess;
    if (!this.graphReady || !worker || worker.exitCode !== null || this.stalePollPending) {
      return Promise.resolve();
    }
    const id = ++this.graphSequence;
    return new Promise((resolve) => {
      this.stalePollPending = { id, resolve };
      try {
        worker.stdin.write(`${JSON.stringify({ id, command: "stale" })}\n`);
      } catch {
        this.stalePollPending = null;
        resolve();
        return;
      }
      setTimeout(() => {
        if (this.stalePollPending?.id === id) {
          this.stalePollPending = null;
          resolve();
        }
      }, 500).unref();
    });
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
      stalePaths: [...this.graphStale],
    };
  }

  async find(query, options) {
    const finder = await this.fffPromise;
    this.#rescanIfWatcherDown();
    await this.#pollGraphStale();
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
    await this.#pollGraphStale();
    const constraints = [];
    if (options.constraint) constraints.push(options.constraint);
    if (options.glob) constraints.push(options.glob);
    const query = [...constraints, pattern].join(" ");
    // A continuation call that omits context defers to the cursor's bound
    // value; see openGrepCursor. Clamp happens after that resolution.
    const contextRequested = Number.isSafeInteger(options.context);
    let context = clampGrepContext(options.context);
    const contextCapped = contextRequested && options.context > CONTEXT_CAP;
    const ignoreCaseBound = ignoreCaseCursorValue(options.ignoreCase);
    const search = {
      root: this.root,
      pattern,
      glob: options.glob || "",
      constraint: options.constraint || "",
      regex,
      fuzzy: fuzzyRequested,
      // Unresolved until the cursor path runs: an omitted context stays
      // non-integer so openGrepCursor can adopt the token's bound value.
      context: contextRequested ? context : options.context,
      ignoreCase: ignoreCaseBound,
      limit: options.limit,
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
      if (!contextRequested) {
        context = clampGrepContext(opened.context);
        search.context = context;
        grepOptions.beforeContext = context;
        grepOptions.afterContext = context;
      }
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
        // Deeper pages must follow the fuzzy stream's own cursor offsets.
        grepOptions.mode = "fuzzy";
      }
    }
    // Ranking happens after collection, so the pool must reach the production
    // hits: FFF serves docs first, and a single RANK_WINDOW page can hold none.
    // Keep fetching while production hits are still arriving — stop once a
    // whole page passes without one, or at the scan cap.
    const mapped = [];
    let tier0Hits = 0;
    let sinceTier0 = 0;
    let fffNext = null;
    const collect = (batch) => {
      for (const item of batch.items) {
        if (pathTier(item.relativePath) === 0) {
          tier0Hits += 1;
          sinceTier0 = 0;
        } else {
          sinceTier0 += 1;
        }
        mapped.push(mapGrepHit(item));
      }
      fffNext = grepCursorOffset(batch.nextCursor);
    };
    collect(value);
    const pageSize = pageLimit(options.limit, RANK_WINDOW, GREP_CAP);
    while (
      Number.isSafeInteger(fffNext) &&
      fffNext > 0 &&
      mapped.length < GREP_SCAN_CAP
    ) {
      const more = unwrap(
        finder.grep(query, { ...grepOptions, cursor: toFffCursor(fffNext) }),
        "FFF content search failed",
      );
      collect(more);
      if (more.items.length === 0) break;
      if (tier0Hits >= pageSize && sinceTier0 >= RANK_WINDOW) break;
    }
    const { ranked, page } = applyGrepWindow(
      mapped,
      pattern,
      options.limit,
      rankedOffset,
    );
    for (const hit of page) {
      if (this.graphStale.has(hit.path)) hit.stale = true;
    }
    const pageMode = usedFuzzy ? "fuzzy" : grepOptions.mode;
    const nextCursor = encodeNextGrepCursor(
      { ...search, mode: pageMode },
      {
        rankedLength: ranked.length,
        offset: rankedOffset,
        pageLength: page.length,
        windowStart,
        fffNextOffset: fffNext,
      },
    );
    return {
      ...this.metadata(),
      pattern,
      mode: pageMode,
      regex,
      fuzzyRequested,
      shown: page.length,
      // Ranked-pool size known so far: lower bound on the true total while
      // FFF still has hits, exact once it does not. The formatter prefers it
      // over shown so a truncated page can say "16/48 shown".
      total: ranked.length,
      rankedExhausted: !Number.isSafeInteger(fffNext) || fffNext <= 0,
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
    if (options?.wait === false && !this.graphReady) {
      // Opt-in non-blocking: a cold graph call normally stalls for the whole
      // index build. wait:false starts the build and answers provisionally —
      // the same call without wait still blocks until ready.
      this.startGraphIndex(onProgress).catch(() => {});
      return {
        ...this.metadata(),
        query,
        constraint: options.constraint || null,
        result: "",
        symbols: [],
      };
    }
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
