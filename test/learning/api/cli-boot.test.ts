import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { resolveDataPaths } from "../../../src/learning/config/paths.ts";
import { migrate, openDatabase } from "../../../src/learning/store/index.ts";

/**
 * The built entry point (AC-FORK-07, AC-OPS-02, AC-SEC-01, startup recovery).
 *
 * These tests spawn `dist/learning/api/cli.js` rather than importing the
 * source, so the build pipeline itself is exercised: if the composition root
 * were not emitted, or the asset copy step regressed, this suite fails.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const CLI = path.join(REPO_ROOT, "dist", "learning", "api", "cli.js");
const URL_PATTERN = /^http:\/\/127\.0\.0\.1:(\d+)$/u;

const tempDirs: string[] = [];
const children = new Set<ReturnType<typeof spawn>>();

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface BootResult {
  child: ReturnType<typeof spawn>;
  url: string;
  port: number;
  stdout: string;
  stderr: string;
  exit: Promise<ExitResult>;
}

interface RunResult extends ExitResult {
  stdout: string;
  stderr: string;
}

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-cli-boot-"));
  tempDirs.push(dir);
  return dir;
}

function waitForExit(
  result: Promise<ExitResult>,
  timeoutMs = 15_000,
  description = "process",
): Promise<ExitResult> {
  return new Promise<ExitResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${description} did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    void result.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Spawns the built entry and resolves once it printed its loopback URL. */
function boot(options: {
  dataDir?: string;
  env?: Record<string, string>;
  argv?: string[];
}): Promise<BootResult> {
  const dataDir = options.dataDir ?? makeTempDir();
  const child = spawn(process.execPath, [CLI, ...(options.argv ?? [])], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CODETRAIL_DATA_DIR: dataDir,
      CODETRAIL_PORT: "0",
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);

  let stdout = "";
  let stderr = "";
  const exit = new Promise<ExitResult>((resolve) => {
    child.once("exit", (code, signal) => {
      children.delete(child);
      resolve({ code, signal });
    });
  });

  return new Promise<BootResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `built entry did not print a URL within 30 s\nstderr:\n${stderr}\nstdout:\n${stdout}`,
        ),
      );
    }, 30_000);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      for (const line of stdout.split("\n")) {
        const match = URL_PATTERN.exec(line);
        if (match === null) continue;
        clearTimeout(timer);
        resolve({
          child,
          url: line,
          port: Number(match[1]),
          stdout,
          stderr,
          exit,
        });
        return;
      }
    });
    void exit.then(({ code, signal }) => {
      clearTimeout(timer);
      reject(
        new Error(
          `built entry exited before printing a URL (code ${String(code)}, ` +
            `signal ${String(signal)})\nstderr:\n${stderr}\nstdout:\n${stdout}`,
        ),
      );
    });
  });
}

/** Spawns the built entry and waits for it to exit on its own. */
async function runToExit(
  argv: string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  const dataDir = makeTempDir();
  const child = spawn(process.execPath, [CLI, ...argv], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CODETRAIL_DATA_DIR: dataDir,
      CODETRAIL_PORT: "0",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exit = await waitForExit(
    new Promise<ExitResult>((resolve) => {
      child.once("exit", (code, signal) => {
        children.delete(child);
        resolve({ code, signal });
      });
    }),
    30_000,
    `built entry ${argv.join(" ")}`,
  );
  return { ...exit, stdout, stderr };
}

async function stop(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await waitForExit(
    new Promise<ExitResult>((resolve) => {
      child.once("exit", (code, signal) => {
        children.delete(child);
        resolve({ code, signal });
      });
    }),
    10_000,
    "child shutdown",
  ).catch(() => {
    child.kill("SIGKILL");
  });
}

function sessionCookie(response: Response): string {
  const headers =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") ?? ""];
  const cookie = headers.find((header) =>
    header.startsWith("codetrail_session="),
  );
  if (cookie === undefined) throw new Error("bootstrap did not mint a session");
  return cookie.split(";")[0];
}

async function bootstrap(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/session/bootstrap`);
  await response.text();
  return sessionCookie(response);
}

interface JsonResponse {
  status: number;
  body: unknown;
}

/** The entry writes one JSON object on stderr; Node may prepend warnings. */
function structuredError(stderr: string): { error: { code: string } } {
  const line = stderr
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith('{"error"'));
  if (line === undefined) {
    throw new Error(`no structured error on stderr:\n${stderr}`);
  }
  return JSON.parse(line) as { error: { code: string } };
}

async function getJson(
  baseUrl: string,
  pathname: string,
  cookie?: string,
): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: cookie === undefined ? {} : { cookie },
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? null : (JSON.parse(text) as unknown),
  };
}

/**
 * Seeds the two restart leftovers startup recovery must repair: a `running`
 * job and a `streaming` assistant message.
 */
function seedInterruptedState(dataDir: string): void {
  const paths = resolveDataPaths({ CODETRAIL_DATA_DIR: dataDir });
  fs.mkdirSync(path.dirname(paths.db), { recursive: true });
  const db = openDatabase({ file: paths.db });
  try {
    migrate(db);
    const at = "2026-01-01T00:00:00.000Z";
    db.raw
      .prepare(
        `INSERT INTO jobs (job_id, dedupe_key, kind, repo_id, project_id, stream_id,
           state, payload_json, attempt, created_at, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "j_seed_running",
        "dedupe_seed",
        "generation_initial",
        "r_seed",
        null,
        null,
        "running",
        JSON.stringify({
          kind: "generation",
          commitSha: "a".repeat(40),
          baseContextSha: null,
          scope: {},
          config: {},
        }),
        1,
        at,
        at,
      );
    db.raw
      .prepare(
        `INSERT INTO conversations (conversation_id, generation_ids_json,
           created_at, last_active_at) VALUES (?, ?, ?, ?)`,
      )
      .run("c_seed", JSON.stringify(["g_seed"]), at, at);
    db.raw
      .prepare(
        `INSERT INTO messages (message_id, conversation_id, role, content,
           status, answer_phase, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "m_seed",
        "c_seed",
        "assistant",
        "partial answer",
        "streaming",
        "streaming",
        at,
      );
  } finally {
    db.close();
  }
}

beforeAll(() => {
  if (!fs.existsSync(CLI)) {
    throw new Error(
      `missing ${CLI}; run \`pnpm run build\` before the learning suite`,
    );
  }
});

afterEach(async () => {
  for (const child of [...children]) {
    await stop(child);
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("AC-FORK-07: the build emits every runtime entry point", () => {
  const required = [
    "dist/cli/cli.js",
    "dist/visualize/client.js",
    "dist/learning/api/cli.js",
    "dist/visualize/styles.css",
  ];

  it("produces each file with a non-empty body", () => {
    for (const relative of required) {
      const file = path.join(REPO_ROOT, relative);
      expect(fs.existsSync(file), relative).toBe(true);
      expect(fs.statSync(file).size, relative).toBeGreaterThan(0);
    }
  });
});

describe("AC-OPS-02: the built entry binds loopback and drains on SIGTERM", () => {
  it("prints exactly one 127.0.0.1 URL, serves health, and exits 0", async () => {
    const running = await boot({});
    try {
      expect(URL_PATTERN.test(running.url)).toBe(true);

      const health = await getJson(running.url, "/api/health");
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({ status: "ok" });

      // Exactly one URL line: no banner, no port log, no duplicate.
      const lines = running.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      expect(lines).toEqual([running.url]);
    } finally {
      running.child.kill("SIGTERM");
    }

    const exit = await waitForExit(running.exit, 15_000, "SIGTERM drain");
    expect(exit).toEqual({ code: 0, signal: null });
    // No surviving child: `exitCode` is only set once the process is gone.
    expect(running.child.exitCode).toBe(0);
  });

  it("exits 0 on SIGINT as well", async () => {
    const running = await boot({});
    running.child.kill("SIGINT");
    const exit = await waitForExit(running.exit, 15_000, "SIGINT drain");
    expect(exit).toEqual({ code: 0, signal: null });
  });

  it("honours --port 0", async () => {
    const running = await boot({ argv: ["--port", "0"] });
    running.child.kill("SIGTERM");
    const exit = await waitForExit(running.exit, 15_000, "--port drain");
    expect(exit.code).toBe(0);
    expect(running.port).toBeGreaterThan(0);
  });

  it("repairs a running job and a streaming message before accepting requests", async () => {
    const dataDir = makeTempDir();
    seedInterruptedState(dataDir);

    const running = await boot({ dataDir });
    try {
      const cookie = await bootstrap(running.url);

      // These are the *first* HTTP requests the process serves, so the values
      // prove the sweep ran before `listen`.
      const job = await getJson(
        running.url,
        "/api/jobs/j_seed_running",
        cookie,
      );
      expect(job.status).toBe(200);
      expect(job.body).toMatchObject({
        state: "interrupted",
        errorCode: "interrupted",
      });

      const conversation = await getJson(
        running.url,
        "/api/conversations/c_seed",
        cookie,
      );
      expect(conversation.status).toBe(200);
      const messages = (
        conversation.body as {
          messages: { status: string; answerPhase: string }[];
        }
      ).messages;
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        status: "cancelled",
        answerPhase: "cancelled",
      });
    } finally {
      running.child.kill("SIGTERM");
    }
    const exit = await waitForExit(running.exit, 15_000, "recovery drain");
    expect(exit.code).toBe(0);
  });
});

describe("AC-SEC-01: the built entry refuses to widen the bind", () => {
  it("exits non-zero with invalid_input for --host", async () => {
    const result = await runToExit(["--host", "0.0.0.0"]);
    expect(result.code).not.toBe(0);
    expect(result.signal).toBeNull();
    expect(structuredError(result.stderr).error.code).toBe("invalid_input");
  });

  it("rejects --host=<value> spelling too", async () => {
    const result = await runToExit(["--host=example.com"]);
    expect(result.code).not.toBe(0);
    expect(structuredError(result.stderr).error.code).toBe("invalid_input");
  });

  it("rejects an unknown flag with invalid_input", async () => {
    const result = await runToExit(["--listen-everywhere"]);
    expect(result.code).not.toBe(0);
    expect(structuredError(result.stderr).error.code).toBe("invalid_input");
  });

  it("ignores a non-loopback CODETRAIL_HOST", async () => {
    const running = await boot({ env: { CODETRAIL_HOST: "0.0.0.0" } });
    running.child.kill("SIGTERM");
    const exit = await waitForExit(running.exit, 15_000, "host env drain");
    expect(exit.code).toBe(0);
    expect(running.url.startsWith("http://127.0.0.1:")).toBe(true);
  });
});

describe("startup failures are structured and non-zero", () => {
  it("reports a port already in use without printing a URL", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const address = blocker.address();
    if (address === null || typeof address === "string") {
      blocker.close();
      throw new Error("could not allocate a blocker port");
    }
    try {
      const result = await runToExit([], {
        CODETRAIL_PORT: String(address.port),
      });
      expect(result.code).not.toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stdout).toBe("");
      expect(structuredError(result.stderr).error.code).toBe("conflict");
    } finally {
      await new Promise<void>((resolve) => {
        blocker.close(() => {
          resolve();
        });
      });
    }
  });
});
