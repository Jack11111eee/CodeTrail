import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createJsonLogger } from "../../../src/learning/api/log.ts";
import { createClock } from "../../../src/learning/testing/clock.ts";

/**
 * AC-OPS-08 / AC-SEC-09: `logs/` is one JSON object per line, every line
 * carries `event` + `level`, job-scoped lines carry `jobId`, a failure carries
 * `error_code`, and a secret never reaches the file.
 *
 * The writer is the only place a log line is produced, so these assertions
 * hold for the CLI too (it installs this exact logger).
 */

const CANARY = "ghp_canary_0123456789abcdef";
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TSX = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = path.join(REPO_ROOT, "src", "learning", "api", "cli.ts");
const tempDirs: string[] = [];
const children: { kill: (signal?: NodeJS.Signals) => boolean }[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-logs-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function redact(text: string): string {
  return text.split(CANARY).join("[redacted]");
}

function readLines(file: string): Record<string, unknown>[] {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("structured JSON logs", () => {
  it("writes one JSON object per line with event, level and jobId", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "logs", "codetrail.jsonl");
    const logger = createJsonLogger({
      file,
      clock: createClock("2026-01-01T00:00:00.000Z"),
      redact,
    });

    logger.event({ event: "job_started", level: "info", jobId: "j_1" });
    logger.event({
      event: "job_progress",
      jobId: "j_1",
      progress: { pages: 2 },
    });

    const lines = readLines(file);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      event: "job_started",
      level: "info",
      jobId: "j_1",
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(lines[1]).toMatchObject({
      event: "job_progress",
      level: "info",
      jobId: "j_1",
      progress: { pages: 2 },
    });
    for (const line of lines) {
      expect(typeof line.event).toBe("string");
      expect(typeof line.level).toBe("string");
    }
  });

  it("carries error_code on failures and redacts every secret", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "logs", "codetrail.jsonl");
    const logger = createJsonLogger({
      file,
      clock: createClock("2026-01-01T00:00:00.000Z"),
      redact,
    });

    logger.event({
      event: "job_failed",
      level: "error",
      jobId: "j_2",
      error_code: "model_not_configured",
      message: `provider rejected ${CANARY}`,
      nested: { detail: `again ${CANARY}`, count: 1 },
      error: new Error(`boom ${CANARY}`),
    });

    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain(CANARY);
    expect(raw.trim().split("\n")).toHaveLength(1);

    const [line] = readLines(file);
    expect(line).toMatchObject({
      event: "job_failed",
      level: "error",
      jobId: "j_2",
      error_code: "model_not_configured",
      message: "provider rejected [redacted]",
      nested: { detail: "again [redacted]", count: 1 },
      error: "boom [redacted]",
    });
  });

  it("never throws when the directory cannot be written", () => {
    const dir = makeTempDir();
    // A file where the log directory should be is an unavoidable write error;
    // logging must stay best-effort so it cannot take the server down.
    const blocker = path.join(dir, "logs");
    fs.writeFileSync(blocker, "not a directory", "utf8");
    const logger = createJsonLogger({
      file: path.join(blocker, "codetrail.jsonl"),
      clock: createClock("2026-01-01T00:00:00.000Z"),
      redact,
    });
    expect(() =>
      logger.event({ event: "shutdown", level: "info" }),
    ).not.toThrow();
  });

  it("writes the booted CLI's own lifecycle events as one JSON object per line", async () => {
    const dir = makeTempDir();
    const child = spawn(process.execPath, [TSX, CLI], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CODETRAIL_DATA_DIR: dir,
        CODETRAIL_PORT: "0",
        CODETRAIL_GITHUB_TOKEN: CANARY,
        OPENWIKI_TELEMETRY_DISABLED: "1",
        DO_NOT_TRACK: "1",
        LANGCHAIN_TRACING_V2: "false",
        GIT_LFS_SKIP_SMUDGE: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const exited = new Promise<{ code: number | null }>((resolve) => {
      child.once("exit", (code) => resolve({ code }));
    });

    const deadline = Date.now() + 30_000;
    while (
      Date.now() < deadline &&
      !/^http:\/\/127\.0\.0\.1:\d+\s*$/mu.test(stdout) &&
      child.exitCode === null
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(stdout, stderr).toMatch(/http:\/\/127\.0\.0\.1:\d+/u);

    child.kill("SIGTERM");
    const exit = await Promise.race([
      exited,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
    ]);
    if (exit === null) child.kill("SIGKILL");
    expect(exit, stderr).not.toBeNull();
    expect(exit?.code, stderr).toBe(0);

    const logFile = path.join(dir, "logs", "codetrail.jsonl");
    expect(fs.existsSync(logFile)).toBe(true);
    const lines = readLines(logFile);
    expect(lines.map((line) => line.event)).toEqual(
      expect.arrayContaining(["server_started", "shutdown"]),
    );
    for (const line of lines) {
      expect(typeof line.event).toBe("string");
      expect(typeof line.level).toBe("string");
      expect(typeof line.at).toBe("string");
    }
    expect(fs.readFileSync(logFile, "utf8")).not.toContain(CANARY);
  }, 60_000);
});
