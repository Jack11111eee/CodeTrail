/**
 * The structured JSON log writer (architecture §3.13, §16, AC-OPS-08).
 *
 * Every line under `<dataDir>/logs/*.jsonl` is exactly one JSON object and
 * always carries `event` and `level`. A job-scoped line also carries `jobId`,
 * and a failure carries `error_code`. The writer has one non-negotiable rule:
 * a secret handed to `redact` must never reach the file, so every string value
 * (including an `Error.message`) goes through the injected redactor before it
 * is serialised.
 *
 * `JsonLogger`/`LogEvent` are declared here rather than in `contracts/`
 * because no other component passes the type across a module boundary; the
 * composition root is the only consumer.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import type { Clock } from "../contracts/index.js";

/** Severity carried by every line. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * One structured log line. Additional fields are allowed and are serialised
 * verbatim after redaction, so a job event can carry progress counters without
 * widening a contract type.
 */
export interface LogEvent {
  event: string;
  level?: LogLevel;
  jobId?: string | null;
  error_code?: string | null;
  [field: string]: unknown;
}

export interface JsonLogger {
  event(event: LogEvent): void;
}

export interface JsonLoggerOptions {
  /** Absolute path of the log file; its directory is created on demand. */
  file: string;
  clock: Clock;
  /** Scrubs every secret the process knows about from one string. */
  redact: (text: string) => string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Recursively redacts string values and normalises values JSON cannot encode.
 * A `Date` becomes ISO-8601, an `Error` becomes its (redacted) message, and a
 * bigint becomes a decimal string.
 */
function sanitize(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return redact(value.message);
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, redact));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const sanitized = sanitize(entry, redact);
      if (sanitized !== undefined) out[key] = sanitized;
    }
    return out;
  }
  try {
    const serialized = JSON.stringify(value);
    return redact(serialized === undefined ? "[unserializable]" : serialized);
  } catch {
    // A cyclic or otherwise non-JSON value still becomes a redacted string;
    // logging must never throw.
    return redact("[unserializable]");
  }
}

/**
 * Builds the only log writer the learning server uses.
 *
 * Writes are synchronous on purpose: a crash must not lose the line that
 * explains it, and the volume is one line per lifecycle event or job
 * transition, not per HTTP request. A failed write never throws into the
 * caller — logging must not take the server down.
 */
export function createJsonLogger(options: JsonLoggerOptions): JsonLogger {
  const { file, clock, redact } = options;
  let directoryReady = false;

  const ensureDirectory = (): void => {
    if (directoryReady) return;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    directoryReady = true;
  };

  return {
    event(event: LogEvent): void {
      if (typeof event.event !== "string" || event.event === "") return;

      const sanitized = sanitize(event, redact);
      const fields = isPlainObject(sanitized) ? sanitized : {};
      // `event` and `level` are first so a human reading the raw line sees the
      // two mandatory keys immediately; the timestamp follows. They go through
      // the same redactor as every other string, never the raw input.
      const line: Record<string, unknown> = {
        event: typeof fields.event === "string" ? fields.event : redact(event.event),
        level:
          typeof fields.level === "string" ? fields.level : redact(event.level ?? "info"),
      };
      if (typeof fields.at === "string") {
        line.at = fields.at;
      } else {
        line.at = clock.now().toISOString();
      }
      for (const [key, value] of Object.entries(fields)) {
        if (key === "event" || key === "level" || key === "at") continue;
        if (value !== undefined) line[key] = value;
      }

      try {
        ensureDirectory();
        appendFileSync(file, `${JSON.stringify(line)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      } catch {
        // A read-only or full data directory must not crash the server; the
        // acceptance harness proves the normal path writes the line.
      }
    },
  };
}
