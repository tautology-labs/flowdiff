#!/usr/bin/env node
import { listSourceFiles, readFileAt, repoRoot, resolveRef, WORKTREE } from "./git.js";
import { buildGraph, diffGraphs, diffJson, findFn, type Graph } from "./graph.js";
import { renderDiff, renderFnDiff } from "./render.js";
import { runTui } from "./tui.js";

const HELP = `flowdiff — call-graph diffs for code review

Usage:
  flowdiff                     HEAD vs working tree
  flowdiff <base>              <base> vs working tree
  flowdiff <base> <head>       compare two revisions
  flowdiff <base>..<head>      same, range syntax
  flowdiff fn <name> [revs]    show one function's before/after diff

Flags:
  -i        interactive mode — navigate the graph, expand diffs, e to edit
  --json    machine-readable output (for scripts, or for feeding an AI)
  --help    this text
`;

function loadGraph(ref: string, cwd: string): Graph {
  const files = listSourceFiles(ref, cwd)
    .map((path) => ({ path, text: readFileAt(ref, path, cwd) }))
    .filter((f): f is { path: string; text: string } => f.text !== null);
  return buildGraph(files);
}

function label(ref: string): string {
  return ref === WORKTREE ? "worktree" : ref;
}

function parseRevs(args: string[]): { base: string; head: string } {
  if (args.length === 1 && args[0].includes("..")) {
    const [base, head] = args[0].split("..").filter(Boolean);
    return { base, head: head ?? WORKTREE };
  }
  return { base: args[0] ?? "HEAD", head: args[1] ?? WORKTREE };
}

function main(): void {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const interactive = argv.includes("-i") || argv.includes("--interactive");
  const args = argv.filter((a) => !a.startsWith("-"));

  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }

  let cwd: string;
  try {
    cwd = repoRoot(process.cwd());
  } catch {
    process.stderr.write("flowdiff: not inside a git repository\n");
    process.exit(1);
  }

  const fnMode = args[0] === "fn";
  const fnName = fnMode ? args[1] : null;
  if (fnMode && !fnName) {
    process.stderr.write("flowdiff: fn requires a function name\n");
    process.exit(1);
  }
  const { base, head } = parseRevs(fnMode ? args.slice(2) : args);

  let baseRef: string;
  let headRef: string;
  try {
    baseRef = resolveRef(base, cwd);
    headRef = resolveRef(head, cwd);
  } catch {
    process.stderr.write(`flowdiff: cannot resolve revision ${base} or ${head}\n`);
    process.exit(1);
  }

  const baseGraph = loadGraph(baseRef, cwd);
  const headGraph = loadGraph(headRef, cwd);

  if (fnMode && fnName) {
    const befores = findFn(baseGraph, fnName);
    const afters = findFn(headGraph, fnName);
    if (befores.length === 0 && afters.length === 0) {
      process.stderr.write(`flowdiff: no function named "${fnName}" at either revision\n`);
      process.exit(1);
    }
    if (befores.length > 1 || afters.length > 1) {
      const ids = new Set([...befores, ...afters].map((f) => f.id));
      if (ids.size > 1) {
        process.stderr.write(`flowdiff: "${fnName}" is ambiguous — pick one:\n`);
        for (const id of [...ids].sort()) process.stderr.write(`  ${id}\n`);
        process.stderr.write(
          `any unique suffix works, e.g. flowdiff fn "${[...ids][0].split("/").pop()}"\n`,
        );
        process.exit(1);
      }
    }
    process.stdout.write(renderFnDiff(fnName, befores[0] ?? null, afters[0] ?? null));
    return;
  }

  if (interactive) {
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      process.stderr.write("flowdiff: -i needs an interactive terminal\n");
      process.exit(1);
    }
    runTui({
      cwd,
      baseLabel: label(base),
      headLabel: label(head),
      baseGraph,
      initialHead: headGraph,
      loadHead: () => loadGraph(headRef, cwd),
      headIsWorktree: headRef === WORKTREE,
    });
    return;
  }

  const diff = diffGraphs(baseGraph, headGraph);

  if (json) {
    process.stdout.write(
      JSON.stringify(diffJson(diff, label(base), label(head)), null, 2) + "\n",
    );
    return;
  }

  process.stdout.write(renderDiff(diff, baseGraph, headGraph, label(base), label(head)));
}

main();
