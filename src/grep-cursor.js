export const GREP_CURSOR_VERSION = 5;

export const GREP_CURSOR_ERROR =
  "grep cursor is not valid for this search. It is opaque and bound to the same root, pattern, glob, path, regex, fuzzy, context, ignoreCase, and limit as the call that issued it. Pass that cursor back unchanged. A mismatch or a stale cursor is an error, not page 1.";

export const GREP_COUNT_CURSOR_ERROR =
  "grep count does not accept cursor";

function canonical(value) {
  return String(value ?? "");
}

function payloadFor(search) {
  const context = Number.isSafeInteger(search.context) ? search.context : 0;
  const ignoreCase =
    search.ignoreCase === "true" || search.ignoreCase === "false"
      ? search.ignoreCase
      : "default";
  return {
    v: GREP_CURSOR_VERSION,
    root: canonical(search.root),
    pattern: canonical(search.pattern),
    glob: canonical(search.glob),
    constraint: canonical(search.constraint),
    regex: Boolean(search.regex),
    fuzzy: Boolean(search.fuzzy),
    mode: canonical(search.mode),
    context,
    ignoreCase,
    limit: canonical(search.limit),
  };
}

export function encodeGrepCursor(search, offset, window = 0) {
  const inner = Number(offset);
  const origin = Number(window);
  if (!Number.isSafeInteger(inner) || inner < 0) return null;
  if (!Number.isSafeInteger(origin) || origin < 0) return null;
  if (inner === 0 && origin === 0) return null;
  if (!search.mode) return null;
  const token = Buffer.from(
    JSON.stringify({ ...payloadFor(search), window: origin, offset: inner }),
    "utf8",
  ).toString("base64url");
  return token;
}

export function encodeNextGrepCursor(
  search,
  { rankedLength, offset, pageLength, windowStart, fffNextOffset },
) {
  const nextOffset = offset + pageLength;
  if (nextOffset < rankedLength) {
    return encodeGrepCursor(search, nextOffset, windowStart);
  }
  if (Number.isSafeInteger(fffNextOffset) && fffNextOffset > 0) {
    return encodeGrepCursor(search, 0, fffNextOffset);
  }
  return null;
}

export function grepCursorOffset(nextCursor) {
  if (nextCursor == null) return null;
  if (typeof nextCursor === "number") return nextCursor;
  const offset = nextCursor._offset ?? nextCursor.offset;
  return Number.isSafeInteger(offset) && offset > 0 ? offset : null;
}

export function toFffCursor(offset) {
  return { __brand: "GrepCursor", _offset: offset };
}

export function openGrepCursor(token, search) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(token), "base64url").toString("utf8"));
  } catch {
    throw new Error(GREP_CURSOR_ERROR);
  }
  const expected = payloadFor(search);
  const window = parsed?.window ?? 0;
  // A continuation that omits context adopts the cursor's bound value rather
  // than re-defaulting: context is one of the bound fields, and the default
  // can drift between the call that issued the cursor and the call that
  // spends it. An explicit context is still compared.
  const contextBound = Number.isSafeInteger(search.context);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.v !== GREP_CURSOR_VERSION ||
    parsed.root !== expected.root ||
    parsed.pattern !== expected.pattern ||
    parsed.glob !== expected.glob ||
    parsed.constraint !== expected.constraint ||
    parsed.regex !== expected.regex ||
    parsed.fuzzy !== expected.fuzzy ||
    (contextBound && parsed.context !== expected.context) ||
    parsed.ignoreCase !== expected.ignoreCase ||
    parsed.limit !== expected.limit ||
    !Number.isSafeInteger(parsed.offset) ||
    parsed.offset < 0 ||
    !Number.isSafeInteger(window) ||
    window < 0 ||
    (parsed.offset === 0 && window === 0) ||
    !["plain", "regex", "fuzzy"].includes(parsed.mode)
  ) {
    throw new Error(GREP_CURSOR_ERROR);
  }
  return { mode: parsed.mode, offset: parsed.offset, window, context: parsed.context };
}
