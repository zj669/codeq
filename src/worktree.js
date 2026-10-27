import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
// Hashing is proportional to the dirty files, not the tree, so the cap only
// protects the pathological case (a wholesale uncommitted import). Past it the
// worktree simply has no fingerprint and keeps its own index.
const DIRTY_FILE_CAP = 200;
const SCHEME = "codeq-worktree-1";
const DELETED = "deleted";

async function git(root, args) {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout;
}

function canonical(input) {
  try {
    return realpathSync(input);
  } catch {
    return resolve(input);
  }
}

function parseStatus(output) {
  const entries = [];
  for (const record of output.split("\0")) {
    if (record.length < 4) continue;
    entries.push({ code: record.slice(0, 2), path: record.slice(3) });
  }
  return entries;
}

// The worktree bytes, not the index: a staged-only change still makes this tree
// differ from HEAD, and codegraph indexes what is on disk.
async function worktreeBlobs(root, paths) {
  if (paths.length === 0) return new Map();
  const present = [];
  const blobs = new Map();
  for (const path of paths) {
    let stat;
    try {
      stat = lstatSync(resolve(root, path));
    } catch {
      blobs.set(path, DELETED);
      continue;
    }
    // A dirty submodule or a symlink has no single blob we can compare cheaply.
    if (!stat.isFile()) return null;
    present.push(path);
  }
  if (present.length > 0) {
    const hashes = (await git(root, ["hash-object", "--", ...present]))
      .split("\n")
      .filter((line) => line.length > 0);
    if (hashes.length !== present.length) return null;
    present.forEach((path, index) => blobs.set(path, hashes[index]));
  }
  return blobs;
}

/**
 * Content identity of a git worktree: the repository it belongs to, the commit
 * it has checked out, and the blob hash of every file that differs from that
 * commit. Two worktrees with the same fingerprint hold the same tracked bytes,
 * so one code graph describes both. Null means "no cheap identity available"
 * (not a git worktree, unborn HEAD, dirty in a way we cannot hash), which
 * callers must read as "do not share".
 */
export async function worktreeFingerprint(root) {
  try {
    const toplevel = canonical((await git(root, ["rev-parse", "--show-toplevel"])).trim());
    if (toplevel !== canonical(root)) return null;
    const commonDir = canonical(
      (
        await git(root, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ])
      ).trim(),
    );
    const head = (await git(root, ["rev-parse", "HEAD"])).trim();
    if (!/^[0-9a-f]{40,}$/.test(head)) return null;
    const status = parseStatus(
      await git(root, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--no-renames",
      ]),
    );
    if (status.length > DIRTY_FILE_CAP) return null;
    const blobs = await worktreeBlobs(
      root,
      status.map((entry) => entry.path),
    );
    if (!blobs) return null;
    const dirty = status
      .map((entry) => `${entry.code}\t${blobs.get(entry.path)}\t${entry.path}`)
      .sort();
    const digest = createHash("sha256");
    digest.update(`${SCHEME}\n${commonDir}\n${head}\n${dirty.length}\n`);
    for (const line of dirty) digest.update(`${line}\n`);
    return digest.digest("hex");
  } catch {
    return null;
  }
}
