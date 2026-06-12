import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, diffGraphs, findFn } from "./graph.js";

const file = (path: string, text: string) => ({ path, text });

test("resolves calls preferring same-file definitions", () => {
  const g = buildGraph([
    file("a.ts", `function go() { helper(); }\nfunction helper() {}`),
    file("b.ts", `function helper() {}`),
  ]);
  assert.ok(g.edges.has("a.ts#go -> a.ts#helper"));
  assert.ok(!g.edges.has("a.ts#go -> b.ts#helper"));
});

test("cross-file calls resolve when there is no local definition", () => {
  const g = buildGraph([
    file("a.ts", `export function go() { helper(); }`),
    file("b.ts", `export function helper() {}`),
  ]);
  assert.ok(g.edges.has("a.ts#go -> b.ts#helper"));
});

test("unresolved callees become external edges, noise builtins are dropped", () => {
  const g = buildGraph([
    file("a.ts", `function go(xs: number[]) { fetchData(); xs.map(String); }`),
  ]);
  assert.ok(g.edges.has("a.ts#go -> ext:fetchData"));
  assert.ok(![...g.edges.keys()].some((k) => k.includes("ext:map")));
});

test("method calls resolve through the basename index", () => {
  const g = buildGraph([
    file("a.ts", `class Svc { run() {} }\nfunction go(s: Svc) { s.run(); }`),
  ]);
  assert.ok(g.edges.has("a.ts#go -> a.ts#Svc.run"));
});

test("same-named functions across the repo get distinct graph ids", () => {
  const g = buildGraph([
    file("a.ts", `function f() { return 1; }\nfunction f() { return 2; }`),
  ]);
  assert.equal(g.fns.size, 2);
});

test("diff classifies added, removed, and modified", () => {
  const base = buildGraph([file("a.ts", `function keep() {}\nfunction gone() {}\nfunction edit() { return 1; }`)]);
  const head = buildGraph([file("a.ts", `function keep() {}\nfunction fresh() {}\nfunction edit() { return 2; }`)]);
  const d = diffGraphs(base, head);
  assert.deepEqual(d.added.map((f) => f.name), ["fresh"]);
  assert.deepEqual(d.removed.map((f) => f.name), ["gone"]);
  assert.deepEqual(d.modified.map((m) => m.after.name), ["edit"]);
  assert.equal(d.renamed.length, 0);
});

test("rename is detected and produces no edge churn from callers", () => {
  const base = buildGraph([
    file("a.ts", `function caller() { helper(1); }\nfunction helper(n: number) { return n * 2; }`),
  ]);
  const head = buildGraph([
    file("a.ts", `function caller() { assist(1); }\nfunction assist(n: number) { return n * 2; }`),
  ]);
  const d = diffGraphs(base, head);
  assert.equal(d.renamed.length, 1);
  assert.equal(d.renamed[0].before.name, "helper");
  assert.equal(d.renamed[0].after.name, "assist");
  assert.equal(d.added.length, 0);
  assert.equal(d.removed.length, 0);
  assert.equal(d.addedEdges.length, 0, "rename should not add edges");
  assert.equal(d.removedEdges.length, 0, "rename should not remove edges");
});

test("file move with same body is detected as a rename", () => {
  const base = buildGraph([file("old/a.ts", `export function calc() { return 7; }`)]);
  const head = buildGraph([file("new/b.ts", `export function calc() { return 7; }`)]);
  const d = diffGraphs(base, head);
  assert.equal(d.renamed.length, 1);
  assert.equal(d.renamed[0].after.file, "new/b.ts");
});

test("two identical helpers renamed at once stay add/remove (ambiguous)", () => {
  const base = buildGraph([file("a.ts", `function one() { return 0; }\nfunction two() { return 0; }`)]);
  const head = buildGraph([file("a.ts", `function uno() { return 0; }\nfunction dos() { return 0; }`)]);
  const d = diffGraphs(base, head);
  assert.equal(d.renamed.length, 0);
  assert.equal(d.added.length, 2);
  assert.equal(d.removed.length, 2);
});

test("trivial stub bodies never count as renames", () => {
  const base = buildGraph([file("a.ts", `function gone() {}`)]);
  const head = buildGraph([file("a.ts", `function fresh() {}`)]);
  const d = diffGraphs(base, head);
  assert.equal(d.renamed.length, 0);
  assert.deepEqual(d.added.map((f) => f.name), ["fresh"]);
  assert.deepEqual(d.removed.map((f) => f.name), ["gone"]);
});

test("calls resolve across roots in a unified multi-root graph", () => {
  // What loadRootsGraph produces: root-prefixed paths from two services.
  const g = buildGraph([
    file(
      "app/src/invoice.js",
      `import { toCents } from "@acme/money";\nexport function invoiceTotal(x) { return toCents(x); }`,
    ),
    file("money/src/index.js", `export function toCents(a) { return Math.round(a * 100); }`),
  ]);
  // The cross-service call is a real edge, not an external dead-end.
  assert.ok(g.edges.has("app/src/invoice.js#invoiceTotal -> money/src/index.js#toCents"));
  assert.ok(![...g.edges.keys()].some((k) => k.includes("ext:toCents")));
  // And the library function knows its consumer lives in another service.
  const callers = g.callersOf.get("money/src/index.js#toCents") ?? [];
  assert.equal(callers[0]?.fromId, "app/src/invoice.js#invoiceTotal");
});

test("findFn matches bare names, method basenames, and file#name suffixes", () => {
  const g = buildGraph([
    file("src/lambda/handler.ts", `export function getSecrets() {}`),
    file("src/other.ts", `class Svc { getSecrets() {} }`),
  ]);
  assert.equal(findFn(g, "getSecrets").length, 2);
  assert.equal(findFn(g, "handler.ts#getSecrets").length, 1);
  assert.equal(findFn(g, "src/lambda/handler.ts#getSecrets").length, 1);
  assert.equal(findFn(g, "Svc.getSecrets").length, 1);
});
