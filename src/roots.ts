import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

export interface Root {
  /** Short label used to prefix file paths in the unified graph. */
  name: string;
  dir: string;
}

const LOCAL_DEP = /^(file|link|workspace):/;

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The primary directory plus any locally-linked sibling repos — the services
 * a feature actually spans. Found two ways: package.json `file:`/`link:`/
 * `workspace:` dependencies, and symlinks under node_modules (npm/yarn link,
 * file: installs). Plain registry dependencies are never followed, so this
 * doesn't drag in the whole node_modules tree. One level deep, deduped by
 * real path; the primary always comes first.
 */
export function discoverRoots(primaryDir: string): Root[] {
  const primary = realpathSync(primaryDir);
  const byPath = new Map<string, Root>();
  const usedNames = new Set<string>();

  const add = (rawName: string, dir: string): void => {
    if (!existsSync(dir)) return;
    const real = realpathSync(dir);
    if (byPath.has(real)) return;
    let name = rawName;
    for (let n = 2; usedNames.has(name); n++) name = `${rawName}-${n}`;
    usedNames.add(name);
    byPath.set(real, { name, dir: real });
  };

  add(basename(primary), primary);

  // 1. Local dependencies declared in package.json.
  const pkg = readJson(join(primary, "package.json"));
  const deps = {
    ...((pkg?.dependencies as Record<string, string>) ?? {}),
    ...((pkg?.devDependencies as Record<string, string>) ?? {}),
  };
  for (const [, spec] of Object.entries(deps)) {
    if (typeof spec === "string" && LOCAL_DEP.test(spec)) {
      const target = resolve(primary, spec.replace(LOCAL_DEP, ""));
      add(basename(target), target);
    }
  }

  // 2. Symlinks under node_modules pointing outside any node_modules tree.
  const nm = join(primary, "node_modules");
  if (existsSync(nm)) {
    for (const entry of readdirSync(nm)) {
      if (entry.startsWith(".")) continue;
      const names = entry.startsWith("@")
        ? readdirSync(join(nm, entry)).map((s) => join(entry, s))
        : [entry];
      for (const rel of names) {
        const p = join(nm, rel);
        try {
          if (!lstatSync(p).isSymbolicLink()) continue;
          const target = realpathSync(p);
          if (!target.split("/").includes("node_modules")) {
            add(basename(target), target);
          }
        } catch {
          // dangling link — skip
        }
      }
    }
  }

  return [...byPath.values()];
}
