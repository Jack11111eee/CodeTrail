import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach } from "vitest";

/**
 * Per-test data-directory isolation (PRD §15.1, architecture §17.5).
 *
 * The learning system may write only inside `CODETRAIL_DATA_DIR`, so every
 * test gets a fresh directory under the OS temp root. Nothing may ever touch
 * the real `~/.codetrail`; `defaultDataDir()` exists so a test can assert the
 * environment was not pointed at it.
 */

export interface TempDataDir {
  /** Absolute path to the temporary data root. */
  dir: string;
  /** Environment entries that point the application at this directory. */
  env: Record<string, string>;
  /** Removes the directory tree; safe to call more than once. */
  cleanup(): void;
}

/** The production default; tests must never see it in `CODETRAIL_DATA_DIR`. */
export function defaultDataDir(): string {
  return path.join(os.homedir(), ".codetrail");
}

/** Creates one isolated data directory and returns its env mapping. */
export function createTempDataDir(prefix = "codetrail-data-"): TempDataDir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    env: { CODETRAIL_DATA_DIR: dir },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Registers `beforeEach`/`afterEach` hooks that give every test its own
 * `CODETRAIL_DATA_DIR` and remove it afterwards, restoring any previous value.
 *
 * Called from `setup/guard.ts`, so it applies to the whole learning suite.
 */
export function installPerTestDataDir(): void {
  let current: TempDataDir | null = null;
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.CODETRAIL_DATA_DIR;
    current = createTempDataDir();
    process.env.CODETRAIL_DATA_DIR = current.dir;
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.CODETRAIL_DATA_DIR;
    } else {
      process.env.CODETRAIL_DATA_DIR = previous;
    }
    current?.cleanup();
    current = null;
  });
}
