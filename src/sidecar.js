import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  SIDECAR_COUNT_CAP,
  SIDECAR_FILE_MAX_BYTES,
  SIDECAR_MAX_BYTES,
  SIDECAR_TTL_MS,
  SIDECAR_WINDOW,
} from "./limits.js";
import { dataHome } from "./paths.js";

export { SIDECAR_WINDOW };

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function sidecarDir(base = dataHome()) {
  return join(base, "sidecars");
}

function insideRoot(root, filePath) {
  if (!root || filePath == null || String(filePath).trim() === "") return null;
  const base = resolve(root);
  const absolute = resolve(base, String(filePath));
  const rel = relative(base, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return absolute;
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, DIR_MODE);
  } catch {}
}

function fileStamp(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

export function sweepSidecars(base = dataHome(), now = Date.now()) {
  const dir = sidecarDir(base);
  if (!existsSync(dir)) return;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const remain = [];
  for (const name of names) {
    const path = join(dir, name);
    const stat = fileStamp(path);
    if (!stat || !stat.isFile()) continue;
    if (now - stat.mtimeMs > SIDECAR_TTL_MS) {
      try {
        unlinkSync(path);
      } catch {}
      continue;
    }
    remain.push({ path, mtime: stat.mtimeMs });
  }
  remain.sort((a, b) => b.mtime - a.mtime);
  for (const extra of remain.slice(SIDECAR_COUNT_CAP)) {
    try {
      unlinkSync(extra.path);
    } catch {}
  }
}

function shortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 8);
}

function uniqueName(command, root, query) {
  const stamp = `${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
  return `${shortHash(root)}-${command}-${shortHash(query)}-${stamp}.txt`;
}

function readSource(root, relativePath) {
  const absolute = insideRoot(root, relativePath);
  if (!absolute) return null;
  try {
    const text = readFileSync(absolute, { encoding: "utf8" });
    if (text.includes("\u0000")) return null;
    const lines = text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return { lines };
  } catch {
    return null;
  }
}

function mergeRanges(ranges) {
  const sorted = [...ranges].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  );
  const out = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      out.push({ start: range.start, end: range.end });
    }
  }
  return out;
}

function clampRange(start, end, lineCount) {
  const lo = Math.max(1, start);
  const hi = Math.min(lineCount, end);
  if (lineCount < 1 || lo > hi) return null;
  return { start: lo, end: hi };
}

export function sidecarTailLine(sidecar) {
  if (!sidecar?.path) return "";
  if (sidecar.integrity === "complete") {
    return `sidecar complete ${sidecar.path} — at most one Read, of this file`;
  }
  return `sidecar partial ${sidecar.path} — skip this file; at most one Read of the source span`;
}

export function isSidecarTail(line) {
  return /^sidecar (complete|partial) /.test(String(line));
}

export function reliableSpan(hit) {
  const start = hit?.startLine;
  const end = hit?.endLine;
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 1 &&
    end >= start
  );
}

export function grepExcerptWindow(hit, window = SIDECAR_WINDOW) {
  if (reliableSpan(hit)) {
    return { path: hit.path, start: hit.startLine, end: hit.endLine };
  }
  const line = Number(hit?.line);
  if (!Number.isSafeInteger(line) || line < 1 || !hit?.path) return null;
  return { path: hit.path, start: line - window, end: line + window };
}

export function writeSidecar(
  {
    command,
    root,
    query = "",
    fuzzy = false,
    excerpts = [],
  } = {},
  {
    base = dataHome(),
    maxBytes = SIDECAR_MAX_BYTES,
    fileMaxBytes = SIDECAR_FILE_MAX_BYTES,
    now = Date.now(),
  } = {},
) {
  if (!root || !Array.isArray(excerpts) || excerpts.length === 0) return null;

  const grouped = new Map();
  const order = [];
  for (const excerpt of excerpts) {
    if (!excerpt?.path) continue;
    if (!grouped.has(excerpt.path)) {
      grouped.set(excerpt.path, []);
      order.push(excerpt.path);
    }
    grouped.get(excerpt.path).push({
      start: excerpt.start,
      end: excerpt.end,
    });
  }
  if (order.length === 0) return null;

  const omitted = [];
  const emitted = new Map();
  const requested = [];
  const bodyLines = [];
  let total = 0;

  const headerLines = [
    "codeq sidecar",
    `tool ${command}`,
    `root ${root}`,
  ];
  if (fuzzy) headerLines.push("[fuzzy]");
  headerLines.push("integrity complete", "");
  total = Buffer.byteLength(`${headerLines.join("\n")}\n`, "utf8");

  function emitLine(text) {
    const size = Buffer.byteLength(`${text}\n`, "utf8");
    if (total + size > maxBytes) return { ok: false, size };
    bodyLines.push(text);
    total += size;
    return { ok: true, size };
  }

  outer: for (const path of order) {
    const source = readSource(root, path);
    if (!source) {
      omitted.push(`${path} unreadable`);
      continue;
    }
    const ranges = mergeRanges(grouped.get(path) || [])
      .map((range) => clampRange(range.start, range.end, source.lines.length))
      .filter(Boolean);
    if (ranges.length === 0) {
      omitted.push(`${path} empty`);
      continue;
    }
    for (const range of ranges) requested.push({ path, ...range });

    let fileBytes = 0;
    if (bodyLines.length > 0) {
      if (!emitLine("").ok) {
        omitted.push(`${path} sidecar cap`);
        break;
      }
    }
    if (!emitLine(path).ok) {
      omitted.push(`${path} sidecar cap`);
      break;
    }

    for (const range of ranges) {
      for (let n = range.start; n <= range.end; n += 1) {
        const line = `${path}:${n} ${source.lines[n - 1] ?? ""}`;
        const size = Buffer.byteLength(`${line}\n`, "utf8");
        if (total + size > maxBytes) {
          omitted.push(`${path}:${n}-${range.end} sidecar cap`);
          break outer;
        }
        if (fileBytes + size > fileMaxBytes) {
          omitted.push(`${path}:${n}-${range.end} file cap`);
          break;
        }
        bodyLines.push(line);
        total += size;
        fileBytes += size;
        let set = emitted.get(path);
        if (!set) {
          set = new Set();
          emitted.set(path, set);
        }
        set.add(n);
      }
    }
  }

  if (emitted.size === 0) return null;

  let complete = omitted.length === 0;
  if (complete) {
    for (const item of requested) {
      const lines = emitted.get(item.path);
      if (!lines) {
        complete = false;
        break;
      }
      for (let n = item.start; n <= item.end; n += 1) {
        if (!lines.has(n)) {
          complete = false;
          break;
        }
      }
      if (!complete) break;
    }
  }

  const integrity = complete ? "complete" : "partial";
  headerLines[headerLines.length - 2] = `integrity ${integrity}`;
  const omittedBlock =
    omitted.length > 0 ? ["", ...omitted.map((item) => `omitted ${item}`)] : [];
  const body = [...headerLines, ...bodyLines, ...omittedBlock, ""].join("\n");

  let tmpPath;
  try {
    sweepSidecars(base, now);
    const dir = sidecarDir(base);
    ensureDir(dir);
    const name = uniqueName(command, root, query);
    const finalPath = join(dir, name);
    tmpPath = `${finalPath}.tmp`;
    writeFileSync(tmpPath, body, { encoding: "utf8" });
    chmodSync(tmpPath, FILE_MODE);
    renameSync(tmpPath, finalPath);
    chmodSync(finalPath, FILE_MODE);
    return {
      path: finalPath,
      integrity,
      omitted: [...omitted],
    };
  } catch {
    if (tmpPath) {
      try {
        unlinkSync(tmpPath);
      } catch {}
    }
    return null;
  }
}
