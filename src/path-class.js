// Path classification shared by graph caller ranking (graph-map.js) and
// find/grep ranking (path-tier.js). It lives in its own module because both of
// those need the same answer to "is this path production code?" and importing
// one from the other would close a cycle.

const TEST_PATH = /(^|\/)tests?(\/|$)|_test\.|spec\.|__tests__|\.test\./;
const BENCH_SEGMENT = /(^|\/)(benchmarks?|bench)(\/|$)/i;
const NAMED_TESTS_SEGMENT = /(^|\/)[^/]+[-_]tests?(\/|$)/i;
const ROOT_BENCHMARK = /^benchmarks?\.(js|cjs|mjs|ts|py)$/i;
// Any directory segment that mentions a benchmark, so tests/memory_benchmarks
// is recognised as a benchmark and not just as a test.
const BENCH_IN_SEGMENT = /(^|\/)[^/]*bench(mark)?s?[^/]*(\/|$)/i;

// A `_src`/`-src` suffix still names a documentation tree, not production code:
// FastAPI keeps every tutorial snippet under docs_src/, and those snippets call
// the public API, so without this they outrank real callers.
const DOCS_SEGMENT =
  /(^|\/)(docs?|documentation|examples?|samples?|tutorials?)(?:[_-](?:src|source))?(\/|$)/i;
const AGENTS_SEGMENT = /(^|\/)\.agents(\/|$)/;
const SKILL_BASENAME = /^skill(?:\.md)?$/i;

const CI_SEGMENT = /(^|\/)\.(github|circleci|gitlab)(\/|$)/;
const GENERATED_SEGMENT = /(^|\/)(dist|coverage)(\/|$)/;
const DEVCONTAINER_SEGMENT = /(^|\/)\.devcontainer(\/|$)/;
const MIN_ASSET = /\.min\.(js|cjs|mjs|css)$/i;
const AUX_META = new Set([
  ".editorconfig",
  ".gitignore",
  ".gitattributes",
  ".readthedocs.yaml",
  ".readthedocs.yml",
]);
const DOC_META_BASENAME =
  /^(changelog|changes|license|copying|authors|contributing|code_of_conduct)(\..+)?$/i;
const ROOT_PROSE = /\.(md|rst)$/i;
const RC_BASENAME = /^\.[^./]*rc(\.|$)/i;
const BROWSERSLIST_RC = /^\.browserslistrc$/i;
const ROOT_DOT_SCRIPT = /^\.[^/]+\.(js|cjs|mjs|ts)$/i;
const ROOT_CONFIG_SCRIPT = /\.config\.(js|cjs|mjs|ts|json)$/i;
const ROOT_KARMA = /^karma\.conf\./i;

export function posixPath(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

function isRepoRootFile(path) {
  const relative = posixPath(path).replace(/^\.\/+/, "");
  const segments = relative.split("/").filter((part) => part && part !== ".");
  return segments.length === 1;
}

export function isTestPath(filePath) {
  const path = posixPath(filePath);
  if (TEST_PATH.test(path)) return true;
  if (BENCH_SEGMENT.test(path)) return true;
  if (NAMED_TESTS_SEGMENT.test(path)) return true;
  const relative = path.replace(/^\.\/+/, "");
  const segments = relative.split("/").filter((part) => part && part !== ".");
  return segments.length === 1 && ROOT_BENCHMARK.test(segments[0]);
}

// A benchmark is a refinement *inside* the non-production space: a path only
// counts when it is already a test path, so a production src/benchmark.js keeps
// its production rank.
export function isBenchPath(filePath) {
  const path = posixPath(filePath);
  if (!isTestPath(path)) return false;
  if (BENCH_IN_SEGMENT.test(path)) return true;
  const relative = path.replace(/^\.\/+/, "");
  const segments = relative.split("/").filter((part) => part && part !== ".");
  return segments.length === 1 && ROOT_BENCHMARK.test(segments[0]);
}

export function isDocsPath(filePath) {
  const path = posixPath(filePath);
  if (DOCS_SEGMENT.test(path)) return true;
  if (AGENTS_SEGMENT.test(path)) return true;
  const base = path.split("/").pop() || "";
  if (SKILL_BASENAME.test(base)) return true;
  if (/^readme(?:\..+)?$/i.test(base)) return true;
  if (DOC_META_BASENAME.test(base)) return true;
  if (isRepoRootFile(path) && ROOT_PROSE.test(base)) return true;
  return false;
}

export function isConfigPath(filePath) {
  const path = posixPath(filePath);
  if (CI_SEGMENT.test(path)) return true;
  const base = path.split("/").pop() || "";
  if (base.toLowerCase() === "py.typed") return true;
  if (RC_BASENAME.test(base) || BROWSERSLIST_RC.test(base)) return true;
  if (GENERATED_SEGMENT.test(path)) return true;
  if (MIN_ASSET.test(base)) return true;
  if (DEVCONTAINER_SEGMENT.test(path)) return true;
  if (AUX_META.has(base.toLowerCase())) return true;
  if (!isRepoRootFile(path)) return false;
  return (
    ROOT_DOT_SCRIPT.test(base) ||
    ROOT_CONFIG_SCRIPT.test(base) ||
    ROOT_KARMA.test(base)
  );
}

export function pathTier(filePath) {
  if (isDocsPath(filePath)) return 3;
  if (isTestPath(filePath)) return 2;
  if (isConfigPath(filePath)) return 1;
  return 0;
}

export const CALLER_TIER_PRODUCTION = 0;
export const CALLER_TIER_CONFIG = 1;
export const CALLER_TIER_TEST = 2;
export const CALLER_TIER_BENCH = 3;
export const CALLER_TIER_DOCS = 4;

// Caller ranking needs a finer split than pathTier: a giant library symbol is
// called from hundreds of tests, and a handful of benchmark *helpers* sorted
// alphabetically would otherwise fill every visible slot and push the real
// callers into the omitted count.
export function callerTier(filePath) {
  if (isDocsPath(filePath)) return CALLER_TIER_DOCS;
  if (isBenchPath(filePath)) return CALLER_TIER_BENCH;
  if (isTestPath(filePath)) return CALLER_TIER_TEST;
  if (isConfigPath(filePath)) return CALLER_TIER_CONFIG;
  return CALLER_TIER_PRODUCTION;
}
