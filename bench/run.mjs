#!/usr/bin/env node
/**
 * A/B harness: does call-graph traversal (the flowdiff MCP tools) change how
 * well an agent fixes bugs whose cause is several hops from the symptom?
 *
 * For each task and condition: copy the fixture repo to a temp dir, git init,
 * run headless `claude -p` on the bug report (the flowdiff condition gets the
 * MCP server and one steering sentence), then copy in the held-out tests the
 * agent never saw and grade with `node --test`. Agents generate, scripts grade.
 *
 * Usage: node bench/run.mjs [--task <name>] [--cond control|flowdiff|both]
 *                           [--timeout <seconds per agent run>]
 */
import { execSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const benchDir = dirname(fileURLToPath(import.meta.url));
const mcpServer = join(benchDir, "..", "dist", "mcp.js");

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const onlyTask = opt("task", null);
const condArg = opt("cond", "both");
const conditions = condArg === "both" ? ["control", "flowdiff"] : [condArg];
const timeoutMs = Number(opt("timeout", "600")) * 1000;

const STEER =
  "\n\nYou have flowdiff MCP tools (find_functions, function_info, flow_diff, function_diff) that serve this repo's call graph; prefer them over reading whole files when following code paths.";

const taskNames = readdirSync(join(benchDir, "tasks")).filter(
  (n) => !n.startsWith("."),
);
const results = [];

for (const taskName of taskNames) {
  if (onlyTask && taskName !== onlyTask) continue;
  const taskDir = join(benchDir, "tasks", taskName);
  const prompt = readFileSync(join(taskDir, "task.md"), "utf8");

  // Two task kinds: `repo/` fixture dirs, or task.json pointing at a real
  // repo + sha with a bug.patch to plant and holdout test paths to withhold.
  const specPath = join(taskDir, "task.json");
  const spec = existsSync(specPath)
    ? JSON.parse(readFileSync(specPath, "utf8"))
    : null;
  const cacheDir = spec ? join(benchDir, "cache", taskName) : null;
  if (spec && !existsSync(cacheDir)) {
    console.error(`▸ caching ${spec.repo} @ ${spec.sha.slice(0, 8)} (one-time)`);
    execSync(`git clone --quiet ${spec.repo} ${cacheDir}`, { stdio: "ignore" });
    execSync(`git checkout --quiet ${spec.sha}`, { cwd: cacheDir, stdio: "ignore" });
    execSync(spec.install, { cwd: cacheDir, stdio: "ignore" });
  }

  for (const cond of conditions) {
    const work = mkdtempSync(join(tmpdir(), `bench-${taskName}-${cond}-`));
    const proj = join(work, "repo");
    if (spec) {
      cpSync(cacheDir, proj, { recursive: true });
      execSync(`git apply ${join(taskDir, spec.bugPatch)}`, {
        cwd: proj,
        stdio: "ignore",
      });
      for (const h of spec.holdout) rmSync(join(proj, h));
      // Replace the clone's history with one innocent commit, so the planted
      // bug and withheld tests aren't readable straight out of `git show`.
      rmSync(join(proj, ".git"), { recursive: true, force: true });
    } else {
      cpSync(join(taskDir, "repo"), proj, { recursive: true });
    }
    execSync(
      "git init -qb main && git add -A && git -c user.name=bench -c user.email=bench@bench commit -qm import",
      { cwd: proj, stdio: "ignore" },
    );

    const cliArgs = [
      "-p",
      cond === "flowdiff" ? prompt + STEER : prompt,
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      "--strict-mcp-config",
    ];
    if (cond === "flowdiff") {
      const cfg = join(work, "mcp.bench.json");
      writeFileSync(
        cfg,
        JSON.stringify({
          mcpServers: {
            flowdiff: { type: "stdio", command: "node", args: [mcpServer] },
          },
        }),
      );
      cliArgs.push("--mcp-config", cfg);
    }

    console.error(`▶ ${taskName} / ${cond}`);
    const t0 = Date.now();
    const agent = spawnSync("claude", cliArgs, {
      cwd: proj,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    let meta = {};
    try {
      meta = JSON.parse(agent.stdout);
    } catch {
      // timeout or crash — grade anyway; an unfixed repo just fails
    }

    let graded;
    if (spec) {
      for (const h of spec.holdout) cpSync(join(cacheDir, h), join(proj, h));
      graded = spawnSync("sh", ["-c", spec.gradeCmd], {
        cwd: proj,
        encoding: "utf8",
        timeout: 300_000,
      });
    } else {
      cpSync(join(taskDir, "holdout.test.js"), join(proj, "holdout.test.js"));
      graded = spawnSync("node", ["--test", "holdout.test.js"], {
        cwd: proj,
        encoding: "utf8",
        timeout: 60_000,
      });
    }
    const pass = graded.status === 0;

    results.push({
      task: taskName,
      cond,
      pass,
      cost_usd: meta.total_cost_usd ?? null,
      turns: meta.num_turns ?? null,
      wall_s: Math.round((Date.now() - t0) / 1000),
      agent_said: (meta.result ?? "").slice(0, 500),
      workdir: proj,
    });
    console.error(
      `  ${pass ? "PASS" : "FAIL"} · $${meta.total_cost_usd?.toFixed?.(2) ?? "?"} · ${meta.num_turns ?? "?"} turns · ${Math.round((Date.now() - t0) / 1000)}s`,
    );
  }
}

const outDir = join(benchDir, "results");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(join(outDir, `run-${stamp}.json`), JSON.stringify(results, null, 2));
console.log(
  JSON.stringify(
    results.map(({ agent_said, workdir, ...row }) => row),
    null,
    2,
  ),
);
