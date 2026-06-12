import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines } from "./linediff.js";
import { isSourcePath } from "./git.js";

test("diffLines marks unchanged, added, and removed lines", () => {
  const out = diffLines(["a", "b", "c"], ["a", "x", "c"]);
  assert.deepEqual(out, [
    { type: " ", text: "a" },
    { type: "-", text: "b" },
    { type: "+", text: "x" },
    { type: " ", text: "c" },
  ]);
});

test("diffLines handles pure insertion and deletion", () => {
  assert.deepEqual(diffLines([], ["a"]), [{ type: "+", text: "a" }]);
  assert.deepEqual(diffLines(["a"], []), [{ type: "-", text: "a" }]);
});

test("source paths skip build artifacts and type stubs", () => {
  assert.ok(isSourcePath("src/lambda/handler.ts"));
  assert.ok(isSourcePath("index.jsx"));
  assert.ok(!isSourcePath("cdk.out/asset.abc/handler.js"));
  assert.ok(!isSourcePath("node_modules/x/index.js"));
  assert.ok(!isSourcePath("dist/cli.js"));
  assert.ok(!isSourcePath("src/types.d.ts"));
  assert.ok(!isSourcePath("README.md"));
});
