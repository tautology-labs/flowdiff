import type { FnInfo } from "./extract.js";
import type { Graph, GraphDiff } from "./graph.js";
import { diffLines } from "./linediff.js";

/**
 * Self-contained interactive HTML export: the changed call graph as an SVG
 * node-link diagram (vanilla force layout, no CDN), nodes colored by change
 * kind, click a node for its before/after diff. One file you can open
 * offline or attach to a PR.
 */

type NodeKind = "added" | "removed" | "modified" | "renamed" | "context";

export interface HtmlNode {
  id: string;
  name: string;
  file: string;
  line: number;
  kind: NodeKind;
}

export interface HtmlEdge {
  from: string;
  to: string;
  kind: "added" | "removed" | "unchanged";
}

export interface HtmlModel {
  base: string;
  head: string;
  nodes: HtmlNode[];
  edges: HtmlEdge[];
  diffs: Record<string, { type: " " | "+" | "-"; text: string }[]>;
  counts: { added: number; removed: number; modified: number; renamed: number };
}

const MAX_NEIGHBORS = 12;

/** Pure: build the graph model the HTML renders. Tested directly. */
export function buildHtmlModel(
  diff: GraphDiff,
  baseGraph: Graph,
  headGraph: Graph,
  baseLabel: string,
  headLabel: string,
): HtmlModel {
  const nodes = new Map<string, HtmlNode>();
  const diffs: HtmlModel["diffs"] = {};

  const shortName = (id: string) =>
    id.startsWith("ext:") ? id.slice(4) : id.split("#")[1] ?? id;

  const addNode = (fn: FnInfo, kind: NodeKind) => {
    if (!nodes.has(fn.id) || kind !== "context") {
      nodes.set(fn.id, { id: fn.id, name: fn.name, file: fn.file, line: fn.line, kind });
    }
  };
  const addContext = (graph: Graph, id: string) => {
    if (nodes.has(id) || id.startsWith("ext:")) return;
    const fn = graph.fns.get(id);
    if (fn) nodes.set(id, { id, name: fn.name, file: fn.file, line: fn.line, kind: "context" });
  };

  // Changed functions are the primary nodes; their immediate (bounded)
  // neighborhood gives the graph context to make the change legible.
  const primaries: { fn: FnInfo; before: FnInfo | null; after: FnInfo | null; graph: Graph; kind: NodeKind }[] = [];
  for (const fn of diff.added) primaries.push({ fn, before: null, after: fn, graph: headGraph, kind: "added" });
  for (const m of diff.modified) primaries.push({ fn: m.after, before: m.before, after: m.after, graph: headGraph, kind: "modified" });
  for (const r of diff.renamed) primaries.push({ fn: r.after, before: r.before, after: r.after, graph: headGraph, kind: "renamed" });
  for (const fn of diff.removed) primaries.push({ fn, before: fn, after: null, graph: baseGraph, kind: "removed" });

  for (const p of primaries) {
    addNode(p.fn, p.kind);
    diffs[p.fn.id] = diffLines(
      p.before ? p.before.source.split("\n") : [],
      p.after ? p.after.source.split("\n") : [],
    );
    const g = p.graph;
    const callers = (g.callersOf.get(p.fn.id) ?? []).slice(0, MAX_NEIGHBORS);
    for (const e of callers) addContext(g, e.fromId);
    let calleeCount = 0;
    for (const e of g.edges.values()) {
      if (e.fromId === p.fn.id && !e.external && calleeCount++ < MAX_NEIGHBORS) addContext(g, e.toId);
    }
  }

  // Edges among the node set: current structure from head, plus removed edges
  // from base, each tagged so the renderer can style added/removed.
  const ids = new Set(nodes.keys());
  const edges: HtmlEdge[] = [];
  const seen = new Set<string>();
  const addedKeys = new Set(diff.addedEdges.map((e) => `${e.fromId} -> ${e.toId}`));
  for (const e of headGraph.edges.values()) {
    if (e.external || !ids.has(e.fromId) || !ids.has(e.toId)) continue;
    const key = `${e.fromId} -> ${e.toId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: e.fromId, to: e.toId, kind: addedKeys.has(key) ? "added" : "unchanged" });
  }
  for (const e of diff.removedEdges) {
    if (e.external || !ids.has(e.fromId) || !ids.has(e.toId)) continue;
    const key = `${e.fromId} -> ${e.toId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: e.fromId, to: e.toId, kind: "removed" });
  }

  void shortName;
  return {
    base: baseLabel,
    head: headLabel,
    nodes: [...nodes.values()],
    edges,
    diffs,
    counts: {
      added: diff.added.length,
      removed: diff.removed.length,
      modified: diff.modified.length,
      renamed: diff.renamed.length,
    },
  };
}

export function renderHtml(
  diff: GraphDiff,
  baseGraph: Graph,
  headGraph: Graph,
  baseLabel: string,
  headLabel: string,
): string {
  const model = buildHtmlModel(diff, baseGraph, headGraph, baseLabel, headLabel);
  // Neutralize "</script>" and any "<" so the JSON can't break out of the tag.
  const data = JSON.stringify(model).replace(/</g, "\\u003c");
  return HTML_TEMPLATE.replace("/*__DATA__*/", `window.__FLOWDIFF__ = ${data};`);
}

const HTML_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>flowdiff</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #30363d; --text: #e6edf3;
    --muted: #8b949e; --added: #3fb950; --removed: #f85149;
    --modified: #d29922; --renamed: #58a6ff; --context: #6e7681;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 ui-monospace, "SF Mono", Menlo, monospace; height: 100vh; overflow: hidden; }
  header { padding: 10px 16px; border-bottom: 1px solid var(--border); display: flex;
    gap: 16px; align-items: baseline; flex-wrap: wrap; }
  header b { font-weight: 600; } header .muted { color: var(--muted); }
  .legend span { margin-right: 12px; } .dot { display: inline-block; width: 9px; height: 9px;
    border-radius: 50%; margin-right: 4px; vertical-align: middle; }
  main { display: flex; height: calc(100vh - 46px); }
  #graph { flex: 1; }
  #panel { width: 42%; max-width: 640px; border-left: 1px solid var(--border);
    overflow: auto; padding: 0; background: var(--panel); }
  #panel .empty { color: var(--muted); padding: 24px; }
  #panel h2 { font-size: 14px; margin: 0; padding: 12px 16px; border-bottom: 1px solid var(--border);
    position: sticky; top: 0; background: var(--panel); }
  #panel pre { margin: 0; padding: 12px 16px; white-space: pre-wrap; word-break: break-word; font-size: 13px; }
  .ln-add { color: var(--added); } .ln-del { color: var(--removed); } .ln-ctx { color: var(--muted); }
  circle.node { cursor: pointer; stroke: var(--bg); stroke-width: 2; }
  circle.node.sel { stroke: var(--text); stroke-width: 3; }
  text.lbl { fill: var(--text); font-size: 11px; pointer-events: none; }
  line.edge { stroke: var(--context); stroke-opacity: 0.5; }
  line.edge.added { stroke: var(--added); stroke-opacity: 0.9; }
  line.edge.removed { stroke: var(--removed); stroke-opacity: 0.8; stroke-dasharray: 4 3; }
</style>
</head>
<body>
<header>
  <b>flowdiff</b>
  <span class="muted" id="range"></span>
  <span class="legend">
    <span><i class="dot" style="background:var(--added)"></i>added</span>
    <span><i class="dot" style="background:var(--removed)"></i>removed</span>
    <span><i class="dot" style="background:var(--modified)"></i>changed</span>
    <span><i class="dot" style="background:var(--renamed)"></i>renamed</span>
    <span><i class="dot" style="background:var(--context)"></i>context</span>
  </span>
</header>
<main>
  <svg id="graph"></svg>
  <div id="panel"><div class="empty">Click a node to see its diff.</div></div>
</main>
<script>
/*__DATA__*/
(function () {
  var D = window.__FLOWDIFF__;
  var COLOR = { added: "#3fb950", removed: "#f85149", modified: "#d29922", renamed: "#58a6ff", context: "#6e7681" };
  document.getElementById("range").textContent = D.base + " \\u2192 " + D.head +
    "   ( +" + D.counts.added + "  \\u2212" + D.counts.removed + "  ~" + D.counts.modified + "  \\u2192" + D.counts.renamed + " )";

  var svg = document.getElementById("graph");
  var W = svg.clientWidth || 800, H = svg.clientHeight || 600;
  var nodes = D.nodes.map(function (n, i) {
    return { n: n, x: W/2 + Math.cos(i) * 40 + (Math.random()-0.5)*40, y: H/2 + Math.sin(i)*40 + (Math.random()-0.5)*40, vx: 0, vy: 0 };
  });
  var byId = {}; nodes.forEach(function (p) { byId[p.n.id] = p; });
  var links = D.edges.filter(function (e) { return byId[e.from] && byId[e.to]; });

  // Tiny force layout: repulsion + springs + center gravity, fixed iterations.
  for (var it = 0; it < 320; it++) {
    for (var a = 0; a < nodes.length; a++) {
      for (var b = a + 1; b < nodes.length; b++) {
        var dx = nodes[a].x - nodes[b].x, dy = nodes[a].y - nodes[b].y;
        var d2 = dx*dx + dy*dy || 0.01, d = Math.sqrt(d2);
        var f = 2400 / d2;
        var ux = dx/d, uy = dy/d;
        nodes[a].vx += ux*f; nodes[a].vy += uy*f;
        nodes[b].vx -= ux*f; nodes[b].vy -= uy*f;
      }
    }
    links.forEach(function (e) {
      var s = byId[e.from], t = byId[e.to];
      var dx = t.x - s.x, dy = t.y - s.y, d = Math.sqrt(dx*dx+dy*dy) || 0.01;
      var f = (d - 90) * 0.02, ux = dx/d, uy = dy/d;
      s.vx += ux*f; s.vy += uy*f; t.vx -= ux*f; t.vy -= uy*f;
    });
    nodes.forEach(function (p) {
      p.vx += (W/2 - p.x) * 0.002; p.vy += (H/2 - p.y) * 0.002;
      p.x += p.vx *= 0.85; p.y += p.vy *= 0.85;
      p.x = Math.max(20, Math.min(W-20, p.x)); p.y = Math.max(20, Math.min(H-20, p.y));
    });
  }

  var NS = "http://www.w3.org/2000/svg";
  function el(tag, attrs) { var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }

  links.forEach(function (e) {
    var s = byId[e.from], t = byId[e.to];
    var ln = el("line", { x1: s.x, y1: s.y, x2: t.x, y2: t.y, class: "edge " + e.kind });
    svg.appendChild(ln);
  });
  var selected = null;
  nodes.forEach(function (p) {
    var r = p.n.kind === "context" ? 5 : 8;
    var c = el("circle", { cx: p.x, cy: p.y, r: r, class: "node", fill: COLOR[p.n.kind] });
    c.addEventListener("click", function () {
      if (selected) selected.classList.remove("sel");
      c.classList.add("sel"); selected = c; showDiff(p.n);
    });
    svg.appendChild(c);
    var lbl = el("text", { x: p.x + r + 3, y: p.y + 4, class: "lbl" });
    lbl.textContent = p.n.name; svg.appendChild(lbl);
  });

  function showDiff(n) {
    var panel = document.getElementById("panel");
    var rows = D.diffs[n.id];
    var head = '<h2>' + esc(n.name) + '  <span class="ln-ctx">' + esc(n.file) + ':' + n.line + '</span></h2>';
    if (!rows) { panel.innerHTML = head + '<div class="empty">Context node \\u2014 unchanged in this diff.</div>'; return; }
    var pre = rows.map(function (r) {
      var cls = r.type === "+" ? "ln-add" : r.type === "-" ? "ln-del" : "ln-ctx";
      var mark = r.type === "+" ? "+ " : r.type === "-" ? "\\u2212 " : "  ";
      return '<span class="' + cls + '">' + esc(mark + r.text) + '</span>';
    }).join("\\n");
    panel.innerHTML = head + '<pre>' + pre + '</pre>';
  }
  function esc(s) { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
})();
</script>
</body>
</html>
`;
