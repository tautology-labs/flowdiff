#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { listSourceFiles, readFilesAt, repoRoot, resolveRef, WORKTREE } from "./git.js";
import {
  buildGraph,
  changedTargets,
  diffGraphs,
  diffJson,
  findFn,
  pathsToTargets,
  type Graph,
} from "./graph.js";
import { renderBlast, renderDiff, renderFnDiff } from "./render.js";
import { renderHtml } from "./html.js";
import { runTui } from "./tui.js";
import { discoverRoots } from "./roots.js";

const HELP = `flowdiff — call-graph diffs for code review

Usage:
  flowdiff                     HEAD vs working tree
  flowdiff <base>              <base> vs working tree
  flowdiff <base> <head>       compare two revisions
  flowdiff <base>..<head>      same, range syntax
  flowdiff fn <name> [revs]    show one function's before/after diff
  flowdiff blast <name> [revs] incident mode: which changed functions can
                               touch <name>? (symptom fn + deploy range)
  flowdiff roots               list this repo's locally-linked sibling services
  flowdiff completions zsh     print shell completions (add to ~/.zshrc:
                               eval "$(flowdiff completions zsh)")

Flags:
  -i        interactive mode — navigate the graph, expand diffs, e to edit
  --html    self-contained interactive HTML graph (redirect, or writes a file)
  --json    machine-readable output (for scripts, or for feeding an AI)
  --help    this text

Languages: TypeScript, JavaScript, Java, Python.
MCP server (callers/callees/flow_diff/blast_radius tools for AI agents):
  claude mcp add flowdiff -- node <path-to-flowdiff>/dist/mcp.js
`;

const ZSH_COMPLETIONS = `#compdef flowdiff
__flowdiff_refs() {
  local -a refs
  refs=(HEAD \${(f)"$(git for-each-ref --format='%(refname:short)' refs/heads refs/tags 2>/dev/null)"})
  compadd -a refs
}
__flowdiff_fns() {
  local -a fns
  fns=(\${(f)"$(flowdiff --list-fns 2>/dev/null)"})
  compadd -a fns
}
_flowdiff() {
  local curcontext="$curcontext" state line
  _arguments -C \\
    '(-i --interactive)'{-i,--interactive}'[interactive TUI]' \\
    '--json[machine-readable output]' \\
    '(-h --help)'{-h,--help}'[help]' \\
    '1:command or ref:->first' \\
    '*:argument:->rest'
  case $state in
    first)
      local -a cmds
      cmds=('fn:diff one function' 'blast:incident mode — changed functions that can touch a symptom' 'roots:list linked sibling services' 'completions:print shell completions')
      _describe -t commands 'flowdiff command' cmds
      __flowdiff_refs
      ;;
    rest)
      if [[ (\${words[2]} == fn || \${words[2]} == blast) && CURRENT -eq 3 ]]; then
        __flowdiff_fns
      elif [[ \${words[2]} == completions ]]; then
        compadd zsh
      else
        __flowdiff_refs
      fi
      ;;
  esac
}
compdef _flowdiff flowdiff
`;

function loadGraph(ref: string, cwd: string): Graph {
  const paths = listSourceFiles(ref, cwd);
  const texts = readFilesAt(ref, paths, cwd);
  const files = paths
    .map((path) => ({ path, text: texts.get(path) ?? null }))
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
  const html = argv.includes("--html");
  const interactive = argv.includes("-i") || argv.includes("--interactive");
  const args = argv.filter((a) => !a.startsWith("-"));

  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }

  if (args[0] === "completions") {
    if (args[1] && args[1] !== "zsh") {
      process.stderr.write("flowdiff: only zsh completions exist so far\n");
      process.exit(1);
    }
    process.stdout.write(ZSH_COMPLETIONS);
    return;
  }

  let cwd: string;
  try {
    cwd = repoRoot(process.cwd());
  } catch {
    process.stderr.write("flowdiff: not inside a git repository\n");
    process.exit(1);
  }

  // Hidden: feeds `flowdiff fn <TAB>` — unique function names in the worktree.
  if (argv.includes("--list-fns")) {
    const graph = loadGraph(WORKTREE, cwd);
    const names = new Set<string>();
    for (const fn of graph.fns.values()) {
      names.add(fn.name);
      if (names.size >= 5000) break;
    }
    process.stdout.write([...names].sort().join("\n") + "\n");
    return;
  }

  if (args[0] === "roots") {
    const roots = discoverRoots(cwd);
    if (roots.length === 1) {
      process.stdout.write(
        `${roots[0].name}  ${roots[0].dir}\n(no locally-linked sibling services found)\n`,
      );
    } else {
      for (const r of roots) process.stdout.write(`${r.name}\t${r.dir}\n`);
      process.stdout.write(
        `\n${roots.length} roots — the flowdiff MCP traverses calls across all of them.\n`,
      );
    }
    return;
  }

  const fnMode = args[0] === "fn";
  const blastMode = args[0] === "blast";
  const fnName = fnMode || blastMode ? args[1] : null;
  if ((fnMode || blastMode) && !fnName) {
    process.stderr.write(`flowdiff: ${args[0]} requires a function name\n`);
    process.exit(1);
  }
  const { base, head } = parseRevs(fnMode || blastMode ? args.slice(2) : args);

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

  if (blastMode && fnName) {
    const hits = findFn(headGraph, fnName);
    if (hits.length === 0) {
      process.stderr.write(`flowdiff: no function named "${fnName}" at ${label(head)}\n`);
      const near = [...headGraph.fns.values()]
        .filter((f) => f.name.toLowerCase().includes(fnName.toLowerCase()))
        .slice(0, 8);
      if (near.length > 0) {
        process.stderr.write("did you mean:\n");
        for (const f of near) process.stderr.write(`  ${f.name}  (${f.file})\n`);
      }
      process.exit(1);
    }
    if (hits.length > 1) {
      process.stderr.write(`flowdiff: "${fnName}" is ambiguous — pick one:\n`);
      for (const h of hits) process.stderr.write(`  ${h.id}\n`);
      process.exit(1);
    }
    const symptom = hits[0];
    const diff = diffGraphs(baseGraph, headGraph);
    const changedKind = changedTargets(diff);
    const targets = new Set(changedKind.keys());
    process.stdout.write(
      renderBlast(
        symptom,
        headGraph,
        changedKind,
        pathsToTargets(headGraph, symptom.id, targets, "down"),
        pathsToTargets(headGraph, symptom.id, targets, "up"),
        diff.removed,
        label(base),
        label(head),
      ),
    );
    return;
  }

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

  if (html) {
    const doc = renderHtml(diff, baseGraph, headGraph, label(base), label(head));
    if (process.stdout.isTTY) {
      // Piping HTML to a terminal is useless — write a file and point at it.
      const out = join(cwd, "flowdiff-review.html");
      writeFileSync(out, doc);
      process.stderr.write(`flowdiff: wrote ${out}\n`);
    } else {
      process.stdout.write(doc);
    }
    return;
  }

  process.stdout.write(renderDiff(diff, baseGraph, headGraph, label(base), label(head)));
}

main();
