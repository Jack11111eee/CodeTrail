import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wraps `realpathSync` so a rejected static path never causes a filesystem
 * probe. The mock is hoisted above the SUT imports, so `scope.ts` binds to the
 * counting implementation.
 */
const realpathCalls = vi.hoisted(() => [] as string[]);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    realpathSync: ((...args: Parameters<typeof actual.realpathSync>) => {
      realpathCalls.push(String(args[0]));
      return actual.realpathSync(...args);
    }) as typeof actual.realpathSync,
  };
});

import {
  LearningError,
  type RepoId,
  type SnapshotRecord,
} from "../../../src/learning/contracts/index.ts";
import {
  assertReadable,
  normalizeScope,
} from "../../../src/learning/projects/scope.ts";
import { createSnapshotReader } from "../../../src/learning/projects/worktree.ts";

/**
 * AC-SEC-11: `assertReadable` is the single choke point. `..`, absolute paths,
 * out-of-scope paths and real symlink escapes all become `out_of_scope_path`,
 * and the static rejections happen before any filesystem access.
 */
describe("path sandbox", () => {
  let base: string;
  let root: string;
  let outside: string;
  const scope = normalizeScope();

  function snapshot(worktreePath: string): SnapshotRecord {
    return {
      repoId: "r_test" as RepoId,
      commitSha: "c".repeat(40),
      treeHash: "d".repeat(40),
      worktreePath,
      resolvedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  function failure(fn: () => void): LearningError {
    try {
      fn();
    } catch (error) {
      if (error instanceof LearningError) {
        return error;
      }
      throw error;
    }
    throw new Error("expected a LearningError");
  }

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-sandbox-"));
    root = path.join(base, "worktree");
    outside = path.join(base, "outside");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(root, "inside.txt"), "inside\n");
    fs.writeFileSync(path.join(outside, "secret.txt"), "outside-canary\n");
    realpathCalls.length = 0;
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("rejects `..` without touching the filesystem", () => {
    realpathCalls.length = 0;
    const error = failure(() =>
      assertReadable("../outside/secret.txt", scope, root),
    );
    expect(error.code).toBe("out_of_scope_path");
    expect(error.details).toMatchObject({ path: "../outside/secret.txt" });
    expect(realpathCalls).toEqual([]);
  });

  it("rejects absolute paths without touching the filesystem", () => {
    realpathCalls.length = 0;
    const error = failure(() =>
      assertReadable(path.join(outside, "secret.txt"), scope, root),
    );
    expect(error.code).toBe("out_of_scope_path");
    expect(realpathCalls).toEqual([]);
  });

  it("rejects out-of-scope and secret paths before probing the root", () => {
    realpathCalls.length = 0;
    const include = normalizeScope({ include: ["src/**"] });
    expect(
      failure(() => assertReadable("README.md", include, "/missing-root")).code,
    ).toBe("out_of_scope_path");
    expect(
      failure(() => assertReadable(".env", scope, "/missing-root")).code,
    ).toBe("out_of_scope_path");
    expect(
      failure(() => assertReadable("node_modules/x/index.js", scope, root))
        .code,
    ).toBe("out_of_scope_path");
    expect(realpathCalls).toEqual([]);
  });

  it("rejects a real symlink pointing outside the worktree", () => {
    fs.symlinkSync(
      path.join(outside, "secret.txt"),
      path.join(root, "escape.txt"),
    );
    realpathCalls.length = 0;
    const error = failure(() => assertReadable("escape.txt", scope, root));
    expect(error.code).toBe("out_of_scope_path");
    expect(error.details).toMatchObject({
      path: "escape.txt",
      reason: "symlink_escape",
    });
    expect(realpathCalls.length).toBeGreaterThan(0);
  });

  it("rejects traversal through a symlinked directory", () => {
    fs.symlinkSync(outside, path.join(root, "escape-dir"));
    const error = failure(() =>
      assertReadable("escape-dir/secret.txt", scope, root),
    );
    expect(error.code).toBe("out_of_scope_path");
    expect(error.details).toMatchObject({ reason: "symlink_escape" });
  });

  it("allows a symlink that stays inside the worktree", async () => {
    fs.symlinkSync(path.join(root, "inside.txt"), path.join(root, "alias.txt"));
    expect(() => assertReadable("alias.txt", scope, root)).not.toThrow();
    const reader = createSnapshotReader(snapshot(root), scope);
    await expect(reader.read("alias.txt")).resolves.toBe("inside\n");
  });

  it("enforces the sandbox through SnapshotReader.read", async () => {
    fs.symlinkSync(
      path.join(outside, "secret.txt"),
      path.join(root, "escape.txt"),
    );
    const reader = createSnapshotReader(snapshot(root), scope);

    await expect(reader.read("../outside/secret.txt")).rejects.toMatchObject({
      code: "out_of_scope_path",
    });
    await expect(
      reader.read(path.join(outside, "secret.txt")),
    ).rejects.toMatchObject({ code: "out_of_scope_path" });
    await expect(reader.read("escape.txt")).rejects.toMatchObject({
      code: "out_of_scope_path",
      details: { path: "escape.txt", reason: "symlink_escape" },
    });
    await expect(reader.exists("../outside/secret.txt")).resolves.toBe(false);
    await expect(reader.exists("escape.txt")).resolves.toBe(false);
  });
});
