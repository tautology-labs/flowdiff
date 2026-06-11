import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Sentinel ref meaning "the working tree as it is on disk right now". */
export const WORKTREE = "WORKTREE";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function repoRoot(cwd: string): string {
  return git(["rev-parse", "--show-toplevel"], cwd).trim();
}

export function resolveRef(ref: string, cwd: string): string {
  if (ref === WORKTREE) return WORKTREE;
  return git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd).trim();
}

const SOURCE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP_RE =
  /(^|\/)(node_modules|dist|build|out|coverage|\.next|vendor|cdk\.out|\.serverless|__generated__)(\/|$)|\.d\.ts$|\.min\.js$/;

export function listSourceFiles(ref: string, cwd: string): string[] {
  const out =
    ref === WORKTREE
      ? git(["ls-files", "--cached", "--others", "--exclude-standard"], cwd)
      : git(["ls-tree", "-r", "--name-only", ref], cwd);
  return out
    .split("\n")
    .filter((f) => f && SOURCE_RE.test(f) && !SKIP_RE.test(f));
}

export function readFileAt(ref: string, path: string, cwd: string): string | null {
  try {
    if (ref === WORKTREE) return readFileSync(join(cwd, path), "utf8");
    return git(["show", `${ref}:${path}`], cwd);
  } catch {
    return null; // file absent at this revision
  }
}
