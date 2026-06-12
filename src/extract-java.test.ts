import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJavaFunctions } from "./extract-java.js";
import { buildGraph } from "./graph.js";

const BILLING = `
package com.acme;

public class Billing {
  private final Store store;

  public Billing(Store store) {
    this.store = store;
    wire();
  }

  public int total(Order order) {
    int cents = toCents(order.price());
    return this.applyTax(store.lookup(order), cents);
  }

  private int toCents(double amount) { return (int) Math.round(amount * 100); }
  private int applyTax(Region r, int cents) { return cents; }
  private void wire() {}
}
`;

test("extracts Java methods and constructors with Class.name ids", () => {
  const fns = extractJavaFunctions("Billing.java", BILLING);
  assert.deepEqual(
    fns.map((f) => f.name).sort(),
    [
      "Billing.applyTax",
      "Billing.constructor",
      "Billing.toCents",
      "Billing.total",
      "Billing.wire",
    ],
  );
});

test("collects Java calls: bare, this., field-target, and arguments", () => {
  const fns = extractJavaFunctions("Billing.java", BILLING);
  const total = fns.find((f) => f.name === "Billing.total")!;
  assert.deepEqual(
    [...new Set(total.calls)].sort(),
    ["applyTax", "lookup", "price", "toCents"],
  );
  const ctor = fns.find((f) => f.name === "Billing.constructor")!;
  assert.deepEqual(ctor.calls, ["wire"]);
});

test("Java method rename keeps renameHash stable", () => {
  const [a] = extractJavaFunctions("A.java", `class A { int calc(int x) { return calc2(x); } }`);
  const [b] = extractJavaFunctions("A.java", `class A { int compute(int x) { return calc2(x); } }`);
  assert.notEqual(a.bodyHash, b.bodyHash);
  assert.equal(a.renameHash, b.renameHash);
});

test("Java calls resolve to edges across files, mixed with the same graph machinery", () => {
  const g = buildGraph([
    {
      path: "src/Api.java",
      text: `public class Api { public void handle() { new Billing(null); process(); } void process() { validate(); } }`,
    },
    {
      path: "src/Validator.java",
      text: `public class Validator { public static void validate() {} }`,
    },
  ]);
  assert.ok(g.edges.has("src/Api.java#Api.process -> src/Validator.java#Validator.validate"));
});

test("unparseable Java contributes nothing instead of crashing", () => {
  assert.deepEqual(extractJavaFunctions("Bad.java", "class {{{"), []);
});
