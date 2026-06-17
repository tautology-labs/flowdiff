import { execFileSync, spawnSync } from "node:child_process";
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

const SOURCE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|java|py|ipynb|go|rs)$/;
const SKIP_RE =
  /(^|\/)(node_modules|dist|build|out|coverage|\.next|vendor|cdk\.out|\.serverless|__generated__|target|\.gradle|generated-sources|__pycache__|\.venv|venv|\.tox|site-packages|\.eggs|\.ipynb_checkpoints)(\/|$)|\.d\.ts$|\.min\.js$/;

export function isSourcePath(path: string): boolean {
  return SOURCE_RE.test(path) && !SKIP_RE.test(path);
}

/**
 * Test files by per-language convention. File-level only — Rust's in-file
 * `#[cfg(test)] mod tests` and Python doctests aren't caught (would need
 * module-level filtering).
 */
export function isTestPath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  if (/(^|\/)(tests?|__tests__|testdata|test)(\/)/.test(path)) return true;
  if (/(^|\/)src\/test\//.test(path)) return true; // Maven/Gradle layout
  if (/\.(test|spec)\.(tsx?|jsx?|mts|cts|mjs|cjs)$/.test(base)) return true;
  if (/\.test-d\.ts$/.test(base)) return true;
  if (/_test\.go$/.test(base)) return true;
  if (/^test_.*\.py$/.test(base) || /_test\.py$/.test(base) || base === "conftest.py") return true;
  if (/(Test|Tests|IT|ITCase)\.java$/.test(base)) return true;
  return false;
}

export function listSourceFiles(ref: string, cwd: string, includeTests = true): string[] {
  const out =
    ref === WORKTREE
      ? git(["ls-files", "--cached", "--others", "--exclude-standard"], cwd)
      : git(["ls-tree", "-r", "--name-only", ref], cwd);
  return out
    .split("\n")
    .filter((f) => f && isSourcePath(f) && (includeTests || !isTestPath(f)));
}

export function readFileAt(ref: string, path: string, cwd: string): string | null {
  try {
    if (ref === WORKTREE) return readFileSync(join(cwd, path), "utf8");
    return git(["show", `${ref}:${path}`], cwd);
  } catch {
    return null; // file absent at this revision
  }
}

/**
 * Read many files at one revision through a single `git cat-file --batch`
 * process — one subprocess per graph build instead of one per file.
 * Worktree reads stay plain fs reads. Absent files map to null.
 */
export function readFilesAt(
  ref: string,
  paths: string[],
  cwd: string,
): Map<string, string | null> {
  const texts = new Map<string, string | null>();
  if (ref === WORKTREE) {
    for (const path of paths) texts.set(path, readFileAt(ref, path, cwd));
    return texts;
  }

  // --batch requests are newline-delimited, so a path containing a newline
  // can't be asked for; treat it as absent rather than corrupting the stream.
  const requested = paths.filter((path) => {
    if (path.includes("\n")) {
      texts.set(path, null);
      return false;
    }
    return true;
  });
  if (requested.length === 0) return texts;

  const res = spawnSync("git", ["cat-file", "--batch"], {
    cwd,
    input: requested.map((path) => `${ref}:${path}\n`).join(""),
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`git cat-file --batch failed: ${res.stderr?.toString() ?? ""}`);
  }

  // Responses arrive in request order: `<sha> <type> <size>\n<content>\n`,
  // or a single `<request> missing\n` line. Sizes are bytes, so parse over
  // the raw buffer and decode each content slice on its own.
  const out = res.stdout;
  let off = 0;
  for (const path of requested) {
    const nl = out.indexOf(0x0a, off);
    if (nl === -1) {
      texts.set(path, null); // truncated output — treat the rest as absent
      continue;
    }
    const header = out.subarray(off, nl).toString("utf8").split(" ");
    off = nl + 1;
    const size = Number(header[2]);
    if (header.length !== 3 || !Number.isFinite(size)) {
      texts.set(path, null); // "missing" / "ambiguous" — no content follows
      continue;
    }
    texts.set(path, out.subarray(off, off + size).toString("utf8"));
    off += size + 1; // content plus its trailing newline
  }
  return texts;
}
