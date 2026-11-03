import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-logs-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
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
    logger.event({ event: "job_progress", jobId: "j_1", progress: { pages: 2 } });

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
    expect(() => logger.event({ event: "shutdown", level: "info" })).not.toThrow();
  });
});
