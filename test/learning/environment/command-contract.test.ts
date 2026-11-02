import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_REQUIREMENT,
  resolveNode,
  satisfies,
} from "../../../scripts/with-node.mjs";

/**
 * The command contract as the acceptance harness calls it (AC-ENV-01,
 * AC-FORK-05/06/08).
 *
 * The other three environment suites spawn `scripts/*.mjs` directly; this one
 * spawns the `pnpm run` entry points the harness actually uses, because the
 * whole point of the launcher is that a command invoked through pnpm works on a
 * machine whose ambient interpreter is below `engines.node`.
 *
 * `pnpm run test:upstream` is deliberately not spawned from here: it is itself
 * the verdict command for AC-FORK-05/08, and running a ~50 s, 239-file suite
 * inside the learning suite would only double the work. The static half of that
 * AC (no `.only`, and no command dirtying the working tree) is asserted below.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PINNED_COMMIT = "7bb583d664f2d1c2484fa44b9d591f6103ca8166";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: string[],
  timeout = 300_000,
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd: REPO_ROOT, env: process.env, timeout },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** `git status --porcelain` for the worktree, newline-joined and trimmed. */
async function porcelain(): Promise<string> {
  const result = await run("git", ["status", "--porcelain"], 60_000);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function listFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path.join(REPO_ROOT, relative), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        found.push(child);
      }
    }
  };
  await walk(directory);
  return found.sort();
}

describe("pnpm run env:check (AC-ENV-01)", () => {
  it("exits 0 and reports the pinned toolchain through the pnpm entry point", async () => {
    const result = await run("pnpm", ["run", "--silent", "env:check"]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const report = JSON.parse(result.stdout) as {
      node: string;
      pnpm: string;
      sqliteFts5: string;
      upstreamCommit: string;
      nodeVersion: string;
      resolvedNode: string | null;
      resolvedVia: string | null;
    };

    expect(report.node).toBe("ok");
    expect(report.pnpm).toBe("ok");
    expect(report.sqliteFts5).toBe("ok");
    expect(report.upstreamCommit).toBe(PINNED_COMMIT);
    // The report must carry a plain semver, not `v24.13.0` or a range, and it
    // must clear the floor — this is the field the AC compares.
    expect(report.nodeVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(satisfies(report.nodeVersion, DEFAULT_REQUIREMENT)).toBe(true);
    expect(report.resolvedNode).toBe(resolveNode().bin);
    expect(report.resolvedVia).toBeTruthy();
  });
});

describe("no focused tests (AC-FORK-05)", () => {
  it("has no `.only` in the test tree, which would silently skip the rest", async () => {
    const files = (await listFiles("test")).filter(
      (relative) =>
        relative.endsWith(".test.ts") ||
        relative.endsWith(".test.tsx") ||
        relative.endsWith(".spec.ts") ||
        relative.endsWith(".spec.tsx"),
    );

    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const relative of files) {
      const text = await readFile(path.join(REPO_ROOT, relative), "utf8");
      text.split(/\r?\n/u).forEach((line, index) => {
        if (/\.only\s*\(/u.test(line)) {
          offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});

describe("typecheck and tree hygiene (AC-FORK-06/08)", () => {
  it("type-checks both projects through pnpm and leaves the working tree unchanged", async () => {
    const before = await porcelain();

    const result = await run("pnpm", ["run", "--silent", "typecheck"]);

    expect(result.code, result.stderr).toBe(0);
    // Both projects run in the same command; a failure in either would surface
    // as a non-zero exit, so assert the second run actually happened too.
    expect(result.stdout + result.stderr).not.toContain("error TS");
    expect(await porcelain()).toBe(before);
  });
});
