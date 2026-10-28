#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const EXPECTED_VERSION = "1.6.0";
const EXPECTED_DIRECTORY_SHA256 =
  "0ccabb909eb770cf3e3aac4051ecb9dcc6fb1bcb5306cefba7a4e35527b5bce4";
const MARKER = "CODEQ_EXTERNAL_DATA_DIR_PATCH_V1";
const checkOnly = process.argv.includes("--check");

const packageJson = require("@colbymchenry/codegraph/package.json");
if (packageJson.version !== EXPECTED_VERSION) {
  throw new Error(
    `codeq requires @colbymchenry/codegraph ${EXPECTED_VERSION}; found ${packageJson.version}`,
  );
}

const platformPackage =
  `@colbymchenry/codegraph-${process.platform}-${process.arch}`;
let platformRoot;
try {
  platformRoot = dirname(require.resolve(`${platformPackage}/package.json`));
} catch {
  throw new Error(
    `codeq cannot patch CodeGraph: ${platformPackage} is not installed`,
  );
}

const target = join(platformRoot, "lib", "dist", "directory.js");
const source = readFileSync(target, "utf8");
const digest = createHash("sha256").update(source).digest("hex");

if (source.includes(MARKER)) {
  const markerCount = source.split(MARKER).length - 1;
  if (
    markerCount !== 1 ||
    !source.includes("process.env.CODEQ_CODEGRAPH_DATA_DIRS")
  ) {
    throw new Error("codeq CodeGraph data-dir patch is malformed");
  }
  process.stdout.write("CodeGraph 1.6.0 data-dir patch verified\n");
  process.exit(0);
}

if (checkOnly) {
  throw new Error("CodeGraph 1.6.0 data-dir patch is not installed");
}

if (digest !== EXPECTED_DIRECTORY_SHA256) {
  throw new Error(
    `refusing to patch unexpected CodeGraph directory resolver: ` +
      `expected ${EXPECTED_DIRECTORY_SHA256}, found ${digest}`,
  );
}

const before = `function getCodeGraphDir(projectRoot) {
    return path.join(projectRoot, codeGraphDirName());
}`;
const after = `function getCodeGraphDir(projectRoot) {
    // ${MARKER}: codeq owns an external bucket for every canonical source root.
    // This is intentionally the only CodeGraph behavior changed by codeq.
    const raw = process.env.CODEQ_CODEGRAPH_DATA_DIRS;
    if (raw) {
        try {
            const dirs = JSON.parse(raw);
            let canonical;
            try {
                canonical = fs.realpathSync(projectRoot);
            }
            catch {
                canonical = path.resolve(projectRoot);
            }
            const injected = dirs[canonical] ?? dirs[path.resolve(projectRoot)];
            if (typeof injected === 'string' && path.isAbsolute(injected)) {
                return path.resolve(injected);
            }
        }
        catch {
            // Invalid injection is ignored; CodeGraph's original safe fallback wins.
        }
    }
    return path.join(projectRoot, codeGraphDirName());
}`;

if (!source.includes(before)) {
  throw new Error("CodeGraph 1.6.0 resolver seam was not found");
}

const patched = source.replace(before, after);
writeFileSync(target, patched, "utf8");
process.stdout.write("Patched CodeGraph 1.6.0 external data-dir resolver\n");
