/**
 * Integration merge boundary: ops-scripts `src/learning/api/log.ts` × the
 * composition root `src/learning/api/cli.ts` (merged in an earlier level).
 *
 * ops-scripts adds the structured JSON logger and wires it into boot: the
 * logger is created from the data directory, the session/GitHub tokens are
 * registered with the redactor, `server_started` is emitted after the URL line
 * and `shutdown` after SIGTERM. This test boots the *real* entry point as a
 * child process (the same way `scripts/smoke.mjs` does) and proves the wiring
 * end to end: loopback URL, health, session bootstrap, authenticated API,
 * structured logs and a literal exit-0 drain.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, test } from "vitest";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = path.join(ROOT, "src", "learning", "api", "cli.ts");
const UPSTREAM_COMMIT = "7bb583d664f2d1c2484fa44b9d591f6103ca8166";
const TOKEN_CANARY = "ghp_integration_log_canary_0123456789";

interface Running {
  child: ReturnType<typeof spawn>;
  dataDir: string;
  stdout: () => string;
  stderr: () => string;
  url: string;
  port: number;
  exited: Promise<number | null>;
}

interface ResponseShape {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: Record<string, unknown> | null;
}

const children: Running[] = [];
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function request(
  port: number,
  requestPath: string,
  options: { headers?: Record<string, string> } = {},
): Promise<ResponseShape> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method: "GET",
        headers: options.headers ?? {},
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let json: Record<string, unknown> | null = null;
          try {
            json = JSON.parse(body) as Record<string, unknown>;
          } catch {
            json = null;
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

async function bootServer(): Promise<Running> {
  const dataDir = makeTempDir("codetrail-log-integration-");
  const child = spawn(process.execPath, [TSX, CLI], {
    cwd: ROOT,
    env: {
      ...process.env,
      CODETRAIL_DATA_DIR: dataDir,
      CODETRAIL_PORT: "0",
      CODETRAIL_GITHUB_TOKEN: TOKEN_CANARY,
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
  child.stdout!.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  let exitCode: number | null = null;
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      exitCode = code;
      resolve(code);
    });
  });

  const deadline = Date.now() + 40_000;
  let url = "";
  while (Date.now() < deadline) {
    const match = /^http:\/\/127\.0\.0\.1:(\d+)\s*$/mu.exec(stdout);
    if (match) {
      url = match[0].trim();
      break;
    }
    if (exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  if (url === "") {
    child.kill("SIGKILL");
    throw new Error(
      `server did not print a loopback URL\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }

  const running: Running = {
    child,
    dataDir,
    stdout: () => stdout,
    stderr: () => stderr,
    url,
    port: Number(new URL(url).port),
    exited,
  };
  children.push(running);
  return running;
}

function readLogLines(dataDir: string): Record<string, unknown>[] {
  const file = path.join(dataDir, "logs", "codetrail.jsonl");
  expect(fs.existsSync(file), "the boot logger wrote codetrail.jsonl").toBe(
    true,
  );
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`log line ${index + 1} is not JSON: ${line}`);
      }
      expect(typeof parsed, `log line ${index + 1} is an object`).toBe(
        "object",
      );
      return parsed as Record<string, unknown>;
    });
}

afterAll(async () => {
  for (const running of children.splice(0)) {
    if (running.child.exitCode === null && running.child.signalCode === null) {
      running.child.kill("SIGKILL");
      await Promise.race([
        running.exited,
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("learning entry boot × structured logger", () => {
  test("boots loopback-only, serves health/session/API and writes redacted JSON logs", async () => {
    const server = await bootServer();

    // Exactly one line on stdout is the loopback URL (AC-OPS-02).
    const stdoutLines = server
      .stdout()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    expect(stdoutLines).toContain(server.url);
    expect(new URL(server.url).hostname).toBe("127.0.0.1");

    // Health is public and reports the pinned upstream commit.
    const health = await request(server.port, "/api/health");
    expect(health.status).toBe(200);
    expect(health.json).toMatchObject({
      status: "ok",
      upstreamCommit: UPSTREAM_COMMIT,
    });

    // Everything else requires the session cookie minted by bootstrap.
    const unauthenticated = await request(server.port, "/api/projects");
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.json).toMatchObject({
      error: { code: "unauthorized" },
    });

    // The contract mints the cookie with an empty 204 response.
    const bootstrap = await request(server.port, "/session/bootstrap");
    expect(bootstrap.status).toBe(204);
    expect(bootstrap.body).toBe("");
    const setCookie = bootstrap.headers["set-cookie"] ?? [];
    const cookie = setCookie.find((value) =>
      value.startsWith("codetrail_session="),
    );
    expect(cookie, "bootstrap sets the session cookie").toBeDefined();
    expect(cookie).toMatch(/HttpOnly/u);
    expect(cookie).toMatch(/SameSite=Strict/u);

    const token = /codetrail_session=([^;]+)/u.exec(cookie!)![1];
    const authenticated = await request(server.port, "/api/projects", {
      headers: { Cookie: `codetrail_session=${token}` },
    });
    expect(authenticated.status).toBe(200);

    // ops-scripts' logger is wired into boot: one JSON object per line, each
    // carrying event + level, starting with `server_started`.
    const logs = readLogLines(server.dataDir);
    expect(logs.length).toBeGreaterThanOrEqual(1);
    for (const line of logs) {
      expect(typeof line.event, "every log line has an event").toBe("string");
      expect(typeof line.level, "every log line has a level").toBe("string");
      expect(["debug", "info", "warn", "error"]).toContain(line.level);
    }
    const started = logs.find((line) => line.event === "server_started");
    expect(started, "server_started is logged").toBeDefined();
    expect(started).toMatchObject({ port: server.port, url: server.url });

    // The GitHub token handed to the process is a redaction secret and must
    // never reach the log file (AC-OPS-08 / AC-SEC-09).
    expect(
      fs.readFileSync(
        path.join(server.dataDir, "logs", "codetrail.jsonl"),
        "utf8",
      ),
    ).not.toContain(TOKEN_CANARY);

    // SIGTERM drains in order and exits with a literal 0; shutdown is logged
    // by the same logger before the process goes away.
    server.child.kill("SIGTERM");
    const exitCode = await Promise.race([
      server.exited,
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 20_000),
      ),
    ]);
    expect(exitCode, `server did not exit on SIGTERM\n${server.stderr()}`).toBe(
      0,
    );

    const afterShutdown = readLogLines(server.dataDir);
    expect(
      afterShutdown.some((line) => line.event === "shutdown"),
      "shutdown is logged",
    ).toBe(true);
    expect(
      fs.readFileSync(
        path.join(server.dataDir, "logs", "codetrail.jsonl"),
        "utf8",
      ),
    ).not.toContain(TOKEN_CANARY);
  }, 90_000);
});
