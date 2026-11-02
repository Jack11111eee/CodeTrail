/**
 * Shell-free Git execution (architecture §5.2).
 *
 * Every Git process in the learning system starts here. `execFile` receives an
 * argument vector, so no caller value is ever interpolated into a command
 * string. The credential never enters `argv`: `GIT_ASKPASS` points at
 * `scripts/git-askpass.mjs` and the token travels in `CODETRAIL_GIT_TOKEN`,
 * which is removed from the environment unless a credential is present.
 * Anything that is returned for logging or throwing is scrubbed first.
 */

import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { GIT_TIMEOUT_MS } from "../config/defaults.js";
import { redactSecrets } from "../config/credentials.js";
import { LearningError } from "../contracts/index.js";
import type { GithubCredential } from "../contracts/index.js";

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface GitEnvOptions {
  credentials?: GithubCredential | null;
}

export interface GitOptions extends GitEnvOptions {
  /** Written to stdin and closed; used by commands that accept a patch. */
  input?: string;
  /** Additional environment entries, applied after the hardened defaults. */
  env?: NodeJS.ProcessEnv;
}

/** `scripts/git-askpass.mjs`, both from `src/` and from the compiled `dist/`. */
const ASKPASS = fileURLToPath(
  new URL("../../../scripts/git-askpass.mjs", import.meta.url),
);

/** Large enough for any diff the generation pipeline asks Git to produce. */
const MAX_BUFFER = 64 * 1024 * 1024;

/** Location variables that must never leak in from a calling hook or shell. */
const LOCATION_VARIABLES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
] as const;

function scrub(text: string, options: GitEnvOptions): string {
  return redactSecrets(text, options.credentials?.token ?? null);
}

/**
 * The environment every Git call receives.
 *
 * `CODETRAIL_GIT_TOKEN` is set **only** when a credential is supplied: an
 * inherited value from the parent process is dropped so an unauthenticated
 * clone can never silently pick up a token.
 */
export function gitEnvFor(options: GitEnvOptions = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of LOCATION_VARIABLES) {
    delete env[name];
  }
  delete env.CODETRAIL_GIT_TOKEN;

  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_LFS_SKIP_SMUDGE = "1";
  env.GIT_ASKPASS = ASKPASS;

  const token = options.credentials?.token;
  if (typeof token === "string" && token !== "") {
    env.CODETRAIL_GIT_TOKEN = token;
  }
  return env;
}

/**
 * `-c` overrides prepended to every invocation. Submodules are never fetched,
 * symlinks are never materialised (a worktree must stay inside its directory),
 * and line-ending translation is off so hashes are stable.
 */
export function gitConfigHardeningArgs(): string[] {
  return [
    "-c",
    "submodule.recurse=false",
    "-c",
    "core.symlinks=false",
    "-c",
    "core.autocrlf=false",
    "-c",
    "gc.auto=0",
    "-c",
    "advice.detachedHead=false",
  ];
}

function mergeEnvironment(options: GitOptions): NodeJS.ProcessEnv {
  const env = gitEnvFor(options);
  if (options.env !== undefined) {
    for (const [name, value] of Object.entries(options.env)) {
      if (value === undefined) {
        delete env[name];
      } else {
        env[name] = value;
      }
    }
  }
  return env;
}

/**
 * Runs Git and resolves with the result, including non-zero exits. Spawn
 * failures (for example Git not being installed) are reported as code `1`
 * instead of rejecting, so callers always have `stdout`/`stderr` to map.
 */
export function git(
  cwd: string,
  args: string[],
  options: GitOptions = {},
): Promise<GitResult> {
  const argv = [...gitConfigHardeningArgs(), ...args];
  const env = mergeEnvironment(options);
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      argv,
      {
        cwd,
        env,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const failure = error as (Error & { code?: number | string }) | null;
        const code =
          failure === null
            ? 0
            : typeof failure.code === "number"
              ? failure.code
              : 1;
        const rawStderr =
          typeof stderr === "string" && stderr !== ""
            ? stderr
            : (failure?.message ?? "");
        resolve({
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: scrub(rawStderr, options),
          code,
        });
      },
    );
    if (options.input !== undefined && child.stdin !== null) {
      child.stdin.end(options.input);
    }
  });
}

/** Synchronous variant for the few paths that must not be async (§5.1). */
export function gitSync(
  cwd: string,
  args: string[],
  options: GitEnvOptions = {},
): GitResult {
  try {
    const stdout = execFileSync("git", [...gitConfigHardeningArgs(), ...args], {
      cwd,
      env: gitEnvFor(options),
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return { stdout, stderr: "", code: 0 };
  } catch (error) {
    const failure = error as Error & {
      status?: number | null;
      stderr?: string | Buffer;
    };
    const stderr =
      typeof failure.stderr === "string"
        ? failure.stderr
        : failure.stderr instanceof Buffer
          ? failure.stderr.toString("utf8")
          : failure.message;
    return {
      stdout: "",
      stderr: scrub(stderr, options),
      code: typeof failure.status === "number" ? failure.status : 1,
    };
  }
}

/** Resolves with trimmed stdout; any non-zero exit becomes `internal_error`. */
export async function gitOrThrow(
  cwd: string,
  args: string[],
  options: GitOptions = {},
): Promise<string> {
  const result = await git(cwd, args, options);
  if (result.code !== 0) {
    throw new LearningError("internal_error", "Git 命令执行失败", {
      args,
      code: result.code,
      stderr: result.stderr,
    });
  }
  return result.stdout.trim();
}
