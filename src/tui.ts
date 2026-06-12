import { spawnSync } from "node:child_process";
import { diffGraphs, type Graph, type GraphDiff } from "./graph.js";
import {
  changedEntries,
  groupEdges,
  renderFnBlock,
  type ChangeEntry,
} from "./render.js";
import { diffLines } from "./linediff.js";
import { bold, cyan, dim, green, red, yellow } from "./ansi.js";

export interface TuiOptions {
  cwd: string;
  baseLabel: string;
  headLabel: string;
  baseGraph: Graph;
  initialHead: Graph;
  loadHead: () => Graph;
  headIsWorktree: boolean;
}

const HELP_LINES = [
  "",
  bold("  keys"),
  "",
  `  ${cyan("↑/↓ j/k")}   move between functions`,
  `  ${cyan("enter")}     expand/collapse the function's diff`,
  `  ${cyan("→ / l")}     browse this function's callers and calls (scroll, enter jumps, ← back)`,
  `  ${cyan("e")}         open $EDITOR here — works on any caller in the refs browser too`,
  `  ${cyan("r")}         re-scan the working tree`,
  `  ${cyan("?")}         toggle this help`,
  `  ${cyan("q")}         quit`,
  "",
  bold("  markers"),
  "",
  `  ${green("+ added")}   ${red("− removed")}   ${yellow("~ body changed")}   ${cyan("→ renamed/moved")}`,
  `  ${dim("callers = arrows in · calls = arrows out (in repo) · external = calls leaving the repo")}`,
];

export function runTui(opts: TuiOptions): void {
  let headGraph = opts.initialHead;
  let diff: GraphDiff = diffGraphs(opts.baseGraph, headGraph);
  let entries: ChangeEntry[] = changedEntries(diff);
  let selected = 0;
  let scroll = 0;
  let refsMode = false;
  let refIdx = 0;
  let selRefLine = 0;
  let showHelp = false;
  let status = "";
  const expanded = new Set<string>();

  const out = process.stdout;

  const currentGraph = (e: ChangeEntry): Graph =>
    e.after ? headGraph : opts.baseGraph;

  interface Ref {
    id: string;
    name: string;
    file: string;
    line: number;
    kind: "caller" | "call";
    hasCard: boolean;
  }

  /** Every caller and in-repo callee of this card, scrollable in refs mode. */
  const refsFor = (e: ChangeEntry): Ref[] => {
    const g = currentGraph(e);
    const cards = new Set(entries.map((en) => en.fn.id));
    const seen = new Set<string>();
    const refs: Ref[] = [];
    const add = (id: string, kind: "caller" | "call") => {
      if (id === e.fn.id || seen.has(`${kind}:${id}`)) return;
      seen.add(`${kind}:${id}`);
      const fn = g.fns.get(id);
      if (!fn) return;
      refs.push({ id, name: fn.name, file: fn.file, line: fn.line, kind, hasCard: cards.has(id) });
    };
    for (const edge of g.callersOf.get(e.fn.id) ?? []) add(edge.fromId, "caller");
    for (const edge of g.edges.values()) {
      if (edge.fromId === e.fn.id && !edge.external) add(edge.toId, "call");
    }
    return refs;
  };

  const expandedDiff = (e: ChangeEntry): string[] => {
    if (e.before && e.after) {
      return diffLines(e.before.source.split("\n"), e.after.source.split("\n")).map(
        (l) =>
          l.type === "+"
            ? green(`      + ${l.text}`)
            : l.type === "-"
              ? red(`      − ${l.text}`)
              : dim(`        ${l.text}`),
      );
    }
    const fn = (e.after ?? e.before)!;
    return fn.source
      .split("\n")
      .map((t) => (e.after ? green(`      + ${t}`) : red(`      − ${t}`)));
  };

  const buildLines = (): { lines: string[]; headerAt: number[] } => {
    const lines: string[] = [];
    const headerAt: number[] = [];
    lines.push(
      `${bold("flowdiff")} ${opts.baseLabel} ${dim("→")} ${opts.headLabel}   ` +
        `${green(`+${diff.added.length}`)} ${red(`−${diff.removed.length}`)} ${yellow(`~${diff.modified.length}`)} ${cyan(`→${diff.renamed.length}`)}   ` +
        `${dim("? for help")}`,
    );
    lines.push("");
    if (showHelp) {
      lines.push(...HELP_LINES);
      return { lines, headerAt };
    }
    if (entries.length === 0) {
      lines.push(dim("  no structural changes — edit something and press r"));
      return { lines, headerAt };
    }
    const ch = groupEdges(diff);
    let lastFile = "";
    entries.forEach((e, i) => {
      if (e.fn.file !== lastFile) {
        lines.push(bold(e.fn.file));
        lines.push("");
        lastFile = e.fn.file;
      }
      headerAt[i] = lines.length;
      if (i === selected && refsMode) {
        // Refs browser: callers and calls as a scrollable vertical list.
        lines.push(`${cyan("▸")} ${e.marker} ${e.title ?? bold(e.fn.name)} ${dim(`:${e.fn.line}`)}`);
        const refs = refsFor(e);
        let lastKind = "";
        refs.forEach((ref, ri) => {
          if (ref.kind !== lastKind) {
            lines.push(
              `      ${dim(ref.kind === "caller" ? `callers (${refs.filter((r) => r.kind === "caller").length})` : `calls (${refs.filter((r) => r.kind === "call").length})`)}`,
            );
            lastKind = ref.kind;
          }
          const cursor = ri === refIdx ? cyan("▸ ") : "  ";
          const card = ref.hasCard ? "" : dim("  (unchanged)");
          if (ri === refIdx) selRefLine = lines.length;
          lines.push(
            `      ${cursor}${cyan(ref.name)} ${dim(`:${ref.line}`)} ${dim(`(${ref.file})`)}${card}`,
          );
        });
        if (refs.length === 0) lines.push(dim("      no in-repo callers or calls"));
        lines.push("");
        return;
      }
      const block: string[] = [];
      renderFnBlock(block, e.fn, e.marker, opts.baseGraph, headGraph, ch, new Set(), e.title);
      block[0] = (i === selected ? cyan("▸ ") : "  ") + block[0].slice(2);
      if (expanded.has(e.fn.id)) {
        block.splice(block.length - 1, 0, ...expandedDiff(e));
      }
      lines.push(...block);
    });
    return { lines, headerAt };
  };

  const render = (): void => {
    const rows = out.rows || 40;
    const { lines, headerAt } = buildLines();
    const view = rows - 1;
    const target = refsMode ? selRefLine : (headerAt[selected] ?? 0);
    if (target < scroll) scroll = Math.max(0, target - 2);
    if (target >= scroll + view - 4) scroll = target - view + 5;
    scroll = Math.max(0, Math.min(scroll, Math.max(0, lines.length - view)));

    const footer =
      status +
      (refsMode
        ? dim("↑↓ scroll refs · enter jump to card · e edit · ← back · q quit")
        : dim("↑↓ move · → callers/calls · enter expand · e edit · r refresh · ? help · q quit"));

    out.write(
      "\x1b[H\x1b[2J" +
        lines.slice(scroll, scroll + view).join("\r\n") +
        `\x1b[${rows};1H\x1b[2K` +
        footer,
    );
  };

  const refresh = (): void => {
    const keep = entries[selected]?.fn.id;
    headGraph = opts.loadHead();
    diff = diffGraphs(opts.baseGraph, headGraph);
    entries = changedEntries(diff);
    const idx = entries.findIndex((e) => e.fn.id === keep);
    selected = idx >= 0 ? idx : Math.min(selected, Math.max(0, entries.length - 1));
    refsMode = false;
    refIdx = 0;
    status = "";
  };

  const openEditor = (file: string, line: number): void => {
    const editor = process.env.EDITOR || process.env.VISUAL || "vi";
    const arg = editor.includes("code")
      ? `-g "${file}:${line}" --wait`
      : `+${line} "${file}"`;
    out.write("\x1b[?25h\x1b[?1049l");
    process.stdin.setRawMode(false);
    spawnSync(`${editor} ${arg}`, { shell: true, stdio: "inherit", cwd: opts.cwd });
    process.stdin.setRawMode(true);
    out.write("\x1b[?1049h\x1b[?25l");
    if (opts.headIsWorktree) {
      refresh();
      status = dim("rescanned · ");
    }
  };

  const quit = (): void => {
    out.write("\x1b[?25h\x1b[?1049l");
    process.stdin.setRawMode(false);
    process.exit(0);
  };

  out.write("\x1b[?1049h\x1b[?25l");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  out.on("resize", render);

  process.stdin.on("data", (key: string) => {
    const e = entries[selected];
    const refs = e && refsMode ? refsFor(e) : [];
    if (key === "q" || key === "\x03") quit();
    else if (refsMode) {
      if (key === "\x1b[A" || key === "k") refIdx = Math.max(0, refIdx - 1);
      else if (key === "\x1b[B" || key === "j") refIdx = Math.min(refs.length - 1, refIdx + 1);
      else if (key === "\x1b[D" || key === "h" || key === "\x1b") {
        refsMode = false;
        status = "";
      } else if (key === "\r" && refs[refIdx]) {
        const idx = entries.findIndex((en) => en.fn.id === refs[refIdx].id);
        if (idx >= 0) {
          selected = idx;
          refsMode = false;
          refIdx = 0;
          status = "";
        } else {
          status = dim("unchanged in this diff — e opens it in your editor · ");
        }
      } else if (key === "e" && refs[refIdx]) {
        openEditor(refs[refIdx].file, refs[refIdx].line);
      }
    } else {
      if (key === "\x1b[A" || key === "k") selected = Math.max(0, selected - 1);
      else if (key === "\x1b[B" || key === "j") selected = Math.min(entries.length - 1, selected + 1);
      else if ((key === "\x1b[C" || key === "l") && e) {
        refsMode = true;
        refIdx = 0;
      } else if ((key === "\r" || key === " ") && e) {
        if (expanded.has(e.fn.id)) expanded.delete(e.fn.id);
        else expanded.add(e.fn.id);
      } else if (key === "e" && e) {
        const fn = e.after ?? e.fn;
        openEditor(fn.file, fn.line);
      } else if (key === "r") refresh();
      else if (key === "?") showHelp = !showHelp;
    }
    render();
  });

  render();
}
