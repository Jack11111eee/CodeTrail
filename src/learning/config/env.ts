/**
 * Environment parsing and process hardening (architecture §4.1).
 *
 * `applyProcessHardening` MUST be the first statement of the CLI entry point,
 * before any module that reads `process.env` at module scope (several upstream
 * modules do). It only mutates the process environment object it is given: it
 * never writes a file, never edits a global Node/npm configuration and never
 * touches `~/.nvm`, Homebrew or a global install.
 */

import { LearningError } from "../contracts/index.js";
import { DEFAULT_WATCH_INTERVAL_MS } from "./defaults.js";
import { resolveDataPaths } from "./paths.js";

/** Listen port used when `CODETRAIL_PORT` is absent. `0` requests an ephemeral port. */
export const DEFAULT_PORT = 4319;
/** GitHub REST base used when `CODETRAIL_GITHUB_API_BASE_URL` is absent. */
export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
/** Provider used when neither the env nor the persisted settings name one. */
export const DEFAULT_MODEL_PROVIDER = "anthropic";

export interface RuntimeEnv {
  port: number;
  watchIntervalMs: number;
  /** Raw ISO timestamp from `CODETRAIL_NOW`, or `null` when the clock runs live. */
  now: string | null;
  provider: string;
  modelId: string;
  fixtureDir: string | null;
  githubBaseUrl: string;
  githubToken: string | null;
  faultInject: string | null;
}

function readTrimmed(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function invalidInput(
  message: string,
  details: Record<string, unknown>,
): never {
  throw new LearningError("invalid_input", message, details);
}

function parseInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  opts: { min: number; max: number },
): number {
  const raw = readTrimmed(env, key);
  if (raw === null) return fallback;
  if (!/^\d+$/u.test(raw)) {
    invalidInput(`${key} must be a non-negative integer`, { field: key });
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < opts.min || parsed > opts.max) {
    invalidInput(`${key} is out of range`, {
      field: key,
      min: opts.min,
      max: opts.max,
    });
  }
  return parsed;
}

/** Parses the watch interval, rejecting zero, negatives and non-numbers. */
function parseWatchInterval(env: NodeJS.ProcessEnv): number {
  const raw = readTrimmed(env, "CODETRAIL_WATCH_INTERVAL_MS");
  if (raw === null) return DEFAULT_WATCH_INTERVAL_MS;
  if (!/^\d+$/u.test(raw)) {
    invalidInput("CODETRAIL_WATCH_INTERVAL_MS must be a positive integer", {
      field: "CODETRAIL_WATCH_INTERVAL_MS",
    });
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    invalidInput("CODETRAIL_WATCH_INTERVAL_MS must be a positive integer", {
      field: "CODETRAIL_WATCH_INTERVAL_MS",
    });
  }
  return parsed;
}

/** Parses `CODETRAIL_NOW`, rejecting an unparseable timestamp up front. */
function parseNow(env: NodeJS.ProcessEnv): string | null {
  const raw = readTrimmed(env, "CODETRAIL_NOW");
  if (raw === null) return null;
  if (Number.isNaN(Date.parse(raw))) {
    invalidInput("CODETRAIL_NOW must be an ISO timestamp", {
      field: "CODETRAIL_NOW",
    });
  }
  return raw;
}

/** Reads and validates every runtime environment variable once. */
export function resolveEnv(env: NodeJS.ProcessEnv): RuntimeEnv {
  return {
    port: parseInteger(env, "CODETRAIL_PORT", DEFAULT_PORT, {
      min: 0,
      max: 65_535,
    }),
    watchIntervalMs: parseWatchInterval(env),
    now: parseNow(env),
    provider:
      readTrimmed(env, "CODETRAIL_MODEL_PROVIDER") ?? DEFAULT_MODEL_PROVIDER,
    modelId: readTrimmed(env, "CODETRAIL_MODEL_ID") ?? "",
    fixtureDir: readTrimmed(env, "CODETRAIL_FIXTURE_DIR"),
    githubBaseUrl:
      readTrimmed(env, "CODETRAIL_GITHUB_API_BASE_URL") ??
      DEFAULT_GITHUB_API_BASE_URL,
    githubToken: readTrimmed(env, "CODETRAIL_GITHUB_TOKEN"),
    faultInject: readTrimmed(env, "CODETRAIL_FAULT_INJECT"),
  };
}

/**
 * Forces the telemetry/tracing/LFS/prompt switches and pins upstream's config
 * directory inside the data root.
 */
export function applyProcessHardening(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const paths = resolveDataPaths(env);
  env.OPENWIKI_CONFIG_DIR = paths.openwikiHome;
  env.OPENWIKI_TELEMETRY_DISABLED = "1";
  env.DO_NOT_TRACK = "1";
  env.LANGCHAIN_TRACING_V2 = "false";
  env.GIT_LFS_SKIP_SMUDGE = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}
