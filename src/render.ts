import type { FnInfo } from "./extract.js";
import type { Edge, Graph, GraphDiff } from "./graph.js";
import { bold, cyan, dim, green, red, yellow } from "./ansi.js";
import { diffLines } from "./linediff.js";

const INDENT = "  ";

function shortName(id: string): string {
  if (id.startsWith("ext:")) return id.slice(4);
  return id.split("#")[1] ?? id;
}

function fileOf(id: string): string | null {
  if (id.startsWith("ext:")) return null;
  return id.split("#")[0];
}

/** `name (other/file.ts)` — file shown only when it differs from `homeFile`. */
function ref(id: string, homeFile: string, graph: Graph): string {
  const name = cyan(shortName(id));
  if (id.startsWith("ext:")) return dim(shortName(id));
  const file = fileOf(id);
  const fn = graph.fns.get(id);
  const line = fn ? dim(`:${fn.line}`) : "";
  return file && file !== homeFile ? `${name}${line} ${dim(`(${file})`)}` : name + line;
}

export interface EdgeChanges {
  addedByFrom: Map<string, Edge[]>;
  removedByFrom: Map<string, Edge[]>;
  addedByTo: Map<string, Edge[]>;
  removedByTo: Map<string, Edge[]>;
}

export function groupEdges(diff: GraphDiff): EdgeChanges {
  const group = (edges: Edge[], key: (e: Edge) => string) => {
    const m = new Map<string, Edge[]>();
    for (const e of edges) {
      const k = key(e);
      const arr = m.get(k);
      if (arr) arr.push(e);
      else m.set(k, [e]);
    }
    return m;
  };
  return {
    addedByFrom: group(diff.addedEdges, (e) => e.fromId),
    removedByFrom: group(diff.removedEdges, (e) => e.fromId),
    addedByTo: group(diff.addedEdges, (e) => e.toId),
    removedByTo: group(diff.removedEdges, (e) => e.toId),
  };
}

export interface ChangeEntry {
  fn: FnInfo;
  before: FnInfo | null;
  after: FnInfo | null;
  kind: "added" | "renamed" | "modified" | "removed";
  marker: string;
  title?: string;
}

/** Every changed function as a flat card list: by file, then kind, then line. */
export function changedEntries(diff: GraphDiff): ChangeEntry[] {
  const entries: ChangeEntry[] = [];
  for (const fn of diff.added) {
    entries.push({ fn, before: null, after: fn, kind: "added", marker: green("+") });
  }
  for (const r of diff.renamed) {
    const from =
      r.before.file === r.after.file
        ? bold(r.before.name)
        : `${bold(r.before.name)} ${dim(`(${r.before.file})`)}`;
    entries.push({
      fn: r.after,
      before: r.before,
      after: r.after,
      kind: "renamed",
      marker: cyan("→"),
      title: `${from} ${cyan("→")} ${bold(r.after.name)}`,
    });
  }
  for (const m of diff.modified) {
    entries.push({ fn: m.after, before: m.before, after: m.after, kind: "modified", marker: yellow("~") });
  }
  for (const fn of diff.removed) {
    entries.push({ fn, before: fn, after: null, kind: "removed", marker: red("−") });
  }
  const order = { added: 0, renamed: 1, modified: 2, removed: 3 };
  entries.sort(
    (a, b) =>
      a.fn.file.localeCompare(b.fn.file) ||
      order[a.kind] - order[b.kind] ||
      a.fn.line - b.fn.line,
  );
  return entries;
}

export function renderFnBlock(
  out: string[],
  fn: FnInfo,
  marker: string,
  base: Graph,
  head: Graph,
  ch: EdgeChanges,
  consumedFroms: Set<string>,
  title?: string,
): void {
  out.push(`${INDENT}${marker} ${title ?? bold(fn.name)} ${dim(`:${fn.line}`)}`);
  consumedFroms.add(fn.id);

  const isRemoved = marker.includes("−");
  const current = isRemoved ? base : head;

  // Mega-caller functions (a public API can have 100+ callers) get a count
  // instead of an unreadable wall; the TUI's refs browser shows the rest.
  const MAX_REFS = 8;
  const row = (label: string, parts: string[]) => {
    if (parts.length > MAX_REFS) {
      parts = [...parts.slice(0, MAX_REFS), dim(`+${parts.length - MAX_REFS} more`)];
    }
    out.push(`${INDENT}${INDENT}${dim(label.padEnd(10))}${parts.join("  ")}`);
  };

  // Callers: who reaches this function now (or did, if removed).
  const callers = current.callersOf.get(fn.id) ?? [];
  const newCallerIds = new Set((ch.addedByTo.get(fn.id) ?? []).map((e) => e.fromId));
  const lostCallers = isRemoved ? [] : (ch.removedByTo.get(fn.id) ?? []);
  const callerParts = [
    ...callers.map((e) =>
      newCallerIds.has(e.fromId)
        ? green("+") + ref(e.fromId, fn.file, current)
        : ref(e.fromId, fn.file, current),
    ),
    ...lostCallers.map((e) => red("−") + ref(e.fromId, fn.file, base)),
  ];
  if (callerParts.length > 0) {
    row("callers", callerParts);
  } else if (!isRemoved) {
    row("callers", [dim("none found (entry point?)")]);
  }

  // Calls: where this function goes. In-repo edges are the flow; calls that
  // leave the repo (imports, stdlib) get their own row instead of a symbol.
  const calls = [...current.edges.values()].filter((e) => e.fromId === fn.id);
  const newCallKeys = new Set((ch.addedByFrom.get(fn.id) ?? []).map((e) => e.toId));
  const lostCalls = isRemoved ? [] : (ch.removedByFrom.get(fn.id) ?? []);
  const part = (e: Edge, graph: Graph, mark: string) =>
    mark + ref(e.toId, fn.file, graph);
  const inRepoParts = [
    ...calls
      .filter((e) => !e.external)
      .map((e) => part(e, current, newCallKeys.has(e.toId) ? green("+") : "")),
    ...lostCalls.filter((e) => !e.external).map((e) => part(e, base, red("−"))),
  ];
  const externalParts = [
    ...calls
      .filter((e) => e.external)
      .map((e) => part(e, current, newCallKeys.has(e.toId) ? green("+") : "")),
    ...lostCalls.filter((e) => e.external).map((e) => part(e, base, red("−"))),
  ];
  if (inRepoParts.length > 0) row("calls", inRepoParts);
  if (externalParts.length > 0) row("external", externalParts);
  out.push("");
}

export function renderDiff(
  diff: GraphDiff,
  base: Graph,
  head: Graph,
  baseLabel: string,
  headLabel: string,
): string {
  const out: string[] = [];
  const ch = groupEdges(diff);

  out.push("");
  out.push(`${bold("flowdiff")} ${baseLabel} ${dim("→")} ${headLabel}`);
  out.push("");
  out.push(
    `${INDENT}${dim("functions")}   ${green(`+${diff.added.length}`)}  ${red(`−${diff.removed.length}`)}  ${yellow(`~${diff.modified.length}`)}  ${cyan(`→${diff.renamed.length}`)}` +
      `      ${dim("call edges")}  ${green(`+${diff.addedEdges.length}`)}  ${red(`−${diff.removedEdges.length}`)}`,
  );
  out.push(
    `${INDENT}${green("+ added")}   ${red("− removed")}   ${yellow("~ body changed")}   ${cyan("→ renamed/moved")}   ${dim("external = calls leaving this repo")}`,
  );
  out.push("");

  const totalChanges =
    diff.added.length +
    diff.removed.length +
    diff.modified.length +
    diff.renamed.length;
  if (totalChanges === 0 && diff.addedEdges.length === 0 && diff.removedEdges.length === 0) {
    out.push(`${INDENT}${dim("no structural changes — the call graph is identical")}`);
    out.push("");
    return out.join("\n");
  }

  const consumed = new Set<string>();
  let lastFile = "";
  for (const e of changedEntries(diff)) {
    if (e.fn.file !== lastFile) {
      out.push(bold(e.fn.file));
      out.push("");
      lastFile = e.fn.file;
    }
    renderFnBlock(out, e.fn, e.marker, base, head, ch, consumed, e.title);
  }

  // Edge changes whose source function body didn't change (e.g. a call that
  // used to resolve externally now resolves to a new in-repo function).
  const leftoverFroms = new Set<string>();
  for (const id of ch.addedByFrom.keys()) if (!consumed.has(id)) leftoverFroms.add(id);
  for (const id of ch.removedByFrom.keys()) if (!consumed.has(id)) leftoverFroms.add(id);
  if (leftoverFroms.size > 0) {
    out.push(bold(dim("rewired calls (caller body unchanged)")));
    for (const fromId of [...leftoverFroms].sort()) {
      const file = fileOf(fromId) ?? "";
      const added = (ch.addedByFrom.get(fromId) ?? [])
        .map((e) => green("+") + ref(e.toId, file, head));
      const removed = (ch.removedByFrom.get(fromId) ?? [])
        .map((e) => red("−") + ref(e.toId, file, base));
      out.push(
        `${INDENT}${dim("○")} ${bold(shortName(fromId))} ${dim(`(${file})`)}  ${[...added, ...removed].join("  ")}`,
      );
    }
    out.push("");
  }

  out.push(dim(`${INDENT}flowdiff fn <name> shows a function's full diff`));
  out.push("");
  return out.join("\n");
}

export function renderFnDiff(
  name: string,
  before: FnInfo | null,
  after: FnInfo | null,
): string {
  const out: string[] = [];
  out.push("");
  if (before && after) {
    out.push(`${bold(name)} ${dim(`${before.file}:${before.line} → ${after.file}:${after.line}`)}`);
    out.push("");
    if (before.bodyHash === after.bodyHash) {
      out.push(`${INDENT}${dim("unchanged")}`);
    } else {
      for (const line of diffLines(before.source.split("\n"), after.source.split("\n"))) {
        if (line.type === "+") out.push(green(`+ ${line.text}`));
        else if (line.type === "-") out.push(red(`− ${line.text}`));
        else out.push(dim(`  ${line.text}`));
      }
    }
  } else if (after) {
    out.push(`${bold(name)} ${green("(added)")} ${dim(`${after.file}:${after.line}`)}`);
    out.push("");
    for (const text of after.source.split("\n")) out.push(green(`+ ${text}`));
  } else if (before) {
    out.push(`${bold(name)} ${red("(removed)")} ${dim(`${before.file}:${before.line}`)}`);
    out.push("");
    for (const text of before.source.split("\n")) out.push(red(`− ${text}`));
  }
  out.push("");
  return out.join("\n");
}
