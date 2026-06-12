import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPythonFunctions, blankStringsAndComments } from "./extract-python.js";
import { buildGraph } from "./graph.js";

const PIPELINE = `
import pandas as pd

def load_events(path):
    return pd.read_csv(path)

def clean(df):
    df = df.dropna()
    return normalize_columns(df)

def normalize_columns(df):
    df.columns = [c.lower() for c in df.columns]
    return df

class Trainer:
    def __init__(self, config):
        self.config = validate_config(config)

    async def run(self, path):
        df = clean(load_events(path))
        return self.fit(df)

    def fit(self, df):
        return df

def validate_config(config):
    return config
`;

test("extracts Python defs, methods, and async methods", () => {
  const fns = extractPythonFunctions("pipeline.py", PIPELINE);
  assert.deepEqual(
    fns.map((f) => f.name).sort(),
    [
      "Trainer.__init__",
      "Trainer.fit",
      "Trainer.run",
      "clean",
      "load_events",
      "normalize_columns",
      "validate_config",
    ],
  );
});

test("collects Python calls and attributes them to the right function", () => {
  const fns = extractPythonFunctions("pipeline.py", PIPELINE);
  const run = fns.find((f) => f.name === "Trainer.run")!;
  assert.deepEqual([...new Set(run.calls)].sort(), ["clean", "fit", "load_events"]);
  const cleanFn = fns.find((f) => f.name === "clean")!;
  assert.deepEqual([...new Set(cleanFn.calls)].sort(), ["dropna", "normalize_columns"]);
});

test("decorators belong to the function's source and line", () => {
  const fns = extractPythonFunctions(
    "a.py",
    `@cache\n@retry(times=3)\ndef fetch(url):\n    return get(url)\n`,
  );
  assert.equal(fns[0].line, 1);
  assert.match(fns[0].source, /^@cache/);
});

test("bracket continuations at low indent do not close scopes", () => {
  const fns = extractPythonFunctions(
    "a.py",
    `def f():\n    x = call(\n1, 2)\n    return helper(x)\n`,
  );
  assert.equal(fns.length, 1);
  assert.ok(fns[0].calls.includes("helper"));
});

test("strings and comments never produce calls or scope changes", () => {
  const fns = extractPythonFunctions(
    "a.py",
    `def f():\n    s = "fake_call(1)"  # real_comment_call(2)\n    t = '''\ndef not_a_def():\n    nested_fake(3)\n'''\n    return real(s, t)\n`,
  );
  assert.equal(fns.length, 1);
  assert.deepEqual(fns[0].calls, ["real"]);
});

test("Python rename keeps renameHash stable", () => {
  const [a] = extractPythonFunctions("a.py", `def calc(x):\n    return helper(x)\n`);
  const [b] = extractPythonFunctions("a.py", `def compute(x):\n    return helper(x)\n`);
  assert.notEqual(a.bodyHash, b.bodyHash);
  assert.equal(a.renameHash, b.renameHash);
});

test("Python calls resolve to cross-file edges in the same graph", () => {
  const g = buildGraph([
    { path: "api.py", text: `from svc import process\n\ndef handle(req):\n    return process(req)\n` },
    { path: "svc.py", text: `def process(req):\n    return req\n` },
  ]);
  assert.ok(g.edges.has("api.py#handle -> svc.py#process"));
});

test("blanking preserves offsets and newlines", () => {
  const text = `x = "ab\ncd"\n# hi\ny = 1\n`;
  const clean = blankStringsAndComments(text);
  assert.equal(clean.length, text.length);
  assert.equal(clean.split("\n").length, text.split("\n").length);
});
