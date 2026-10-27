export const FIND_CAP = 16;
export const GREP_CAP = 16;
export const RANK_WINDOW = 48;
export const ENTRY_CAP = 3;
export const CALLEE_CAP = 4;
export const CALLER_CAP = 4;
// A definition longer than this is never presented as one readable span; the
// reply clips it to GIANT_HEAD_LINES and indexes the body by member locators.
export const GIANT_SPAN_LINES = 200;
export const GIANT_HEAD_LINES = 40;
export const MEMBER_CAP = 6;
export const JEV_TIMEOUT_MS = 800;
export const JEV_CANDIDATE_CAP = 16;
export const MATCH_TEXT_CHARS = 200;
export const CONTEXT_CAP = 3;
export const COUNT_SCAN_CAP = 4096;
export const SIDECAR_WINDOW = 40;
export const SIDECAR_MAX_BYTES = 64 * 1024;
export const SIDECAR_FILE_MAX_BYTES = 16 * 1024;
export const SIDECAR_TTL_MS = 15 * 60 * 1_000;
export const SIDECAR_COUNT_CAP = 32;
// On-disk CodeGraph buckets under dataHome()/roots/. Memory eviction (4 live
// roots, 5 min idle) does not delete these; this is the disk reclaim policy.
export const INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const INDEX_COUNT_CAP = 16;
export const INDEX_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const INDEX_KEEP_HOT_MS = 30 * 60 * 1_000;

export function pageLimit(requested, cap, fallback = cap) {
  if (!Number.isSafeInteger(requested) || requested <= 0) return fallback;
  return Math.min(requested, cap);
}

export function clampGrepContext(requested) {
  if (!Number.isSafeInteger(requested) || requested <= 0) return 0;
  return Math.min(requested, CONTEXT_CAP);
}
