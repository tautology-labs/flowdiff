import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { discoverRoots } from "./roots.js";

test("a lone repo discovers only itself", () => {
  const dir = mkdtempSync(join(tmpdir(), "roots-solo-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "solo" }));
    const roots = discoverRoots(dir);
    assert.equal(roots.length, 1);
    assert.equal(roots[0].dir, realpathSync(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file: deps and node_modules symlinks both surface a linked service", () => {
  const work = mkdtempSync(join(tmpdir(), "roots-link-"));
  try {
    const lib = join(work, "lib");
    const app = join(work, "app");
    mkdirSync(lib);
    mkdirSync(app);
    writeFileSync(join(lib, "package.json"), JSON.stringify({ name: "@acme/money" }));
    writeFileSync(
      join(app, "package.json"),
      JSON.stringify({ name: "app", dependencies: { "@acme/money": "file:../lib" } }),
    );
    // Realistic install: node_modules/@acme/money symlinks to ../lib
    mkdirSync(join(app, "node_modules", "@acme"), { recursive: true });
    symlinkSync(lib, join(app, "node_modules", "@acme", "money"), "dir");

    const roots = discoverRoots(app);
    const dirs = roots.map((r) => basename(r.dir)).sort();
    assert.deepEqual(dirs, ["app", "lib"]);
    // Primary is always first.
    assert.equal(basename(roots[0].dir), "app");
    // Deduped — the file: dep and the symlink point at the same lib.
    assert.equal(roots.length, 2);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("plain registry deps in node_modules are not followed", () => {
  const work = mkdtempSync(join(tmpdir(), "roots-reg-"));
  try {
    const app = join(work, "app");
    mkdirSync(join(app, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "app" }));
    writeFileSync(
      join(app, "node_modules", "left-pad", "package.json"),
      JSON.stringify({ name: "left-pad" }),
    );
    const roots = discoverRoots(app);
    assert.equal(roots.length, 1);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
