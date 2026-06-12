import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFunctions } from "./extract.js";

test("finds function declarations, methods, and arrow consts", () => {
  const fns = extractFunctions(
    "a.ts",
    `
function plain() {}
class Svc {
  method() {}
  field = () => {};
}
const arrow = () => {};
const fnExpr = function () {};
`,
  );
  assert.deepEqual(
    fns.map((f) => f.name).sort(),
    ["Svc.field", "Svc.method", "arrow", "fnExpr", "plain"],
  );
  assert.equal(fns.find((f) => f.name === "Svc.method")!.id, "a.ts#Svc.method");
});

test("collects calls, attributing closure calls to the enclosing named function", () => {
  const fns = extractFunctions(
    "a.ts",
    `
function outer() {
  helper();
  [1, 2].map(() => inner());
}
`,
  );
  const outer = fns.find((f) => f.name === "outer")!;
  assert.deepEqual([...new Set(outer.calls)].sort(), ["helper", "inner", "map"]);
});

test("calls to a function's own parameters are not edges", () => {
  const fns = extractFunctions(
    "a.ts",
    `function withRetry(fn: () => void) { fn(); other(); }`,
  );
  assert.deepEqual(fns[0].calls, ["other"]);
});

test("rename changes bodyHash but not renameHash", () => {
  const [before] = extractFunctions("a.ts", `function oldName() { return oldName.length; }`);
  const [after] = extractFunctions("a.ts", `function newName() { return newName.length; }`);
  assert.notEqual(before.bodyHash, after.bodyHash);
  assert.equal(before.renameHash, after.renameHash);
});

test("body change alters both hashes", () => {
  const [before] = extractFunctions("a.ts", `function f() { return 1; }`);
  const [after] = extractFunctions("a.ts", `function f() { return 2; }`);
  assert.notEqual(before.bodyHash, after.bodyHash);
  assert.notEqual(before.renameHash, after.renameHash);
});

test("constructors and accessors are functions too", () => {
  const fns = extractFunctions(
    "a.ts",
    `
class Agent {
  constructor(opts: object) {
    this.wire(opts);
  }
  get state() { return compute(); }
}
`,
  );
  const ctor = fns.find((f) => f.name === "Agent.constructor");
  assert.ok(ctor, "constructor extracted");
  assert.deepEqual(ctor!.calls, ["wire"]);
  const getter = fns.find((f) => f.name === "Agent.state");
  assert.ok(getter, "getter extracted");
  assert.deepEqual(getter!.calls, ["compute"]);
});

test("extracts both same-named functions (dedupe happens in buildGraph)", () => {
  const fns = extractFunctions(
    "a.ts",
    `
function f() { return 1; }
function f() { return 2; }
`,
  );
  assert.equal(fns.length, 2);
});
