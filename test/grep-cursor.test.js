import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeGrepCursor,
  encodeNextGrepCursor,
  GREP_CURSOR_ERROR,
  GREP_CURSOR_VERSION,
  openGrepCursor,
} from "../src/grep-cursor.js";

const search = {
  root: "/repo",
  pattern: "TODO",
  glob: "**/*.ts",
  constraint: "src/",
  regex: false,
  fuzzy: false,
  mode: "plain",
};

test("grep cursor is opaque and stores ranked offset plus FFF window start", () => {
  const token = encodeGrepCursor(search, 16, 0);
  assert.equal(typeof token, "string");
  assert.equal(token.includes("/repo"), false);
  const opened = openGrepCursor(token, search);
  assert.equal(opened.mode, "plain");
  assert.equal(opened.offset, 16);
  assert.equal(opened.window, 0);
  assert.equal("cursor" in opened, false);
});

test("grep cursor mismatch, junk, and v1 tokens are errors, not page 1", () => {
  const token = encodeGrepCursor(search, 16, 0);
  assert.throws(
    () => openGrepCursor(token, { ...search, root: "/other" }),
    (error) => error.message === GREP_CURSOR_ERROR,
  );
  assert.throws(
    () => openGrepCursor(token, { ...search, pattern: "FIXME" }),
    (error) => error.message === GREP_CURSOR_ERROR,
  );
  assert.throws(
    () => openGrepCursor(token, { ...search, regex: true }),
    (error) => error.message === GREP_CURSOR_ERROR,
  );
  assert.throws(
    () => openGrepCursor(token, { ...search, glob: "**/*.js" }),
    (error) => error.message === GREP_CURSOR_ERROR,
  );
  assert.throws(
    () => openGrepCursor("not-a-cursor", search),
    (error) => error.message === GREP_CURSOR_ERROR,
  );
  const v1 = Buffer.from(
    JSON.stringify({
      v: 1,
      root: "/repo",
      pattern: "TODO",
      glob: "**/*.ts",
      constraint: "src/",
      regex: false,
      fuzzy: false,
      mode: "plain",
      offset: 12,
    }),
    "utf8",
  ).toString("base64url");
  assert.throws(
    () => openGrepCursor(v1, search),
    (error) => error.message === GREP_CURSOR_ERROR,
  );
  const v2 = Buffer.from(
    JSON.stringify({
      v: 2,
      root: "/repo",
      pattern: "TODO",
      glob: "**/*.ts",
      constraint: "src/",
      regex: false,
      fuzzy: false,
      mode: "plain",
      window: 0,
      offset: 16,
    }),
    "utf8",
  ).toString("base64url");
  assert.throws(
    () => openGrepCursor(v2, search),
    (error) => error.message === GREP_CURSOR_ERROR,
  );
  assert.equal(encodeGrepCursor(search, 0, 0), null);
});

test("grep next cursor stays in the ranked window before following FFF", () => {
  const within = encodeNextGrepCursor(search, {
    rankedLength: 48,
    offset: 0,
    pageLength: 16,
    windowStart: 0,
    fffNextOffset: 9001,
  });
  const opened = openGrepCursor(within, search);
  assert.equal(opened.offset, 16);
  assert.equal(opened.window, 0);

  const lastInWindow = encodeNextGrepCursor(search, {
    rankedLength: 48,
    offset: 32,
    pageLength: 16,
    windowStart: 0,
    fffNextOffset: 9001,
  });
  const nextWindow = openGrepCursor(lastInWindow, search);
  assert.equal(nextWindow.offset, 0);
  assert.equal(nextWindow.window, 9001);
  assert.equal(GREP_CURSOR_VERSION, 5);
});

test("grep cursor binds context and ignoreCase; v3 tokens are stale", () => {
  const bound = { ...search, context: 2, ignoreCase: "false" };
  const token = encodeGrepCursor(bound, 16, 0);
  const opened = openGrepCursor(token, bound);
  assert.equal(opened.offset, 16);
  assert.throws(
    () => openGrepCursor(token, { ...bound, context: 0 }),
    (error) => error.message === GREP_CURSOR_ERROR,
  );
  assert.throws(
    () => openGrepCursor(token, { ...bound, ignoreCase: "true" }),
    (error) => error.message === GREP_CURSOR_ERROR,
  );
  assert.throws(
    () => openGrepCursor(token, { ...bound, ignoreCase: "default" }),
    (error) => error.message === GREP_CURSOR_ERROR,
  );
  const v3 = Buffer.from(
    JSON.stringify({
      v: 3,
      root: "/repo",
      pattern: "TODO",
      glob: "**/*.ts",
      constraint: "src/",
      regex: false,
      fuzzy: false,
      mode: "plain",
      window: 0,
      offset: 16,
    }),
    "utf8",
  ).toString("base64url");
  assert.throws(
    () => openGrepCursor(v3, search),
    (error) => error.message === GREP_CURSOR_ERROR,
  );
  assert.match(GREP_CURSOR_ERROR, /context/);
  assert.match(GREP_CURSOR_ERROR, /ignoreCase/);
});

test("grep cursor continuation without context adopts the bound value", () => {
  const bound = { ...search, context: 1, ignoreCase: "false" };
  const token = encodeGrepCursor(bound, 16, 0);
  const opened = openGrepCursor(token, { ...bound, context: undefined });
  assert.equal(opened.offset, 16);
  assert.equal(opened.context, 1);
  // An explicit context is still compared, adopted or not.
  assert.throws(
    () => openGrepCursor(token, { ...bound, context: 3 }),
    (error) => error.message === GREP_CURSOR_ERROR,
  );
});
