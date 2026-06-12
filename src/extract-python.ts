import { fnHashes, type FnInfo } from "./extract.js";

/**
 * Python extractor — hand-rolled, zero dependencies. Python's syntax makes
 * this honest: functions are `def name(` at an indent level, scope ends when
 * indentation falls back (while outside brackets), and calls are
 * `identifier(`. Known limits, accepted for v0: dynamic dispatch
 * (getattr/exec) is invisible, lambdas aren't nodes, and notebooks aren't
 * parsed. The upgrade path is tree-sitter via WASM if this needs to be
 * production-grade.
 */

const KEYWORDS = new Set([
  "if", "elif", "while", "for", "return", "with", "assert", "del", "raise",
  "yield", "await", "not", "and", "or", "in", "is", "lambda", "except",
  "class", "def", "match", "case", "else", "try", "finally", "import",
  "from", "as", "pass", "break", "continue", "global", "nonlocal", "print",
]);

/**
 * Blank out comments and string literals (preserving newlines and offsets)
 * so indentation scoping and call detection never fire inside them.
 */
export function blankStringsAndComments(text: string): string {
  const out = text.split("");
  let i = 0;
  const n = text.length;
  let mode: null | { quote: string; triple: boolean } = null;

  while (i < n) {
    const c = text[i];
    if (mode) {
      const q = mode.quote;
      const end = mode.triple
        ? text.startsWith(q.repeat(3), i)
        : c === q && text[i - 1] !== "\\";
      if (mode.triple && end) {
        out[i] = out[i + 1] = out[i + 2] = " ";
        i += 3;
        mode = null;
        continue;
      }
      if (!mode.triple && (end || c === "\n")) {
        if (c !== "\n") out[i] = " ";
        mode = null;
        i++;
        continue;
      }
      if (c !== "\n") out[i] = " ";
      i++;
      continue;
    }
    if (c === "#") {
      while (i < n && text[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i);
      for (let k = 0; k < (triple ? 3 : 1); k++) out[i + k] = " ";
      mode = { quote: c, triple };
      i += triple ? 3 : 1;
      continue;
    }
    i++;
  }
  return out.join("");
}

interface Scope {
  kind: "class" | "def";
  name: string;
  indent: number;
  startLine: number; // 1-based, includes decorators
  startOffset: number;
  fn: FnInfo | null; // null for classes
}

const DEF_RE = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const CLASS_RE = /^(\s*)class\s+([A-Za-z_]\w*)/;
const CALL_RE = /([A-Za-z_]\w*)\s*\(/g;

function paramsOf(signature: string): Set<string> {
  const open = signature.indexOf("(");
  const close = signature.lastIndexOf(")");
  const inner = close > open ? signature.slice(open + 1, close) : "";
  const params = new Set<string>();
  for (const part of inner.split(",")) {
    const m = /^\s*\*{0,2}([A-Za-z_]\w*)/.exec(part);
    if (m) params.add(m[1]);
  }
  return params;
}

export function extractPythonFunctions(path: string, text: string): FnInfo[] {
  const clean = blankStringsAndComments(text);
  const lines = clean.split("\n");
  const rawLines = text.split("\n");

  const fns: FnInfo[] = [];
  const stack: Scope[] = [];
  let bracketDepth = 0;
  let offset = 0;
  let pendingDecoratorStart: { line: number; offset: number } | null = null;

  const close = (scope: Scope, endLineExclusive: number) => {
    if (!scope.fn) return;
    let end = endLineExclusive;
    while (end > scope.startLine && rawLines[end - 1].trim() === "") end--;
    const source = rawLines.slice(scope.startLine - 1, end).join("\n");
    Object.assign(scope.fn, fnHashes(source, scope.fn.name));
    scope.fn.source = source;
    scope.fn.calls = scope.fn.calls.filter((c) => !scope.fn!.params.has(c));
    fns.push(scope.fn);
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const lineNo = li + 1;
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    // Scope closing only counts at bracket depth 0 — a continuation line
    // inside an open call can sit at any indentation.
    if (bracketDepth === 0 && trimmed !== "") {
      while (
        stack.length > 0 &&
        indent <= stack[stack.length - 1].indent &&
        !(pendingDecoratorStart && trimmed.startsWith("@"))
      ) {
        close(stack.pop()!, lineNo - 1);
      }
    }

    if (bracketDepth === 0 && trimmed.startsWith("@") && !pendingDecoratorStart) {
      pendingDecoratorStart = { line: lineNo, offset };
    }

    const defMatch = bracketDepth === 0 ? DEF_RE.exec(line) : null;
    const classMatch = bracketDepth === 0 && !defMatch ? CLASS_RE.exec(line) : null;

    if (defMatch) {
      const enclosingClass = [...stack].reverse().find((s) => s.kind === "class");
      const insideDef = stack.some((s) => s.kind === "def");
      const name =
        enclosingClass && !insideDef
          ? `${enclosingClass.name}.${defMatch[2]}`
          : defMatch[2];
      // Signature may span lines; grab until the bracket balance closes.
      let sig = line;
      for (let j = li + 1, depth = balance(line); depth > 0 && j < lines.length; j++) {
        sig += lines[j];
        depth += balance(lines[j]);
      }
      const start = pendingDecoratorStart ?? { line: lineNo, offset };
      stack.push({
        kind: "def",
        name,
        indent,
        startLine: start.line,
        startOffset: start.offset,
        fn: {
          id: `${path}#${name}`,
          file: path,
          name,
          line: start.line,
          source: "",
          bodyHash: "",
          renameHash: "",
          calls: [],
          params: paramsOf(sig),
        },
      });
      pendingDecoratorStart = null;
    } else if (classMatch) {
      stack.push({
        kind: "class",
        name: classMatch[2],
        indent,
        startLine: pendingDecoratorStart?.line ?? lineNo,
        startOffset: pendingDecoratorStart?.offset ?? offset,
        fn: null,
      });
      pendingDecoratorStart = null;
    } else if (trimmed !== "" && !trimmed.startsWith("@")) {
      pendingDecoratorStart = null;
    }

    // Calls attribute to the innermost enclosing def.
    const owner = [...stack].reverse().find((s) => s.kind === "def");
    if (owner?.fn && !defMatch) {
      for (const m of line.matchAll(CALL_RE)) {
        if (!KEYWORDS.has(m[1])) owner.fn.calls.push(m[1]);
      }
    }

    bracketDepth = Math.max(0, bracketDepth + balance(line));
    offset += line.length + 1;
  }
  while (stack.length > 0) close(stack.pop()!, lines.length);

  return fns;
}

function balance(line: string): number {
  let depth = 0;
  for (const ch of line) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
  }
  return depth;
}
