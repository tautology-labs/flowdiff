#!/usr/bin/env node
/**
 * flowdiff MCP server — exposes the call graph as tools over stdio, so an
 * AI agent can traverse code the way the TUI user does: function by
 * function, following edges, instead of reading whole files.
 *
 * Hand-rolled JSON-RPC (newline-delimited) — no SDK dependency.
 */
import { createInterface } from "node:readline";
import { listSourceFiles, readFileAt, repoRoot, resolveRef, WORKTREE } from "./git.js";
import {
  buildGraph,
  diffGraphs,
  diffJson,
  findFn,
  type Graph,
} from "./graph.js";
import type { FnInfo } from "./extract.js";
import { diffLines } from "./linediff.js";

const cwd = repoRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());

/** Commit graphs are immutable — cache by resolved sha. Worktree re-parses. */
const cache = new Map<string, Graph>();

function graphAt(ref: string): Graph {
  const resolved = resolveRef(ref === "worktree" ? WORKTREE : ref, cwd);
  if (resolved !== WORKTREE) {
    const hit = cache.get(resolved);
    if (hit) return hit;
  }
  const files = listSourceFiles(resolved, cwd)
    .map((path) => ({ path, text: readFileAt(resolved, path, cwd) }))
    .filter((f): f is { path: string; text: string } => f.text !== null);
  const graph = buildGraph(files);
  if (resolved !== WORKTREE) cache.set(resolved, graph);
  return graph;
}

function resolveOne(graph: Graph, name: string): FnInfo {
  const hits = findFn(graph, name);
  if (hits.length === 0) throw new Error(`no function named "${name}"`);
  if (hits.length > 1) {
    throw new Error(
      `"${name}" is ambiguous — use a file#name id: ${hits.map((h) => h.id).join(", ")}`,
    );
  }
  return hits[0];
}

const slim = (fn: FnInfo) => ({ id: fn.id, name: fn.name, file: fn.file, line: fn.line });

const TOOLS = [
  {
    name: "find_functions",
    description:
      "Search functions in the repo by name substring. With entry_points_only, returns functions no other in-repo function calls (the places execution starts) — the right first call when exploring an unfamiliar codebase.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Case-insensitive name substring. Omit to list all." },
        ref: { type: "string", description: "Git ref, or 'worktree' (default) for files on disk." },
        entry_points_only: { type: "boolean", description: "Only functions with no in-repo callers." },
      },
    },
  },
  {
    name: "function_info",
    description:
      "One function's source plus its graph neighborhood: callers (who reaches it), callees (where it goes in-repo), and external calls (imports/stdlib). Use repeatedly to walk a call stack without reading whole files.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Function name, Class.method, or file#name id." },
        ref: { type: "string", description: "Git ref, or 'worktree' (default)." },
      },
      required: ["name"],
    },
  },
  {
    name: "flow_diff",
    description:
      "The structural delta between two revisions: functions added/removed/modified/renamed and call edges added/removed. The map of what a change actually did — start here when reviewing.",
    inputSchema: {
      type: "object",
      properties: {
        base: { type: "string", description: "Older ref (default HEAD)." },
        head: { type: "string", description: "Newer ref, or 'worktree' (default)." },
      },
    },
  },
  {
    name: "function_diff",
    description: "One function's before/after line diff between two revisions.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Function name, Class.method, or file#name id." },
        base: { type: "string", description: "Older ref (default HEAD)." },
        head: { type: "string", description: "Newer ref, or 'worktree' (default)." },
      },
      required: ["name"],
    },
  },
];

type Args = Record<string, string | boolean | undefined>;

function callTool(name: string, args: Args): unknown {
  const ref = (args.ref as string) || "worktree";
  const base = (args.base as string) || "HEAD";
  const head = (args.head as string) || "worktree";

  if (name === "find_functions") {
    const g = graphAt(ref);
    const q = ((args.query as string) || "").toLowerCase();
    let fns = [...g.fns.values()].filter((f) => f.name.toLowerCase().includes(q));
    if (args.entry_points_only) {
      fns = fns.filter((f) => (g.callersOf.get(f.id) ?? []).length === 0);
    }
    return {
      total: fns.length,
      functions: fns.slice(0, 50).map((f) => ({
        ...slim(f),
        callers: (g.callersOf.get(f.id) ?? []).length,
      })),
      truncated: fns.length > 50,
    };
  }

  if (name === "function_info") {
    const g = graphAt(ref);
    const fn = resolveOne(g, args.name as string);
    const callees = [...g.edges.values()].filter((e) => e.fromId === fn.id);
    return {
      ...slim(fn),
      source: fn.source,
      callers: (g.callersOf.get(fn.id) ?? []).map((e) => {
        const caller = g.fns.get(e.fromId);
        return caller ? slim(caller) : { id: e.fromId };
      }),
      callees: callees
        .filter((e) => !e.external)
        .map((e) => {
          const callee = g.fns.get(e.toId);
          return callee ? slim(callee) : { id: e.toId };
        }),
      external_calls: callees.filter((e) => e.external).map((e) => e.toName),
    };
  }

  if (name === "flow_diff") {
    const diff = diffGraphs(graphAt(base), graphAt(head));
    return diffJson(diff, base, head);
  }

  if (name === "function_diff") {
    const baseGraph = graphAt(base);
    const headGraph = graphAt(head);
    const befores = findFn(baseGraph, args.name as string);
    const afters = findFn(headGraph, args.name as string);
    if (befores.length === 0 && afters.length === 0) {
      throw new Error(`no function named "${args.name}" at either revision`);
    }
    const before = befores[0] ?? null;
    const after = afters[0] ?? null;
    return {
      before: before && slim(before),
      after: after && slim(after),
      diff: diffLines(
        before ? before.source.split("\n") : [],
        after ? after.source.split("\n") : [],
      ),
    };
  }

  throw new Error(`unknown tool: ${name}`);
}

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: {
    protocolVersion?: string;
    name?: string;
    arguments?: Args;
  };
}

function reply(id: number | string, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function replyError(id: number | string, code: number, message: string): void {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n",
  );
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg: RpcMessage;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notification — nothing to answer

  try {
    if (method === "initialize") {
      reply(id, {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "flowdiff", version: "0.1.0" },
      });
    } else if (method === "tools/list") {
      reply(id, { tools: TOOLS });
    } else if (method === "tools/call") {
      try {
        const result = callTool(params?.name ?? "", params?.arguments ?? {});
        reply(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      } catch (err) {
        reply(id, {
          content: [{ type: "text", text: String(err instanceof Error ? err.message : err) }],
          isError: true,
        });
      }
    } else if (method === "ping") {
      reply(id, {});
    } else {
      replyError(id, -32601, `method not found: ${method}`);
    }
  } catch (err) {
    replyError(id, -32603, String(err instanceof Error ? err.message : err));
  }
});
