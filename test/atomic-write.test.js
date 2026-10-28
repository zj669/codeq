import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { touchGraphSource } from "../src/graph-share.js";
import { rootsDir } from "../src/paths.js";

function dataBase() {
  return mkdtempSync(join(tmpdir(), "codeq-atomic-write-"));
}

// A shared-graph source bucket: root.json carries a fingerprint and a db file
// exists so listGraphSources would treat it as a source.
function sourceBucket(base, key) {
  const bucket = join(rootsDir(base), key);
  mkdirSync(join(bucket, "codegraph"), { recursive: true });
  writeFileSync(
    join(bucket, "root.json"),
    `${JSON.stringify(
      {
        root: `/tmp/${key}`,
        schema: 1,
        codegraphVersion: "1.6.0",
        lastAccessedAt: new Date().toISOString(),
        graphFingerprint: "a".repeat(64),
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(bucket, "codegraph", "codegraph.db"), "x");
  return { key, bucket };
}

function readsValidJson(path) {
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return true;
  } catch {
    return false;
  }
}

test("touchGraphSource: repeated touches always leave a valid root.json, no temp litter", () => {
  const base = dataBase();
  const source = sourceBucket(base, "k".repeat(64));
  const path = join(source.bucket, "root.json");

  for (let i = 0; i < 200; i += 1) {
    touchGraphSource(source, Date.now() + i);
    assert.equal(readsValidJson(path), true, `torn root.json on touch ${i}`);
  }
  const litter = readdirSync(source.bucket).filter((n) => n.endsWith(".tmp"));
  assert.deepEqual(litter, [], "no temp litter");
});

// Cross-process parallel writers + a reader: the real scenario for a
// shared-graph source being touched by several daemons at once while the GC or
// findSharedGraph reads it. A child process hammers touchGraphSource while the
// parent reads in a tight loop; a torn write would surface as a JSON.parse
// failure.
test("parallel writer process + reader: root.json is never torn", async () => {
  const base = dataBase();
  const source = sourceBucket(base, "m".repeat(64));
  const path = join(source.bucket, "root.json");

  const writer = fileURLToPath(
    new URL("./fixtures/atomic-writer.js", import.meta.url),
  );
  // Two children write concurrently for ~1.5s while the parent reads.
  const children = [0, 1].map(
    () =>
      spawn(process.execPath, [writer, source.bucket, "1500"], {
        stdio: "ignore",
      }),
  );
  let torn = 0;
  const deadline = Date.now() + 1200;
  while (Date.now() < deadline) {
    if (!readsValidJson(path)) torn += 1;
    // also touch from this process to add a third writer
    touchGraphSource(source, Date.now());
  }
  const exits = await Promise.all(
    children.map(
      (c) => new Promise((res) => c.on("exit", (code) => res(code))),
    ),
  );
  assert.equal(torn, 0, "no torn root.json across parallel processes");
  assert.deepEqual(exits, [0, 0]);
  assert.equal(readsValidJson(path), true);
});

test("crash-interrupted write: a leftover temp never corrupts root.json", () => {
  const base = dataBase();
  const source = sourceBucket(base, "n".repeat(64));
  const path = join(source.bucket, "root.json");
  const before = readFileSync(path, "utf8");

  // A process killed after writing its unique temp but before rename leaves a
  // fully-formed temp next to an intact root.json.
  const orphanTemp = `${path}.99999.1.tmp`;
  writeFileSync(orphanTemp, '{"partial":');
  assert.equal(readFileSync(path, "utf8"), before, "root.json intact");
  assert.equal(readsValidJson(path), true);

  // Recovery: a later touch still publishes a complete file; the orphan temp is
  // never picked up as root.json.
  touchGraphSource(source, Date.now());
  assert.equal(readsValidJson(path), true);
});

test("touchGraphSource no-ops when root.json is gone — never writes garbage", () => {
  const base = dataBase();
  const source = sourceBucket(base, "p".repeat(64));
  const path = join(source.bucket, "root.json");
  execFileSync("rm", [path]);
  touchGraphSource(source, Date.now());
  assert.equal(existsSync(path), false, "no root.json recreated over a missing source");
});
