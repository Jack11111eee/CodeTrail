/**
 * The credential store (architecture §11 "secrets", §5.2, §12.1).
 *
 * A GitHub token lives in exactly two places: `credentials.json` inside the data
 * directory (written 0600, atomically) or `CODETRAIL_GITHUB_TOKEN`. It is never
 * put in the database, a log line, a lesson, a backup or an HTTP response.
 *
 * The returned `GithubCredential` keeps `token` non-enumerable, so
 * `JSON.stringify(credential)`, `console.log(credential)` and `String(credential)`
 * cannot leak it while `git`/HTTP consumers can still read `credential.token`.
 * `redactSecrets` scrubs a token out of any text that is about to be logged or
 * thrown.
 */

import fs from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { LearningError } from "../contracts/index.js";
import type { DataPaths, GithubCredential } from "../contracts/index.js";

export type { GithubCredential };

/** Replacement text used by {@link redactSecrets}. */
export const REDACTED = "[redacted]";

/** Shorter values are ignored: replacing them would mangle unrelated text. */
const MIN_SECRET_LENGTH = 4;

interface StoredCredential {
  kind: "token";
  token: string;
  login: string | null;
}

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

function isStoredCredential(value: unknown): value is StoredCredential {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === "token" &&
    typeof record.token === "string" &&
    record.token !== "" &&
    (record.login === null || typeof record.login === "string")
  );
}

/** Builds a credential whose `token` never shows up in serialisation or logs. */
function makeCredential(token: string, login: string | null): GithubCredential {
  const credential = {
    kind: "token" as const,
    login,
    toJSON(): { kind: "token"; login: string | null } {
      return { kind: "token", login };
    },
    toString(): string {
      return `GithubCredential(${login ?? "anonymous"})`;
    },
    [INSPECT](): string {
      return `GithubCredential(${login ?? "anonymous"})`;
    },
  };
  Object.defineProperty(credential, "token", {
    value: token,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return credential as unknown as GithubCredential;
}

function readStoredCredential(file: string): StoredCredential | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new LearningError(
      "internal_error",
      "unable to read credentials.json",
      { cause: (error as Error).message },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LearningError(
      "invalid_input",
      "credentials.json is not valid JSON",
    );
  }
  if (!isStoredCredential(parsed)) {
    throw new LearningError(
      "invalid_input",
      "credentials.json does not hold a token credential",
    );
  }
  return parsed;
}

/**
 * Reads the credential from `paths.credentials`, falling back to
 * `CODETRAIL_GITHUB_TOKEN`. Only the data directory is ever read.
 */
export function loadCredential(
  paths: DataPaths,
  env: NodeJS.ProcessEnv,
): GithubCredential | null {
  const stored = readStoredCredential(paths.credentials);
  if (stored) return makeCredential(stored.token, stored.login);

  const fallback = env.CODETRAIL_GITHUB_TOKEN?.trim();
  if (fallback !== undefined && fallback !== "") {
    return makeCredential(fallback, null);
  }
  return null;
}

/**
 * Writes `credentials.json` atomically with mode 0600: a temp file in the data
 * root is fully written and synced, then renamed over the target.
 */
export async function saveCredential(
  paths: DataPaths,
  credential: GithubCredential,
): Promise<void> {
  const target = paths.credentials;
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const stored: StoredCredential = {
    kind: "token",
    token: credential.token,
    login: credential.login,
  };
  const temp = path.join(
    directory,
    `.credentials-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );

  let handle: FileHandle | null = null;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(stored)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temp, 0o600);
    await rename(temp, target);
    await chmod(target, 0o600);
  } catch (error) {
    if (handle !== null) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temp).catch(() => undefined);
    throw new LearningError(
      "internal_error",
      "unable to save credentials.json",
      {
        cause: (error as Error).message,
      },
    );
  }
}

/**
 * Replaces every occurrence of a secret in `text`. Accepts one secret or a
 * list; `null`/`undefined`/short entries are ignored.
 */
export function redactSecrets(
  text: string,
  secrets: string | readonly (string | null | undefined)[] | null | undefined,
): string {
  const list = typeof secrets === "string" ? [secrets] : (secrets ?? []);
  let result = text;
  for (const secret of list) {
    if (typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH) {
      result = result.split(secret).join(REDACTED);
    }
  }
  return result;
}
