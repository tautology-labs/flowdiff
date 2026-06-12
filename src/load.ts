import { listSourceFiles, readFilesAt, WORKTREE } from "./git.js";
import { buildGraph, type Graph } from "./graph.js";
import type { Root } from "./roots.js";

/**
 * Build one unified worktree graph spanning every root. With multiple roots,
 * file paths are prefixed with the root name (`app/src/x.js`) so identically
 * named files don't collide and provenance stays visible; calls resolve by
 * name across the whole set, so a service's call into a linked library
 * becomes a real edge instead of an external dead-end. A single root keeps
 * bare paths, so existing single-repo ids are unchanged.
 */
export function loadRootsGraph(roots: Root[]): Graph {
  const prefix = roots.length > 1;
  const files: { path: string; text: string }[] = [];
  for (const root of roots) {
    let paths: string[];
    try {
      paths = listSourceFiles(WORKTREE, root.dir);
    } catch {
      continue; // not a git repo — skip in v0
    }
    const texts = readFilesAt(WORKTREE, paths, root.dir);
    for (const p of paths) {
      const text = texts.get(p);
      if (text != null) files.push({ path: prefix ? `${root.name}/${p}` : p, text });
    }
  }
  return buildGraph(files);
}
