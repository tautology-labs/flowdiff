import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, diffGraphs } from "./graph.js";
import { buildHtmlModel, renderHtml } from "./html.js";

const file = (path: string, text: string) => ({ path, text });

function fixtureDiff() {
  const base = buildGraph([
    file("a.ts", `function entry() { keep(); gone(); }\nfunction keep() {}\nfunction gone() {}`),
  ]);
  const head = buildGraph([
    file("a.ts", `function entry() { keep(); fresh(); }\nfunction keep() {}\nfunction fresh() { deep(); }\nfunction deep() {}`),
  ]);
  return { base, head, diff: diffGraphs(base, head) };
}

test("html model captures changed functions as colored nodes", () => {
  const { base, head, diff } = fixtureDiff();
  const m = buildHtmlModel(diff, base, head, "HEAD", "worktree");
  const byName = Object.fromEntries(m.nodes.map((n) => [n.name, n.kind]));
  assert.equal(byName["fresh"], "added");
  assert.equal(byName["deep"], "added");
  assert.equal(byName["gone"], "removed");
  assert.equal(byName["entry"], "modified");
  // keep() is unchanged but a neighbor of entry → included as context
  assert.equal(byName["keep"], "context");
  assert.equal(m.counts.added, 2);
  assert.equal(m.counts.removed, 1);
  assert.equal(m.counts.modified, 1);
});

test("html model includes edges among the node set, tagged by change", () => {
  const { base, head, diff } = fixtureDiff();
  const m = buildHtmlModel(diff, base, head, "HEAD", "worktree");
  const edge = (from: string, to: string) =>
    m.edges.find((e) => e.from.endsWith(`#${from}`) && e.to.endsWith(`#${to}`));
  assert.equal(edge("entry", "fresh")?.kind, "added");
  assert.equal(edge("fresh", "deep")?.kind, "added");
  assert.equal(edge("entry", "keep")?.kind, "unchanged");
});

test("changed nodes carry a diff; context nodes do not", () => {
  const { base, head, diff } = fixtureDiff();
  const m = buildHtmlModel(diff, base, head, "HEAD", "worktree");
  const fresh = m.nodes.find((n) => n.name === "fresh")!;
  const keep = m.nodes.find((n) => n.name === "keep")!;
  assert.ok(m.diffs[fresh.id].some((l) => l.type === "+"));
  assert.equal(m.diffs[keep.id], undefined);
});

test("renderHtml emits one self-contained file with no external resources", () => {
  const { base, head, diff } = fixtureDiff();
  const doc = renderHtml(diff, base, head, "HEAD", "worktree");
  assert.match(doc, /^<!doctype html>/);
  assert.ok(!/src=["']http/.test(doc), "no external scripts");
  assert.ok(!/href=["']http/.test(doc), "no external stylesheets");
  assert.ok(doc.includes("window.__FLOWDIFF__"));
});

test("embedded data is escaped so source code cannot break out of the script tag", () => {
  const base = buildGraph([file("a.ts", `function f() {}`)]);
  const head = buildGraph([
    file("a.ts", `function f() { render("</script><img src=x>"); }`),
  ]);
  const doc = renderHtml(diffGraphs(base, head), base, head, "HEAD", "worktree");
  // The literal closing tag must not appear inside the data assignment.
  const dataLine = doc.split("\n").find((l) => l.includes("window.__FLOWDIFF__"))!;
  assert.ok(!dataLine.includes("</script>"), "no raw </script> in embedded data");
  assert.ok(dataLine.includes("\\u003c/script>"), "< is unicode-escaped");
});
