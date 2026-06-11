import type { FnInfo } from "./extract.js";
import type { Edge, Graph, GraphDiff } from "./graph.js";
import { bold, cyan, dim, green, magenta, red, yellow } from "./ansi.js";
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
  if (id.startsWith("ext:")) return name + magenta("*");
  const file = fileOf(id);
  const fn = graph.fns.get(id);
  const line = fn ? dim(`:${fn.line}`) : "";
  return file && file !== homeFile ? `${name}${line} ${dim(`(${file})`)}` : name + line;
}

interface EdgeChanges {
  addedByFrom: Map<string, Edge[]>;
  removedByFrom: Map<string, Edge[]>;
  addedByTo: Map<string, Edge[]>;
  removedByTo: Map<string, Edge[]>;
}

function groupEdges(diff: GraphDiff): EdgeChanges {
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

function renderFnBlock(
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
    out.push(`${INDENT}${INDENT}${dim("callers")}  ${callerParts.join("  ")}`);
  } else if (!isRemoved) {
    out.push(`${INDENT}${INDENT}${dim("callers")}  ${dim("none found (entry point?)")}`);
  }

  // Calls: where this function goes.
  const calls = [...current.edges.values()].filter((e) => e.fromId === fn.id);
  const newCallKeys = new Set((ch.addedByFrom.get(fn.id) ?? []).map((e) => e.toId));
  const lostCalls = isRemoved ? [] : (ch.removedByFrom.get(fn.id) ?? []);
  const callParts = [
    ...calls.map((e) =>
      newCallKeys.has(e.toId)
        ? green("+") + ref(e.toId, fn.file, current)
        : ref(e.toId, fn.file, current),
    ),
    ...lostCalls.map((e) => red("−") + ref(e.toId, fn.file, base)),
  ];
  if (callParts.length > 0) {
    out.push(`${INDENT}${INDENT}${dim("calls")}    ${callParts.join("  ")}`);
  }
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

  // Group every changed function by file, preserving the change kind.
  type Entry = { fn: FnInfo; marker: string; order: number; title?: string };
  const byFile = new Map<string, Entry[]>();
  const put = (fn: FnInfo, marker: string, order: number, title?: string) => {
    const arr = byFile.get(fn.file);
    const entry = { fn, marker, order, title };
    if (arr) arr.push(entry);
    else byFile.set(fn.file, [entry]);
  };
  for (const fn of diff.added) put(fn, green("+"), 0);
  for (const r of diff.renamed) {
    const from =
      r.before.file === r.after.file
        ? bold(r.before.name)
        : `${bold(r.before.name)} ${dim(`(${r.before.file})`)}`;
    put(r.after, cyan("→"), 1, `${from} ${cyan("→")} ${bold(r.after.name)}`);
  }
  for (const m of diff.modified) put(m.after, yellow("~"), 2);
  for (const fn of diff.removed) put(fn, red("−"), 3);

  const consumed = new Set<string>();
  for (const file of [...byFile.keys()].sort()) {
    out.push(bold(file));
    const entries = byFile.get(file)!;
    entries.sort((a, b) => a.order - b.order || a.fn.line - b.fn.line);
    for (const { fn, marker, title } of entries) {
      renderFnBlock(out, fn, marker, base, head, ch, consumed, title);
    }
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

  out.push(dim(`${INDENT}${magenta("*")} = not defined in this repo · flowdiff fn <name> shows a function's diff`));
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
