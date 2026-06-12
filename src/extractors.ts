import type { FnInfo } from "./extract.js";
import { extractFunctions } from "./extract.js";
import { extractJavaFunctions } from "./extract-java.js";
import { extractPythonFunctions } from "./extract-python.js";

/** Route a file to its language extractor. Everything downstream of this —
 * graph, diff, rename detection, TUI, MCP — is language-agnostic. */
export function extractAny(path: string, text: string): FnInfo[] {
  if (path.endsWith(".java")) return extractJavaFunctions(path, text);
  if (path.endsWith(".py")) return extractPythonFunctions(path, text);
  return extractFunctions(path, text);
}
