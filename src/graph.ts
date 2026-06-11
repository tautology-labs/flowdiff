import { extractFunctions, type FnInfo } from "./extract.js";

export interface Edge {
  fromId: string;
  /** Resolved fn id, or `ext:<name>` when the callee isn't defined in the repo. */
  toId: string;
  toName: string;
  external: boolean;
}

export interface Graph {
  fns: Map<string, FnInfo>;
  /** Edge key `fromId -> toId` → Edge. */
  edges: Map<string, Edge>;
  /** toId → incoming edges. */
  callersOf: Map<string, Edge[]>;
}

/**
 * Method/property names so generic that an unresolved call to them is noise
 * (array methods, promise plumbing, console, collections). Only applies to
 * calls that do NOT resolve to a function defined in the repo.
 */
const EXTERNAL_NOISE = new Set([
  "log", "warn", "error", "info", "debug",
  "push", "pop", "shift", "unshift", "slice", "splice", "concat", "indexOf",
  "map", "filter", "forEach", "reduce", "find", "findIndex", "some", "every",
  "includes", "join", "split", "replace", "replaceAll", "trim", "match",
  "startsWith", "endsWith", "toLowerCase", "toUpperCase", "charAt", "padStart", "padEnd",
  "get", "set", "has", "add", "delete", "clear", "keys", "values", "entries",
  "then", "catch", "finally", "resolve", "reject", "all",
  "toString", "valueOf", "toFixed", "stringify", "parse",
  "freeze", "assign", "from", "isArray", "now", "bind", "call", "apply",
]);

export function buildGraph(files: { path: string; text: string }[]): Graph {
  const fns = new Map<string, FnInfo>();
  const byName = new Map<string, FnInfo[]>();

  const index = (key: string, fn: FnInfo) => {
    const arr = byName.get(key);
    if (arr) arr.push(fn);
    else byName.set(key, [fn]);
  };

  for (const file of files) {
    for (const fn of extractFunctions(file.path, file.text)) {
      let id = fn.id;
      for (let n = 2; fns.has(id); n++) id = `${fn.id}#${n}`;
      fn.id = id;
      fns.set(id, fn);
      index(fn.name, fn);
      // Methods are named `Class.method`; call sites only see `method`.
      const base = fn.name.split(".").pop()!;
      if (base !== fn.name) index(base, fn);
    }
  }

  const edges = new Map<string, Edge>();
  const callersOf = new Map<string, Edge[]>();

  for (const fn of fns.values()) {
    for (const callee of new Set(fn.calls)) {
      let targets = byName.get(callee) ?? [];
      // Prefer a same-file definition when one exists.
      const local = targets.filter((t) => t.file === fn.file);
      if (local.length > 0) targets = local;

      const tos: { toId: string; external: boolean }[] =
        targets.length > 0
          ? targets.filter((t) => t.id !== fn.id).map((t) => ({ toId: t.id, external: false }))
          : EXTERNAL_NOISE.has(callee)
            ? []
            : [{ toId: `ext:${callee}`, external: true }];

      for (const { toId, external } of tos) {
        const key = `${fn.id} -> ${toId}`;
        if (edges.has(key)) continue;
        const edge: Edge = { fromId: fn.id, toId, toName: callee, external };
        edges.set(key, edge);
        const arr = callersOf.get(toId);
        if (arr) arr.push(edge);
        else callersOf.set(toId, [edge]);
      }
    }
  }

  return { fns, edges, callersOf };
}

export interface GraphDiff {
  added: FnInfo[];
  removed: FnInfo[];
  modified: { before: FnInfo; after: FnInfo }[];
  /** Same code under a new name (or new file — a move). */
  renamed: { before: FnInfo; after: FnInfo }[];
  addedEdges: Edge[];
  removedEdges: Edge[];
}

/**
 * Pair removed↔added functions whose name-blinded bodies hash identically.
 * Only unambiguous 1:1 hash matches count — two identical helpers renamed in
 * one change stay as add/remove rather than guessing which became which.
 */
function detectRenames(
  added: FnInfo[],
  removed: FnInfo[],
): { before: FnInfo; after: FnInfo }[] {
  const group = (fns: FnInfo[]) => {
    const m = new Map<string, FnInfo[]>();
    for (const fn of fns) {
      const arr = m.get(fn.renameHash);
      if (arr) arr.push(fn);
      else m.set(fn.renameHash, [fn]);
    }
    return m;
  };
  const addedByHash = group(added);
  const removedByHash = group(removed);

  const renamed: { before: FnInfo; after: FnInfo }[] = [];
  for (const [hash, befores] of removedByHash) {
    const afters = addedByHash.get(hash);
    if (befores.length === 1 && afters?.length === 1) {
      renamed.push({ before: befores[0], after: afters[0] });
    }
  }
  return renamed;
}

export function diffGraphs(base: Graph, head: Graph): GraphDiff {
  let added: FnInfo[] = [];
  let removed: FnInfo[] = [];
  const modified: { before: FnInfo; after: FnInfo }[] = [];

  for (const [id, fn] of head.fns) {
    const old = base.fns.get(id);
    if (!old) added.push(fn);
    else if (old.bodyHash !== fn.bodyHash) modified.push({ before: old, after: fn });
  }
  for (const [id, fn] of base.fns) {
    if (!head.fns.has(id)) removed.push(fn);
  }

  const renamed = detectRenames(added, removed);
  const renamedAfterIds = new Set(renamed.map((r) => r.after.id));
  const renamedBeforeIds = new Set(renamed.map((r) => r.before.id));
  added = added.filter((fn) => !renamedAfterIds.has(fn.id));
  removed = removed.filter((fn) => !renamedBeforeIds.has(fn.id));

  // Compare edges through the rename map, so `helper → newHelper` doesn't
  // make every edge touching it look added+removed.
  const idMap = new Map(renamed.map((r) => [r.before.id, r.after.id]));
  const mapKey = (e: Edge) =>
    `${idMap.get(e.fromId) ?? e.fromId} -> ${idMap.get(e.toId) ?? e.toId}`;
  const baseKeys = new Set([...base.edges.values()].map(mapKey));

  const addedEdges = [...head.edges.entries()]
    .filter(([key]) => !baseKeys.has(key))
    .map(([, e]) => e);
  const removedEdges = [...base.edges.values()].filter(
    (e) => !head.edges.has(mapKey(e)),
  );

  return { added, removed, modified, renamed, addedEdges, removedEdges };
}
