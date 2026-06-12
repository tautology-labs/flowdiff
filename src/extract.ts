import ts from "typescript";
import { createHash } from "node:crypto";

export interface FnInfo {
  /** Stable id: `path#name` (suffixed `#2`, `#3`… on collision). */
  id: string;
  file: string;
  /** Bare name, or `Class.method` for methods/class fields. */
  name: string;
  line: number;
  source: string;
  /** Hash of whitespace-normalized source — used to detect body changes. */
  bodyHash: string;
  /**
   * Like bodyHash, but with the function's own name masked out — two
   * functions with equal renameHash are the same code under different names.
   */
  renameHash: string;
  /** Callee names appearing in the body (rightmost identifier of the call). */
  calls: string[];
  /** Parameter names — calls to these are callback invocations, not edges. */
  params: Set<string>;
}

/** Body + name-blinded hashes — shared by every language extractor. */
export function fnHashes(
  source: string,
  name: string,
): { bodyHash: string; renameHash: string } {
  const hash = (s: string) =>
    createHash("sha1").update(s.replace(/\s+/g, " ")).digest("hex").slice(0, 12);
  const base = name.split(".").pop()!;
  const blinded = source.replace(new RegExp(`\\b${base}\\b`, "g"), "·");
  return { bodyHash: hash(source), renameHash: hash(blinded) };
}

function classPrefix(node: ts.Node): string {
  const parent = node.parent;
  if (
    parent &&
    (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) &&
    parent.name
  ) {
    return parent.name.text + ".";
  }
  return "";
}

/**
 * Extract named functions and the calls made inside them from one file.
 * Calls inside anonymous closures are attributed to the nearest enclosing
 * named function, which is what a reviewer means by "this function calls X".
 */
export function extractFunctions(path: string, text: string): FnInfo[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const fns: FnInfo[] = [];
  const stack: FnInfo[] = [];

  const paramNames = (node: ts.Node): Set<string> => {
    const names = new Set<string>();
    const fnLike =
      ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)
        ? node.initializer
        : node;
    if (fnLike && ts.isFunctionLike(fnLike)) {
      for (const p of fnLike.parameters) {
        if (ts.isIdentifier(p.name)) names.add(p.name.text);
      }
    }
    return names;
  };

  const enter = (name: string, node: ts.Node): FnInfo => {
    const source = node.getText(sf);
    const fn: FnInfo = {
      id: `${path}#${name}`,
      file: path,
      name,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      source,
      ...fnHashes(source, name),
      calls: [],
      params: paramNames(node),
    };
    fns.push(fn);
    stack.push(fn);
    return fn;
  };

  const calleeName = (expr: ts.Expression): string | null => {
    if (ts.isIdentifier(expr)) return expr.text;
    if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
    return null;
  };

  const visit = (node: ts.Node): void => {
    let entered = false;

    if (ts.isFunctionDeclaration(node) && node.name) {
      enter(node.name.text, node);
      entered = true;
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      enter(classPrefix(node) + node.name.text, node);
      entered = true;
    } else if (ts.isConstructorDeclaration(node)) {
      enter(classPrefix(node) + "constructor", node);
      entered = true;
    } else if (
      (ts.isGetAccessor(node) || ts.isSetAccessor(node)) &&
      ts.isIdentifier(node.name)
    ) {
      enter(classPrefix(node) + node.name.text, node);
      entered = true;
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
    ) {
      enter(node.name.text, node);
      entered = true;
    } else if (
      ts.isPropertyDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isArrowFunction(node.initializer)
    ) {
      enter(classPrefix(node) + node.name.text, node);
      entered = true;
    } else if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression);
      const current = stack[stack.length - 1];
      if (callee && current && !current.params.has(callee)) {
        current.calls.push(callee);
      }
    }

    ts.forEachChild(node, visit);
    if (entered) stack.pop();
  };

  visit(sf);
  return fns;
}
