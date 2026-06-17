import type { FnInfo } from "./extract.js";
import { extractFunctions } from "./extract.js";
import { extractJavaFunctions } from "./extract-java.js";
import { extractPythonFunctions } from "./extract-python.js";
import { extractGoFunctions } from "./extract-go.js";
import { extractRustFunctions } from "./extract-rust.js";

/** Route a file to its language extractor. Everything downstream of this —
 * graph, diff, rename detection, TUI, MCP — is language-agnostic. */
export function extractAny(path: string, text: string): FnInfo[] {
  if (path.endsWith(".java")) return extractJavaFunctions(path, text);
  if (path.endsWith(".py")) return extractPythonFunctions(path, text);
  if (path.endsWith(".go")) return extractGoFunctions(path, text);
  if (path.endsWith(".rs")) return extractRustFunctions(path, text);
  if (path.endsWith(".ipynb")) return extractPythonFunctions(path, notebookToPython(text));
  return extractFunctions(path, text);
}

/**
 * A notebook is JSON wrapping Python: concatenate the code cells (markdown
 * skipped, IPython magics/shell lines blanked) and reuse the Python
 * extractor. Line numbers refer to the concatenated code, not cell offsets.
 */
export function notebookToPython(text: string): string {
  let nb: { cells?: { cell_type: string; source: string[] | string }[] };
  try {
    nb = JSON.parse(text);
  } catch {
    return "";
  }
  const chunks: string[] = [];
  for (const cell of nb.cells ?? []) {
    if (cell.cell_type !== "code") continue;
    const src = Array.isArray(cell.source) ? cell.source.join("") : (cell.source ?? "");
    chunks.push(
      src
        .split("\n")
        .map((line) => (/^\s*[%!]/.test(line) ? "" : line))
        .join("\n"),
    );
  }
  return chunks.join("\n\n");
}
