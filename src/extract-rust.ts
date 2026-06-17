import { fnHashes, type FnInfo } from "./extract.js";

/**
 * Rust extractor — hand-rolled, zero dependencies. Functions are `fn name(`;
 * methods live inside `impl Type { ... }` / `impl Trait for Type { ... }`
 * blocks, so a function's name is `Type.method` when an impl encloses it,
 * bare otherwise. Trait method *signatures* (no body, end in `;`) are
 * skipped; default methods (with a body) are kept. Calls are identifiers
 * before `(` — including `Type::assoc()` and `obj.method()` via the rightmost
 * identifier; macros (`name!(...)`) are naturally excluded by the `!`.
 *
 * Known limits (documented): generics make `<…>` depth ambiguous so it's not
 * tracked (fine — type params hold no braces); in-file `#[cfg(test)] mod
 * tests` is still parsed (file-level --no-tests can't see it).
 */

const KEYWORDS = new Set([
  "if", "else", "for", "while", "loop", "match", "return", "fn", "let",
  "mut", "move", "where", "impl", "trait", "struct", "enum", "mod", "use",
  "pub", "const", "static", "type", "as", "ref", "in", "dyn", "async",
  "await", "unsafe", "extern", "self", "Self", "super", "crate", "break",
  "continue", "println", "print", "format", "panic", "vec", "assert",
  "assert_eq", "assert_ne", "write", "writeln", "matches", "Some", "None",
  "Ok", "Err",
]);

function blankRustLiterals(text: string): string {
  const out = text.split("");
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") out[i++] = " ";
    } else if (c === "/" && text[i + 1] === "*") {
      out[i++] = " "; out[i++] = " ";
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < n) { out[i++] = " "; out[i++] = " "; }
    } else if (c === "r" && (text[i + 1] === '"' || text[i + 1] === "#")) {
      // raw string: r"..." or r#"..."# / r##"..."##
      let hashes = 0;
      let j = i + 1;
      while (text[j] === "#") { hashes++; j++; }
      if (text[j] === '"') {
        out[i] = " ";
        for (let k = i + 1; k <= j; k++) out[k] = " ";
        i = j + 1;
        const close = '"' + "#".repeat(hashes);
        while (i < n && !text.startsWith(close, i)) { if (text[i] !== "\n") out[i] = " "; i++; }
        for (let k = 0; k < close.length && i < n; k++) out[i++] = " ";
      } else {
        i++;
      }
    } else if (c === '"') {
      out[i++] = " ";
      while (i < n && text[i] !== '"') {
        if (text[i] === "\\") { out[i++] = " "; if (i < n) out[i++] = " "; continue; }
        if (text[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < n) out[i++] = " ";
    } else if (c === "'") {
      // char literal 'x' / '\n' — but lifetimes ('a) have no closing quote.
      if (text[i + 1] === "\\" && text[i + 3] === "'") { out[i] = out[i+1] = out[i+2] = out[i+3] = " "; i += 4; }
      else if (text[i + 2] === "'") { out[i] = out[i+1] = out[i+2] = " "; i += 3; }
      else i++; // lifetime, leave it
    } else {
      i++;
    }
  }
  return out.join("");
}

function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) return i; }
  }
  return text.length - 1;
}

/** Body brace after a signature, or -1 if the decl ends in `;` (no body). */
function findBodyOrSemi(text: string, from: number): number {
  let depth = 0; // () and []
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === ";" && depth === 0) return -1;
    else if (c === "{" && depth === 0) return i;
  }
  return -1;
}

interface ImplRange { type: string; start: number; end: number; }

const IMPL_RE = /\bimpl\b(?:\s*<[^>]*>)?\s+([^{]+?)\{/g;
const TRAIT_RE = /\btrait\s+([A-Za-z_]\w*)/g;
const FN_RE = /\bfn\s+([A-Za-z_]\w*)/g;
const CALL_RE = /([A-Za-z_]\w*)\s*\(/g;

/** `impl X` -> X; `impl Trait for X` -> X; strip generics/paths. */
function implType(header: string): string | null {
  const forMatch = /\bfor\s+([A-Za-z_][\w:]*)/.exec(header);
  const raw = forMatch ? forMatch[1] : header.trim();
  const m = /([A-Za-z_]\w*)\s*(?:<.*)?$/.exec(raw.split(/\s/)[0] ?? raw);
  return m ? m[1].split("::").pop()! : null;
}

export function extractRustFunctions(path: string, text: string): FnInfo[] {
  const clean = blankRustLiterals(text);
  const lineAt = (idx: number) => {
    let line = 1;
    for (let i = 0; i < idx && i < clean.length; i++) if (clean[i] === "\n") line++;
    return line;
  };

  // Map impl blocks to their type and brace range, so each fn can find its
  // innermost enclosing impl.
  const impls: ImplRange[] = [];
  IMPL_RE.lastIndex = 0;
  let im: RegExpExecArray | null;
  while ((im = IMPL_RE.exec(clean)) !== null) {
    const braceIdx = clean.indexOf("{", im.index + 4);
    if (braceIdx === -1) continue;
    const type = implType(im[1]);
    if (type) impls.push({ type, start: braceIdx, end: matchBrace(clean, braceIdx) });
  }
  // Trait blocks enclose their default methods (fn with a body).
  TRAIT_RE.lastIndex = 0;
  let tm: RegExpExecArray | null;
  while ((tm = TRAIT_RE.exec(clean)) !== null) {
    const braceIdx = clean.indexOf("{", tm.index);
    if (braceIdx === -1) continue;
    impls.push({ type: tm[1], start: braceIdx, end: matchBrace(clean, braceIdx) });
  }
  const enclosingImpl = (idx: number): string | null => {
    let best: ImplRange | null = null;
    for (const r of impls) {
      if (idx > r.start && idx < r.end && (!best || r.start > best.start)) best = r;
    }
    return best ? best.type : null;
  };

  const fns: FnInfo[] = [];
  FN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FN_RE.exec(clean)) !== null) {
    const bare = m[1];
    const afterName = m.index + m[0].length;
    const paren = clean.indexOf("(", afterName);
    if (paren === -1) continue;
    const bodyStart = findBodyOrSemi(clean, paren);
    if (bodyStart === -1) continue; // trait method signature / fn pointer type
    const bodyEnd = matchBrace(clean, bodyStart);

    const type = enclosingImpl(m.index);
    const name = type ? `${type}.${bare}` : bare;
    const source = text.slice(m.index, bodyEnd + 1);

    const calls: string[] = [];
    const body = clean.slice(bodyStart, bodyEnd + 1);
    CALL_RE.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = CALL_RE.exec(body)) !== null) {
      if (!KEYWORDS.has(cm[1])) calls.push(cm[1]);
    }

    fns.push({
      id: `${path}#${name}`,
      file: path,
      name,
      line: lineAt(m.index),
      source,
      ...fnHashes(source, name),
      calls,
      params: new Set(),
    });
  }

  return fns;
}
