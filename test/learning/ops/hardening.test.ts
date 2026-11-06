import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { LearningError } from "../../../src/learning/contracts/index.js";
import type { GithubCredential } from "../../../src/learning/contracts/index.js";
import {
  DEFAULT_WATCH_INTERVAL_MS,
  DISCOVERY_DEFAULTS,
  GIT_TIMEOUT_MS,
  MAX_BODY_BYTES,
  MAX_FILES,
  MAX_LOOKBACK_MS,
  MODEL_CONCURRENCY,
  PAGE_CONCURRENCY,
  PREFERRED_LANGUAGES,
  PR_OVERLAP_MS,
  PROMPT_TEMPLATE_VERSION,
  QA_LIMITS,
  SCHEMA_VERSION,
  UPSTREAM_COMMIT,
  UPSTREAM_PACKAGE_VERSION,
  UPSTREAM_VERSION,
} from "../../../src/learning/config/defaults.js";
import {
  applyProcessHardening,
  DEFAULT_GITHUB_API_BASE_URL,
  DEFAULT_PORT,
  resolveEnv,
} from "../../../src/learning/config/env.js";
import { resolveDataPaths } from "../../../src/learning/config/paths.js";
import {
  loadCredential,
  REDACTED,
  redactSecrets,
  saveCredential,
} from "../../../src/learning/config/credentials.js";

/**
 * AC-SEC-08 (hardening half), AC-UPD-03 (interval half), the frozen defaults
 * and the 0600 credential store. Every test owns a temp data directory.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-hardening-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

describe("applyProcessHardening", () => {
  it("forces telemetry, tracing, LFS and prompt settings", () => {
    const dir = makeTempDir();
    const env: NodeJS.ProcessEnv = {
      CODETRAIL_DATA_DIR: dir,
      OPENWIKI_TELEMETRY_DISABLED: "0",
      LANGCHAIN_TRACING_V2: "true",
    };
    const hardened = applyProcessHardening(env);

    expect(hardened).toBe(env);
    expect(hardened.OPENWIKI_TELEMETRY_DISABLED).toBe("1");
    expect(hardened.DO_NOT_TRACK).toBe("1");
    expect(hardened.LANGCHAIN_TRACING_V2).not.toBe("true");
    expect(hardened.LANGCHAIN_TRACING_V2).toBe("false");
    expect(hardened.GIT_LFS_SKIP_SMUDGE).toBe("1");
    expect(hardened.GIT_TERMINAL_PROMPT).toBe("0");
    expect(hardened.OPENWIKI_CONFIG_DIR).toBe(
      path.join(resolveDataPaths(env).root, "openwiki-home"),
    );
  });

  it("writes no file and leaves the data directory untouched", () => {
    const dir = makeTempDir();
    const before = fs.readdirSync(dir);
    const previous = process.env.OPENWIKI_TELEMETRY_DISABLED;

    applyProcessHardening({ CODETRAIL_DATA_DIR: dir });

    expect(fs.readdirSync(dir)).toEqual(before);
    expect(fs.existsSync(path.join(dir, "openwiki-home"))).toBe(false);
    expect(process.env.OPENWIKI_TELEMETRY_DISABLED).toBe(previous);
  });

  it("is implemented without any filesystem or process-spawning write", () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, "src/learning/config/env.ts"),
      "utf8",
    );
    expect(source).not.toMatch(
      /writeFile|appendFile|createWriteStream|mkdir|execFile|spawn|child_process/u,
    );
  });
});

describe("frozen defaults", () => {
  it("carries the architecture §4.3 values", () => {
    expect(UPSTREAM_COMMIT).toBe("7bb583d664f2d1c2484fa44b9d591f6103ca8166");
    expect(UPSTREAM_PACKAGE_VERSION).toBe("0.7.2");
    expect(UPSTREAM_VERSION).toBe("0.7.2+7bb583d664f2");
    expect(PROMPT_TEMPLATE_VERSION).toBe("codetrail-lesson-v1");
    expect(SCHEMA_VERSION).toBe(3);
    expect(MAX_BODY_BYTES).toBe(1024 * 1024);
    expect(DEFAULT_WATCH_INTERVAL_MS).toBe(300_000);
    expect(PR_OVERLAP_MS).toBe(120_000);
    expect(MAX_LOOKBACK_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(MAX_FILES).toBe(5_000);
    expect(MODEL_CONCURRENCY).toBe(2);
    expect(PAGE_CONCURRENCY).toBe(1);
    expect(GIT_TIMEOUT_MS).toBe(120_000);
    expect(DISCOVERY_DEFAULTS).toEqual({ perPage: 100, maxPages: 20 });
    expect(QA_LIMITS).toEqual({
      maxToolCalls: 8,
      maxInputTokens: 24_000,
      maxOutputTokens: 4_000,
    });
    expect(PREFERRED_LANGUAGES).toEqual([
      "python",
      "java",
      "typescript",
      "javascript",
      "vue",
    ]);
  });

  it("cannot be mutated at runtime", () => {
    expect(Object.isFrozen(DISCOVERY_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(QA_LIMITS)).toBe(true);
    expect(Object.isFrozen(PREFERRED_LANGUAGES)).toBe(true);
    expect(() => {
      (DISCOVERY_DEFAULTS as unknown as { perPage: number }).perPage = 1;
    }).toThrow();
    expect(() => {
      (PREFERRED_LANGUAGES as unknown as string[]).push("rust");
    }).toThrow();
    expect(DISCOVERY_DEFAULTS.perPage).toBe(100);
  });
});

describe("resolveEnv", () => {
  it("defaults the watch interval to 300000 ms", () => {
    expect(resolveEnv({}).watchIntervalMs).toBe(300_000);
    expect(DEFAULT_WATCH_INTERVAL_MS).toBe(300_000);
  });

  it("honours CODETRAIL_WATCH_INTERVAL_MS", () => {
    expect(
      resolveEnv({ CODETRAIL_WATCH_INTERVAL_MS: "1500" }).watchIntervalMs,
    ).toBe(1500);
  });

  it("rejects a non-numeric or non-positive interval with invalid_input", () => {
    for (const value of ["abc", "", "0", "-5", "1.5", "NaN", "Infinity"]) {
      const error = capture(() =>
        resolveEnv({ CODETRAIL_WATCH_INTERVAL_MS: value }),
      );
      if (value === "") {
        // An empty value means "unset", not invalid.
        expect(error).toBeNull();
        continue;
      }
      expect(error, value).toBeInstanceOf(LearningError);
      expect((error as LearningError).code, value).toBe("invalid_input");
    }
  });

  it("parses port, clock, provider, GitHub and fault settings", () => {
    const env = resolveEnv({
      CODETRAIL_PORT: "0",
      CODETRAIL_NOW: "2026-11-01T00:00:00.000Z",
      CODETRAIL_MODEL_PROVIDER: "fixture",
      CODETRAIL_MODEL_ID: "fixture-model",
      CODETRAIL_FIXTURE_DIR: "/tmp/fixtures",
      CODETRAIL_GITHUB_API_BASE_URL: "http://127.0.0.1:9999",
      CODETRAIL_GITHUB_TOKEN: "token-value",
      CODETRAIL_FAULT_INJECT: "seal",
    });
    expect(env).toEqual({
      port: 0,
      watchIntervalMs: 300_000,
      now: "2026-11-01T00:00:00.000Z",
      provider: "fixture",
      modelId: "fixture-model",
      fixtureDir: "/tmp/fixtures",
      githubBaseUrl: "http://127.0.0.1:9999",
      githubToken: "token-value",
      faultInject: "seal",
    });
  });

  it("uses documented defaults for everything else", () => {
    const env = resolveEnv({});
    expect(env.port).toBe(DEFAULT_PORT);
    expect(env.now).toBeNull();
    expect(env.provider).toBe("anthropic");
    expect(env.modelId).toBe("");
    expect(env.fixtureDir).toBeNull();
    expect(env.githubBaseUrl).toBe(DEFAULT_GITHUB_API_BASE_URL);
    expect(env.githubToken).toBeNull();
    expect(env.faultInject).toBeNull();
  });

  it("rejects an out-of-range port and a bad timestamp", () => {
    for (const value of ["70000", "-1", "abc"]) {
      const error = capture(() => resolveEnv({ CODETRAIL_PORT: value }));
      expect(error, value).toBeInstanceOf(LearningError);
      expect((error as LearningError).code).toBe("invalid_input");
    }
    const error = capture(() => resolveEnv({ CODETRAIL_NOW: "not-a-date" }));
    expect(error).toBeInstanceOf(LearningError);
    expect((error as LearningError).code).toBe("invalid_input");
  });
});

describe("credentials", () => {
  const TOKEN = "ghp_canary_0123456789abcdef";

  function credential(): GithubCredential {
    return {
      kind: "token",
      token: TOKEN,
      login: "octocat",
    };
  }

  it("writes credentials.json atomically with mode 0600 and reads it back", async () => {
    const dir = makeTempDir();
    const paths = resolveDataPaths({ CODETRAIL_DATA_DIR: dir });

    await saveCredential(paths, credential());

    expect(fs.statSync(paths.credentials).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(paths.root)).toEqual(["credentials.json"]);

    const loaded = loadCredential(paths, {});
    expect(loaded).not.toBeNull();
    expect(loaded?.kind).toBe("token");
    expect(loaded?.token).toBe(TOKEN);
    expect(loaded?.login).toBe("octocat");
  });

  it("never serialises, prints or stringifies the token", async () => {
    const dir = makeTempDir();
    const paths = resolveDataPaths({ CODETRAIL_DATA_DIR: dir });
    await saveCredential(paths, credential());
    const loaded = loadCredential(paths, {});
    expect(loaded).not.toBeNull();

    expect(JSON.stringify(loaded)).not.toContain(TOKEN);
    expect(JSON.stringify({ loaded })).not.toContain(TOKEN);
    // The runtime credential overrides toString/inspect; the contract type
    // cannot express that, so the generic stringification rules do not apply.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    expect(String(loaded)).not.toContain(TOKEN);
    expect(inspect(loaded)).not.toContain(TOKEN);
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    expect(`${loaded?.toString()}`).not.toContain(TOKEN);
  });

  it("falls back to CODETRAIL_GITHUB_TOKEN and prefers the file", async () => {
    const dir = makeTempDir();
    const paths = resolveDataPaths({ CODETRAIL_DATA_DIR: dir });

    expect(loadCredential(paths, {})).toBeNull();
    const fromEnv = loadCredential(paths, {
      CODETRAIL_GITHUB_TOKEN: "env-token-0123456789",
    });
    expect(fromEnv?.token).toBe("env-token-0123456789");
    expect(fromEnv?.login).toBeNull();

    await saveCredential(paths, credential());
    const fromFile = loadCredential(paths, {
      CODETRAIL_GITHUB_TOKEN: "env-token-0123456789",
    });
    expect(fromFile?.token).toBe(TOKEN);
  });

  it("reads only from its own data directory", async () => {
    const first = resolveDataPaths({ CODETRAIL_DATA_DIR: makeTempDir() });
    const second = resolveDataPaths({ CODETRAIL_DATA_DIR: makeTempDir() });
    await saveCredential(first, credential());

    expect(loadCredential(second, {})).toBeNull();
  });

  it("rejects a malformed file without echoing its contents", () => {
    const dir = makeTempDir();
    const paths = resolveDataPaths({ CODETRAIL_DATA_DIR: dir });
    fs.writeFileSync(paths.credentials, `{"kind":"token","token":${TOKEN}`, {
      mode: 0o600,
    });

    const error = capture(() => loadCredential(paths, {}));
    expect(error).toBeInstanceOf(LearningError);
    expect((error as LearningError).code).toBe("invalid_input");
    expect((error as LearningError).message).not.toContain(TOKEN);
  });

  it("redacts secrets in log-bound text", () => {
    expect(redactSecrets(`token=${TOKEN}`, TOKEN)).toBe(`token=${REDACTED}`);
    expect(redactSecrets(`a ${TOKEN} b ${TOKEN}`, [TOKEN, null, "xy"])).toBe(
      `a ${REDACTED} b ${REDACTED}`,
    );
    expect(redactSecrets("nothing to redact", TOKEN)).toBe("nothing to redact");
  });
});
