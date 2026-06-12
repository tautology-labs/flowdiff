import { parse } from "java-parser";
import { fnHashes, type FnInfo } from "./extract.js";

/**
 * Java extractor over java-parser's Chevrotain CST. Same contract as the
 * TypeScript extractor: named functions (methods, constructors) with the
 * calls made inside them. Methods are `Class.method`, constructors
 * `Class.constructor`, matching the TS naming so the rest of the pipeline
 * (graph, diff, rename detection, MCP) is untouched.
 */

interface CstToken {
  image: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
}

interface CstNode {
  name: string;
  children: Record<string, (CstNode | CstToken)[]>;
  location?: { startOffset: number; endOffset: number; startLine: number };
}

const isToken = (n: CstNode | CstToken): n is CstToken =>
  (n as CstToken).image !== undefined;

function offsetOf(n: CstNode | CstToken): number {
  return isToken(n) ? n.startOffset : (n.location?.startOffset ?? 0);
}

/** All children of a node, in source order. */
function kids(node: CstNode): (CstNode | CstToken)[] {
  const all: (CstNode | CstToken)[] = [];
  for (const key of Object.keys(node.children)) all.push(...node.children[key]);
  return all.sort((a, b) => offsetOf(a) - offsetOf(b));
}

function walk(node: CstNode, visit: (n: CstNode) => boolean | void): void {
  // visit returns false to stop descending into this subtree
  if (visit(node) === false) return;
  for (const child of kids(node)) {
    if (!isToken(child)) walk(child, visit);
  }
}

function findFirst(node: CstNode, name: string): CstNode | null {
  let found: CstNode | null = null;
  walk(node, (n) => {
    if (found) return false;
    if (n.name === name) {
      found = n;
      return false;
    }
  });
  return found;
}

function firstIdentifier(node: CstNode | null): CstToken | null {
  if (!node) return null;
  let found: CstToken | null = null;
  walk(node, (n) => {
    if (found) return false;
    const ids = n.children.Identifier as CstToken[] | undefined;
    if (ids?.[0]) {
      found = ids[0];
      return false;
    }
  });
  return found;
}

/**
 * Collect callee names inside a method body. Each `primary` chain flattens
 * to tokens in source order with invocation markers; a call's callee is the
 * identifier immediately before its marker (`this.bar(…)` → bar,
 * `chain().next()` → chain and next, `new Helper(z).run()` → run).
 */
function collectCalls(node: CstNode, out: string[]): void {
  walk(node, (n) => {
    if (n.name === "primary") {
      const seq: ({ id: string } | { invoke: true })[] = [];
      flattenPrimary(n, seq);
      for (let i = 1; i < seq.length; i++) {
        const here = seq[i];
        const prev = seq[i - 1];
        if ("invoke" in here && "id" in prev) out.push(prev.id);
      }
      // nested primaries inside argument lists are visited on their own,
      // because flattenPrimary doesn't descend into invocation suffixes.
    }
  });
}

function flattenPrimary(
  node: CstNode,
  seq: ({ id: string } | { invoke: true })[],
): void {
  for (const child of kids(node)) {
    if (isToken(child)) {
      if (/^[A-Za-z_$][\w$]*$/.test(child.image)) seq.push({ id: child.image });
      continue;
    }
    if (child.name === "methodInvocationSuffix") {
      seq.push({ invoke: true });
      continue; // arguments are their own primary nodes — don't double-walk
    }
    flattenPrimary(child, seq);
  }
}

function paramNames(declarator: CstNode | null): Set<string> {
  const params = new Set<string>();
  if (!declarator) return params;
  walk(declarator, (n) => {
    if (n.name === "variableDeclaratorId") {
      const id = firstIdentifier(n);
      if (id) params.add(id.image);
    }
  });
  return params;
}

const TYPE_DECLS = new Set([
  "normalClassDeclaration",
  "normalInterfaceDeclaration",
  "enumDeclaration",
  "recordDeclaration",
]);

export function extractJavaFunctions(path: string, text: string): FnInfo[] {
  let cst: CstNode;
  try {
    cst = parse(text) as unknown as CstNode;
  } catch {
    return []; // unparseable file — contribute nothing rather than crash
  }

  const fns: FnInfo[] = [];

  const enter = (name: string, node: CstNode, declarator: CstNode | null) => {
    const loc = node.location;
    if (!loc) return;
    const source = text.slice(loc.startOffset, loc.endOffset + 1);
    const fn: FnInfo = {
      id: `${path}#${name}`,
      file: path,
      name,
      line: loc.startLine,
      source,
      ...fnHashes(source, name),
      calls: [],
      params: paramNames(declarator),
    };
    // Attribute calls to this member only — nested type members own theirs.
    walk(node, (n) => {
      if (n !== node && (n.name === "methodDeclaration" || n.name === "constructorDeclaration")) {
        return false;
      }
      if (n.name === "primary") {
        collectCalls(n, fn.calls);
        return false;
      }
    });
    fn.calls = fn.calls.filter((c) => !fn.params.has(c));
    fns.push(fn);
  };

  const visitType = (typeNode: CstNode, className: string): void => {
    walk(typeNode, (n) => {
      if (n !== typeNode && TYPE_DECLS.has(n.name)) {
        const nested = firstIdentifier(findFirst(n, "typeIdentifier"));
        if (nested) visitType(n, nested.image);
        return false;
      }
      if (n.name === "methodDeclaration") {
        const declarator = findFirst(n, "methodDeclarator");
        const nameTok = (declarator?.children.Identifier as CstToken[] | undefined)?.[0];
        if (nameTok) enter(`${className}.${nameTok.image}`, n, declarator);
        return false;
      }
      if (n.name === "constructorDeclaration") {
        enter(`${className}.constructor`, n, findFirst(n, "constructorDeclarator"));
        return false;
      }
    });
  };

  walk(cst, (n) => {
    if (TYPE_DECLS.has(n.name)) {
      const id = firstIdentifier(findFirst(n, "typeIdentifier"));
      if (id) visitType(n, id.image);
      return false;
    }
  });

  return fns;
}
