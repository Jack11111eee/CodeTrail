#!/usr/bin/env node
/**
 * Acceptance smoke test (architecture §18, AC-OPS-01, AC-OPS-02).
 *
 *   node scripts/smoke.mjs [--json] [--built] [--timeout <ms>]
 *
 * Boots the learning server on a **temporary data directory** and an ephemeral
 * loopback port, then asserts the four security surfaces and the UI:
 *
 *   loopback_bind   the printed URL is `http://127.0.0.1:<port>`
 *   host_check      `Host: evil.example` → 403 `forbidden_origin`
 *   auth_required   an API read without a session cookie → 401 `unauthorized`
 *   projects_page   `GET /` renders `data-testid="project-list"`
 *   health          `GET /api/health` → 200 `{status:"ok"}`
 *
 * With `--built` the same child is the built entry (`dist/learning/api/cli.js`),
 * the four build artifacts are asserted, and the check list additionally carries
 * `built_entry_started`, `url_printed_loopback` and `sigterm_exit_zero` (the
 * drain exits with a literal 0 after SIGTERM).
 *
 * The child is killed in `finally` on every path, so a failing check never
 * leaves a survivor. Exit code is the verdict: 0 only when every check is ok.
 *
 * The module also exports `runSmoke()` so a test can drive it directly; the
 * CLI wrapper only runs when this file is the process entry point.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Artifacts the built entry needs before `--built` is meaningful. */
export const BUILT_ARTIFACTS = Object.freeze([
  "dist/cli/cli.js",
  "dist/visualize/client.js",
  "dist/learning/api/cli.js",
  "dist/visualize/styles.css",
]);

const DEFAULT_TIMEOUT_MS = 30_000;

function parseArgs(argv) {
  const options = {
    json: false,
    built: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--built") options.built = true;
    else if (argument === "--timeout") {
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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** A fresh directory the child owns; removed by the caller. */
function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-smoke-"));
}

/** One HTTP exchange against the loopback listener; never follows redirects. */
function request({ port, path: requestPath, method = "GET", headers = {} }) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method,
        headers: requestHeaders,
        timeout: 10_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {
            // A non-JSON body (HTML, empty) is represented as null.
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json,
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end();
  });
}

function errorCodeOf(response) {
  const body = response.json;
  return body && typeof body === "object" && body.error
    ? body.error.code
    : null;
}

/**
 * Spawns the server and resolves once it prints its loopback URL.
 *
 * @returns {Promise<{child: import("node:child_process").ChildProcess, url: string|null, port: number|null, stderr: string, exited: Promise<void>}>}
 */
async function startServer({ built, dataDir, timeoutMs }) {
  const entry = built
    ? path.join(REPO_ROOT, "dist", "learning", "api", "cli.js")
    : path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const entryArgs = built
    ? [entry]
    : [entry, path.join(REPO_ROOT, "src", "learning", "api", "cli.ts")];

  const child = spawn(process.execPath, entryArgs, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CODETRAIL_DATA_DIR: dataDir,
      CODETRAIL_PORT: "0",
      OPENWIKI_TELEMETRY_DISABLED: "1",
      DO_NOT_TRACK: "1",
      LANGCHAIN_TRACING_V2: "false",
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let exitCode = null;
  let signalCode = null;
  let url = null;
  let settled = false;

  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exitCode = code;
      signalCode = signal;
      settled = true;
      resolve();
    });
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = /^http:\/\/127\.0\.0\.1:(\d+)\s*$/mu.exec(stdout);
    if (match) {
      url = match[0].trim();
      break;
    }
    if (settled) break;
    await sleep(50);
  }

  return {
    child,
    url,
    port: url === null ? null : Number(new URL(url).port),
    stderr,
    exitCode: () => exitCode,
    signalCode: () => signalCode,
    exited,
  };
}

/** Terminates the child and waits; escalates to SIGKILL after a grace period. */
async function stopServer(handle) {
  if (handle === null) return;
  const { child, exited } = handle;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([exited, sleep(5_000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([exited, sleep(2_000)]);
    }
  }
}

/**
 * Runs the smoke verdict.
 *
 * @param {{built?: boolean, timeoutMs?: number, repoRoot?: string}} [options]
 * @returns {Promise<{ok: boolean, checks: {name: string, ok: boolean, detail?: string}[]}>}
 */
export async function runSmoke(options = {}) {
  const built = options.built === true;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const checks = [];
  const record = (name, ok, detail) => {
    checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
  };

  if (built) {
    const missing = BUILT_ARTIFACTS.filter(
      (relative) => !fs.existsSync(path.join(REPO_ROOT, relative)),
    );
    record(
      "built_artifacts",
      missing.length === 0,
      missing.length === 0 ? "all present" : `missing: ${missing.join(", ")}`,
    );
    if (missing.length > 0) {
      return { ok: false, checks };
    }
  }

  const dataDir = makeTempDataDir();
  let handle = null;
  let sigtermExitCode;

  try {
    handle = await startServer({ built, dataDir, timeoutMs });

    const urlPrinted = handle.url !== null;
    const loopback = urlPrinted && new URL(handle.url).hostname === "127.0.0.1";
    record(
      "url_printed_loopback",
      loopback,
      urlPrinted ? handle.url : "server did not print a loopback URL",
    );
    record("loopback_bind", loopback);

    if (built) {
      record("built_entry_started", loopback);
    }

    if (!urlPrinted) {
      record("host_check", false, "no listener");
      record("auth_required", false, "no listener");
      record("projects_page", false, "no listener");
      record("health", false, "no listener");
      return { ok: checks.every((check) => check.ok), checks };
    }

    const port = handle.port;

    // host_check: a Host header outside the allowlist is rejected before auth.
    try {
      const response = await request({
        port,
        path: "/api/health",
        headers: { Host: "evil.example" },
      });
      record(
        "host_check",
        response.status === 403 && errorCodeOf(response) === "forbidden_origin",
        `status ${response.status}, code ${errorCodeOf(response)}`,
      );
    } catch (error) {
      record("host_check", false, error.message);
    }

    // auth_required: an API read with no session cookie is a 401.
    try {
      const response = await request({ port, path: "/api/projects" });
      record(
        "auth_required",
        response.status === 401 && errorCodeOf(response) === "unauthorized",
        `status ${response.status}, code ${errorCodeOf(response)}`,
      );
    } catch (error) {
      record("auth_required", false, error.message);
    }

    // projects_page: the public page renders the project list container.
    try {
      const response = await request({
        port,
        path: "/",
        headers: { Accept: "text/html" },
      });
      record(
        "projects_page",
        response.status === 200 &&
          response.body.includes('data-testid="project-list"'),
        `status ${response.status}`,
      );
    } catch (error) {
      record("projects_page", false, error.message);
    }

    // health: the only route that is public and not HTML.
    try {
      const response = await request({ port, path: "/api/health" });
      record(
        "health",
        response.status === 200 &&
          response.json !== null &&
          response.json.status === "ok",
        `status ${response.status}`,
      );
    } catch (error) {
      record("health", false, error.message);
    }

    if (built) {
      // The drain handler must exit with a literal 0 (AC-OPS-02).
      handle.child.kill("SIGTERM");
      await Promise.race([handle.exited, sleep(10_000)]);
      sigtermExitCode = handle.child.exitCode;
      record(
        "sigterm_exit_zero",
        sigtermExitCode === 0,
        `exit code ${String(sigtermExitCode)}`,
      );
    }
  } catch (error) {
    record("smoke", false, error.message);
  } finally {
    await stopServer(handle);
    record(
      "no_stray_process",
      handle === null ||
        handle.child.exitCode !== null ||
        handle.child.signalCode !== null,
    );
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; the OS temp directory reclaims it eventually.
    }
  }

  return { ok: checks.every((check) => check.ok), checks };
}

function printResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  for (const check of result.checks) {
    process.stdout.write(
      `${check.ok ? "ok  " : "FAIL"} ${check.name}` +
        (check.detail ? ` — ${check.detail}` : "") +
        "\n",
    );
  }
  process.stdout.write(result.ok ? "smoke: ok\n" : "smoke: failed\n");
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
      "usage: node scripts/smoke.mjs [--json] [--built] [--timeout <ms>]\n",
    );
    return 0;
  }
  const result = await runSmoke(options);
  printResult(result, options.json);
  return result.ok ? 0 : 1;
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
