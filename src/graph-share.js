import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { acquireLock, breakStaleLock, tryAcquireLock } from "./lock.js";
import { ensurePrivateFile, rootsDir } from "./paths.js";

// Two checkouts of one repository at the same content hold the same graph, so
// the second one reads the first one's database instead of building a copy.
// The source is whichever bucket recorded that fingerprint; an attached root
// never becomes a source itself, so the chain is one hop deep.

function readMetadata(bucket) {
  try {
    const value = JSON.parse(readFileSync(join(bucket, "root.json"), "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function listGraphSources(base) {
  const root = rootsDir(base);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const sources = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const bucket = join(root, entry.name);
    const meta = readMetadata(bucket);
    if (!meta || typeof meta.root !== "string") continue;
    if (typeof meta.graphFingerprint !== "string") continue;
    if (meta.sharedGraphRoot) continue;
    const graphDir = join(bucket, "codegraph");
    if (!existsSync(join(graphDir, "codegraph.db"))) continue;
    sources.push({
      key: entry.name,
      bucket,
      graphDir,
      root: meta.root,
      fingerprint: meta.graphFingerprint,
      lock: join(bucket, "codegraph.lock"),
    });
  }
  return sources.sort((a, b) => a.key.localeCompare(b.key));
}

// Cold-start convergence: a worktree's fingerprint is only published once its
// index finished, so two identical worktrees starting together would each find
// no source and build a full index apiece. A per-fingerprint claim lock makes
// the first build visible to the rest: same-fingerprint roots queue inside
// acquireLock until the build finishes, then re-scan for a shared source
// instead of indexing in parallel. Claims live outside roots/ so bucket GC
// never reaps a live claim; a released file is stale-cleanup material, and
// the source's bucket metadata is what proves a finished index.
const CLAIM_STALE_MS = 60_000;
const CLAIM_TIMEOUT_MS = 15 * 60 * 1_000;

function claimPath(base, fingerprint) {
  return join(base, "graph-claims", `${fingerprint}.lock`);
}

/**
 * Take this fingerprint's build claim. The first root holds it for the whole
 * open-or-build, so followers block until the source index is finished and
 * published, then return `waited: true` for the caller to re-scan before
 * building its own. A claim that outlives the wait budget stops serializing —
 * the per-bucket graph lock still keeps two databases independent, and a
 * redundant copy is GC'd once a shared index proves usable.
 */
export async function acquireGraphBuildClaim(base, { fingerprint, root }) {
  const path = claimPath(base, fingerprint);
  const immediate = tryAcquireLock(path, `graph build ${root}`);
  if (immediate) return { release: immediate, waited: false };
  try {
    const held = await acquireLock(path, {
      timeoutMs: CLAIM_TIMEOUT_MS,
      pollMs: 100,
      staleMs: CLAIM_STALE_MS,
      label: `graph build ${root}`,
    });
    return { release: held.release, waited: true };
  } catch {
    return { release: null, waited: true };
  }
}

/**
 * The index another root already built for exactly this content, or null.
 *
 * Three things must agree: the fingerprint the source's index was built from,
 * the source worktree's fingerprint right now, and ours. The live check on the
 * source is what makes a changed source stop being shareable — its watcher
 * keeps writing into that database, so a stale source would hand us its
 * content, not ours.
 */
export async function findSharedGraph(base, { root, fingerprint, verify }) {
  if (!fingerprint) return null;
  for (const source of listGraphSources(base)) {
    if (source.root === root) continue;
    if (source.fingerprint !== fingerprint) continue;
    if (!existsSync(source.root)) continue;
    // A locked bucket is being indexed or migrated by another process.
    breakStaleLock(source.lock);
    if (existsSync(source.lock)) continue;
    if ((await verify(source.root)) !== fingerprint) continue;
    return source;
  }
  return null;
}

// Index GC reclaims by last access, and a shared source is only read through
// another root, so its own bucket would look cold while it is in use. The
// owner's own context republishes this same file with a temp+rename, so the
// touch must publish atomically too: an in-place write can be read mid-truncate
// by listGraphSources/listRootIndexes, which treat invalid JSON as "no share
// here" and let GC reclaim a bucket that is actively serving a follower.
// This runs once per query against a shared graph, so the write races
// findSharedGraph's readMetadata and the GC's — publish atomically
// (temp + rename, same pattern as RootContext.#writeMetadata) so a reader
// never sees a truncated root.json. The temp name is unique per call:
// concurrent touches rename independently.
export function touchGraphSource(source, now) {
  const path = join(source.bucket, "root.json");
  const meta = readMetadata(source.bucket);
  if (!meta) return;
  meta.lastAccessedAt = new Date(now).toISOString();
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(meta, null, 2)}\n`);
    renameSync(temp, path);
    ensurePrivateFile(path);
  } catch {
    // A failed or killed write leaves only this unique temp — root.json stays
    // whole. Best-effort cleanup; a crashed process's temp is swept by bucket GC.
    try {
      rmSync(temp, { force: true });
    } catch {}
  }
}

// A follower that just proved a shared index answers for it still may own the
// database it built before the source existed. That copy is dead weight the
// TTL sweep would hold for days, so drop it now — but only while the source's
// graph lock is held. The shared worker does not watch the source's own tree,
// so the bucket owner could otherwise open the database for a rebuild right
// between our check and our delete; inside the lock nobody opens it until the
// owner itself is ready to write, which also means it has stopped sharing.
// The lock check is not atomic with the removal, so bail instead of removing
// whenever the lock cannot be taken, and never touch the bucket's metadata —
// the directory delete is idempotent, a crashed removal just retries next time.
export function releaseSupersededGraph(source, ownGraphDir) {
  if (!existsSync(join(ownGraphDir, "codegraph.db"))) return false;
  const release = tryAcquireLock(
    source.lock,
    `superseded-by ${source.root}`,
  );
  if (!release) return false;
  try {
    rmSync(ownGraphDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  } finally {
    release();
  }
}
