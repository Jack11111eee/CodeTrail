import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { applyProcessHardening } from "../../../src/learning/config/env.ts";
import { resolveDataPaths } from "../../../src/learning/config/paths.ts";

/**
 * AC-SEC-08 (process half): telemetry, remote tracing and the interactive Git
 * prompts are forced off before any upstream module can read `process.env`.
 *
 * Both halves are asserted:
 *   - in-process through `applyProcessHardening`, and
 *   - in the *built* entry, whose first statement must harden the child's
 *     environment even when the caller supplies hostile values.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const CLI_SOURCE = path.join(REPO_ROOT, "src", "learning", "api", "cli.ts");
const CLI_BUILT = path.join(REPO_ROOT, "dist", "learning", "api", "cli.js");

const tempDirs: string[] = [];
const children = new Set<ReturnType<typeof spawn>>();

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-telemetry-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  children.clear();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

beforeAll(() => {
  if (!fs.existsSync(CLI_BUILT)) {
    throw new Error(
      `missing ${CLI_BUILT}; run \`pnpm run build\` before the learning suite`,
    );
  }
});

const HOSTILE_ENV = {
  OPENWIKI_TELEMETRY_DISABLED: "0",
  DO_NOT_TRACK: "0",
  LANGCHAIN_TRACING_V2: "true",
  GIT_LFS_SKIP_SMUDGE: "0",
  GIT_TERMINAL_PROMPT: "1",
};

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs an ESM one-liner under the same Node binary the suite uses. */
function runEsm(
  script: string,
  env: Record<string, string>,
): Promise<ChildResult> {
  return new Promise<ChildResult>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child timed out\nstderr:\n${stderr}`));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("applyProcessHardening", () => {
  it("forces the telemetry, tracing, LFS and prompt switches", () => {
    const dir = makeTempDir();
    const env: NodeJS.ProcessEnv = {
      CODETRAIL_DATA_DIR: dir,
      ...HOSTILE_ENV,
    };

    const hardened = applyProcessHardening(env);

    expect(hardened).toBe(env);
    expect(hardened.OPENWIKI_TELEMETRY_DISABLED).toBe("1");
    expect(hardened.DO_NOT_TRACK).toBe("1");
    expect(hardened.LANGCHAIN_TRACING_V2).toBe("false");
    expect(hardened.LANGCHAIN_TRACING_V2).not.toBe("true");
    expect(hardened.GIT_LFS_SKIP_SMUDGE).toBe("1");
    expect(hardened.GIT_TERMINAL_PROMPT).toBe("0");
    expect(hardened.OPENWIKI_CONFIG_DIR).toBe(
      path.join(resolveDataPaths(env).root, "openwiki-home"),
    );
  });
});

describe("the built entry hardens the child process", () => {
  it("overrides hostile telemetry values before anything else runs", async () => {
    const dir = makeTempDir();
    const script = `
      const { pathToFileURL } = await import("node:url");
      await import(pathToFileURL(process.env.CODETRAIL_CLI_PATH).href);
      process.stdout.write(JSON.stringify({
        OPENWIKI_TELEMETRY_DISABLED: process.env.OPENWIKI_TELEMETRY_DISABLED,
        DO_NOT_TRACK: process.env.DO_NOT_TRACK,
        LANGCHAIN_TRACING_V2: process.env.LANGCHAIN_TRACING_V2,
        GIT_LFS_SKIP_SMUDGE: process.env.GIT_LFS_SKIP_SMUDGE,
        GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT,
        OPENWIKI_CONFIG_DIR: process.env.OPENWIKI_CONFIG_DIR,
      }));
    `;

    const result = await runEsm(script, {
      ...HOSTILE_ENV,
      CODETRAIL_DATA_DIR: dir,
      CODETRAIL_CLI_PATH: CLI_BUILT,
    });

    expect(result.code, result.stderr).toBe(0);
    const env = JSON.parse(result.stdout.trim()) as Record<
      string,
      string | undefined
    >;
    expect(env.OPENWIKI_TELEMETRY_DISABLED).toBe("1");
    expect(env.DO_NOT_TRACK).toBe("1");
    expect(env.LANGCHAIN_TRACING_V2).toBe("false");
    expect(env.GIT_LFS_SKIP_SMUDGE).toBe("1");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.OPENWIKI_CONFIG_DIR).toBe(
      path.join(
        resolveDataPaths({ CODETRAIL_DATA_DIR: dir }).root,
        "openwiki-home",
      ),
    );
  });

  it("starts the built standalone with the same hardened environment", async () => {
    const dir = makeTempDir();
    const child = spawn(process.execPath, [CLI_BUILT], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...HOSTILE_ENV,
        CODETRAIL_DATA_DIR: dir,
        CODETRAIL_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const exit = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => {
        children.delete(child);
        resolve(code);
      });
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no URL within 30 s\nstderr:\n${stderr}`));
      }, 30_000);
      child.stdout.on("data", () => {
        if (/^http:\/\/127\.0\.0\.1:\d+$/mu.test(stdout)) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    child.kill("SIGTERM");
    expect(await exit).toBe(0);
  });
});

describe("hardening is the first statement of the entry point", () => {
  it("has no static value imports and dynamically loads upstream only after hardening", () => {
    const source = fs.readFileSync(CLI_SOURCE, "utf8");
    const hardeningIndex = source.indexOf("applyProcessHardening(process.env)");
    expect(hardeningIndex).toBeGreaterThan(-1);

    // Only `import type …` may be static: TypeScript erases it, so the module
    // graph is empty until the hardening statement has run.
    const staticValueImports = [
      ...source.matchAll(/^import\s+(?!type\b)([^;]+);/gmu),
    ].map((match) => match[1].trim());
    expect(staticValueImports).toEqual([]);

    // Every dynamic import except the hardening module itself comes later.
    const dynamicImports = [...source.matchAll(/import\(\s*"([^"]+)"\s*\)/gu)];
    expect(dynamicImports.length).toBeGreaterThan(0);
    for (const match of dynamicImports) {
      if (match[1] === "../config/env.js") continue;
      expect(
        match.index,
        `dynamic import of ${String(match[1])} precedes hardening`,
      ).toBeGreaterThan(hardeningIndex);
    }
  });

  it("mentions no upstream area in a static import", () => {
    const source = fs.readFileSync(CLI_SOURCE, "utf8");
    for (const line of source.split("\n")) {
      if (!/^\s*import\s+/u.test(line) || /^\s*import\s+type\b/u.test(line)) {
        continue;
      }
      expect(line).not.toMatch(/\b(agent|generation|retrieval|claims)\//u);
    }
  });
});
