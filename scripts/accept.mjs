#!/usr/bin/env node
/**
 * The acceptance harness (architecture §18, PRD §15.1).
 *
 *   node scripts/accept.mjs [--json] [--timeout <ms>]
 *
 * Runs every gate in the documented order — env, provenance, typecheck, build,
 * the upstream suite, the learning suite, smoke — and stops at the first red
 * step. The verdict is written to `.artifacts/accept/report.json` on **both**
 * success and failure; the process exits non-zero as soon as a step fails, and
 * never continues past it.
 *
 * The module exports `ACCEPT_STEPS` and `runAccept()` so a test can assert the
 * order, the report shape and the fail-fast rule without rebuilding the world.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * The gate, in order. Each entry names the `package.json` script it runs; the
 * array order is normative and is asserted by `test/learning/ops` so a future
 * edit cannot silently move build before typecheck or skip the upstream suite.
 */
export const ACCEPT_STEPS = Object.freeze([
  { name: "env", script: "env:check" },
  { name: "provenance", script: "provenance:check" },
  { name: "typecheck", script: "typecheck" },
  { name: "build", script: "build" },
  { name: "test:upstream", script: "test:upstream" },
  { name: "test:learning", script: "test:learning" },
  { name: "smoke", script: "smoke" },
]);

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

function parseArgs(argv) {
  const options = {
    json: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    root: REPO_ROOT,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root needs a directory");
      options.root = path.resolve(value);
      index += 1;
    } else if (argument.startsWith("--root=")) {
      options.root = path.resolve(argument.slice("--root=".length));
    } else if (argument === "--timeout") {
      const value = argv[index + 1];
      if (!value) throw new Error("--timeout needs milliseconds");
      options.timeoutMs = Number(value);
      index += 1;
    } else if (argument.startsWith("--timeout=")) {
      options.timeoutMs = Number(argument.slice("--timeout=".length));
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--") {
      continue;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout must be a positive number of milliseconds");
  }
  return options;
}

function tail(text, limit = 2_000) {
  if (typeof text !== "string") return "";
  return text.length <= limit ? text : text.slice(text.length - limit);
}

/**
 * Runs one `pnpm run <script>` gate. The child inherits the pinned interpreter
 * through the `scripts/with-node.mjs` entry every script already uses.
 */
function runPnpmStep(step, { repoRoot, timeoutMs, json }) {
  const result = spawnSync("pnpm", ["run", step.script], {
    cwd: repoRoot,
    env: process.env,
    stdio: json ? "pipe" : "inherit",
    encoding: "utf8",
    timeout: timeoutMs,
    shell: process.platform === "win32",
  });
  const ok = result.status === 0 && result.error === undefined;
  if (!ok && json) {
    process.stderr.write(
      `\naccept: ${step.name} failed\n` +
        `${tail(result.stdout ?? "")}${tail(result.stderr ?? "")}` +
        (result.error ? `\n${result.error.message}` : "") +
        "\n",
    );
  }
  return {
    ok,
    exitCode: typeof result.status === "number" ? result.status : 1,
  };
}

/**
 * Runs the gate. `runStep` is injectable so a unit test can assert ordering and
 * fail-fast behaviour without spawning pnpm.
 *
 * @param {{repoRoot?: string, json?: boolean, timeoutMs?: number,
 *          runStep?: (step: {name: string, script: string}) =>
 *            {ok: boolean, exitCode?: number} |
 *            Promise<{ok: boolean, exitCode?: number}>}} [options]
 */
export async function runAccept(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const json = options.json === true;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runStep =
    options.runStep ??
    ((step) => runPnpmStep(step, { repoRoot, timeoutMs, json }));

  const startedAt = new Date().toISOString();
  const steps = [];
  let failed = false;

  for (const step of ACCEPT_STEPS) {
    if (failed) {
      steps.push({
        name: step.name,
        script: step.script,
        skipped: true,
        ok: false,
      });
      continue;
    }
    const began = Date.now();
    let result;
    try {
      result = await runStep(step);
    } catch (error) {
      result = { ok: false, exitCode: 1, error: error.message };
    }
    steps.push({
      name: step.name,
      script: step.script,
      ok: result.ok === true,
      exitCode: result.exitCode ?? (result.ok === true ? 0 : 1),
      durationMs: Date.now() - began,
      ...(result.error ? { error: result.error } : {}),
    });
    if (result.ok !== true) failed = true;
  }

  const report = {
    ok: !failed,
    startedAt,
    finishedAt: new Date().toISOString(),
    steps,
  };

  const reportFile = path.join(repoRoot, ".artifacts", "accept", "report.json");
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  return { ...report, reportFile };
}

function printReport(report, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  for (const step of report.steps) {
    if (step.skipped) {
      process.stdout.write(`skip ${step.name}\n`);
    } else {
      process.stdout.write(
        `${step.ok ? "ok  " : "FAIL"} ${step.name}` +
          (step.ok ? "" : ` (exit ${String(step.exitCode)})`) +
          "\n",
      );
    }
  }
  process.stdout.write(
    `accept: ${report.ok ? "ok" : "failed"} — ${report.reportFile}\n`,
  );
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(
      "usage: node scripts/accept.mjs [--json] [--root <dir>] [--timeout <ms>]\n",
    );
    return 0;
  }
  const report = await runAccept({
    repoRoot: options.root,
    json: options.json,
    timeoutMs: options.timeoutMs,
  });
  printReport(report, options.json);
  return report.ok ? 0 : 1;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(process.argv[1]) ===
      fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
