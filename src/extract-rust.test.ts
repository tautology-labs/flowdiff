import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRustFunctions } from "./extract-rust.js";
import { buildGraph } from "./graph.js";

const SERVER = `
use std::collections::HashMap;

pub struct Server {
    store: Store,
}

impl Server {
    pub fn new(store: Store) -> Self {
        Server { store }
    }

    pub fn handle(&self, req: Request) -> Response {
        let data = self.store.lookup(req.id);
        self.render(validate(data))
    }

    fn render(&self, d: Data) -> Response {
        Response::default()
    }
}

fn validate(d: Data) -> Data {
    d
}
`;

test("extracts free fns and impl methods as Type.method", () => {
  const fns = extractRustFunctions("server.rs", SERVER);
  assert.deepEqual(
    fns.map((f) => f.name).sort(),
    ["Server.handle", "Server.new", "Server.render", "validate"],
  );
});

test("collects calls including assoc (::) and method (.) via rightmost ident", () => {
  const fns = extractRustFunctions("server.rs", SERVER);
  const handle = fns.find((f) => f.name === "Server.handle")!;
  assert.deepEqual([...new Set(handle.calls)].sort(), ["lookup", "render", "validate"]);
});

test("impl Trait for Type attributes methods to the Type", () => {
  const fns = extractRustFunctions(
    "a.rs",
    `impl Display for Widget {\n    fn fmt(&self, f: &mut Formatter) -> Result {\n        emit(f)\n    }\n}`,
  );
  assert.equal(fns[0].name, "Widget.fmt");
  assert.deepEqual(fns[0].calls, ["emit"]);
});

test("trait method signatures (no body) are skipped; default methods kept", () => {
  const fns = extractRustFunctions(
    "a.rs",
    `trait Greeter {\n    fn name(&self) -> String;\n    fn greet(&self) -> String {\n        build(self.name())\n    }\n}`,
  );
  assert.deepEqual(fns.map((f) => f.name).sort(), ["Greeter.greet"]);
  assert.ok(fns[0].calls.includes("build"));
});

test("generic fns with <T> and where clauses parse", () => {
  const fns = extractRustFunctions(
    "a.rs",
    `fn map_all<T, U>(items: Vec<T>) -> Vec<U>\nwhere T: Into<U> {\n    transform(items)\n}`,
  );
  assert.equal(fns.length, 1);
  assert.equal(fns[0].name, "map_all");
  assert.deepEqual(fns[0].calls, ["transform"]);
});

test("strings, raw strings, lifetimes, and comments are handled", () => {
  const fns = extractRustFunctions(
    "a.rs",
    `fn f<'a>(x: &'a str) -> String {\n    let s = r#"fake(1) { brace"#;  // real_comment(2)\n    let c = '}';\n    real(s)\n}`,
  );
  assert.equal(fns.length, 1, "lifetime 'a and char '}' don't break parsing");
  assert.deepEqual(fns[0].calls, ["real"]);
});

test("Rust rename keeps renameHash stable", () => {
  const [a] = extractRustFunctions("a.rs", `fn calc(x: i32) -> i32 {\n    helper(x)\n}`);
  const [b] = extractRustFunctions("a.rs", `fn compute(x: i32) -> i32 {\n    helper(x)\n}`);
  assert.notEqual(a.bodyHash, b.bodyHash);
  assert.equal(a.renameHash, b.renameHash);
});

test("Rust calls resolve to cross-file edges in the unified graph", () => {
  const g = buildGraph([
    { path: "api.rs", text: `pub fn handle() {\n    process();\n}` },
    { path: "svc.rs", text: `pub fn process() {}` },
  ]);
  assert.ok(g.edges.has("api.rs#handle -> svc.rs#process"));
});
