import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { breakStaleLock } from "./lock.js";
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
    });
  }
  return sources.sort((a, b) => a.key.localeCompare(b.key));
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
    breakStaleLock(join(source.bucket, "codegraph.lock"));
    if (existsSync(join(source.bucket, "codegraph.lock"))) continue;
    if ((await verify(source.root)) !== fingerprint) continue;
    return source;
  }
  return null;
}

// Index GC reclaims by last access, and a shared source is only read through
// another root, so its own bucket would look cold while it is in use.
export function touchGraphSource(source, now) {
  const path = join(source.bucket, "root.json");
  const meta = readMetadata(source.bucket);
  if (!meta) return;
  meta.lastAccessedAt = new Date(now).toISOString();
  try {
    writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`);
    ensurePrivateFile(path);
  } catch {}
}
