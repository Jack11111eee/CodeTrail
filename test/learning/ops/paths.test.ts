import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { LearningError } from "../../../src/learning/contracts/index.js";
import type {
  GenerationId,
  JobId,
  RepoId,
} from "../../../src/learning/contracts/index.js";
import * as pathsModule from "../../../src/learning/config/paths.js";
import {
  assertInsideDataDir,
  ensureDataDir,
  knowledgePath,
  mirrorPath,
  resolveDataPaths,
  stagingKnowledgePath,
  stagingPath,
  stagingTreePath,
  worktreePath,
} from "../../../src/learning/config/paths.js";

/**
 * AC-OPS-07 (path half) and the "one build area" rule (architecture §4.2).
 *
 * Every test owns a fresh temp directory and never reads or writes
 * `~/.codetrail`. The `workspace` scan is inline because the scanner script
 * lands in a later wave.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SRC_LEARNING = path.join(REPO_ROOT, "src/learning");

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-paths-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function isUnder(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function walkTypeScript(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkTypeScript(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

const REPO_ID = "r_0123456789abcdef" as RepoId;
const GENERATION_ID = "g_fedcba9876543210" as GenerationId;
const JOB_ID = "j_0011223344556677" as JobId;
const COMMIT_SHA = "7bb583d664f2d1c2484fa44b9d591f6103ca8166";

describe("resolveDataPaths", () => {
  it("defaults to ~/.codetrail and resolves it absolutely", () => {
    const paths = resolveDataPaths({});
    expect(path.isAbsolute(paths.root)).toBe(true);
    expect(path.basename(paths.root)).toBe(".codetrail");
    expect(path.dirname(paths.root)).toBe(fs.realpathSync(os.homedir()));
  });

  it("honours CODETRAIL_DATA_DIR, trailing slashes and relative paths", () => {
    const dir = makeTempDir();
    const real = fs.realpathSync(dir);

    expect(resolveDataPaths({ CODETRAIL_DATA_DIR: dir }).root).toBe(real);
    expect(
      resolveDataPaths({ CODETRAIL_DATA_DIR: `${dir}${path.sep}` }).root,
    ).toBe(real);
    expect(
      resolveDataPaths({
        CODETRAIL_DATA_DIR: path.relative(process.cwd(), dir),
      }).root,
    ).toBe(real);
    expect(resolveDataPaths({ CODETRAIL_DATA_DIR: "   " }).root).toBe(
      resolveDataPaths({}).root,
    );
  });

  it("derives every accessor from the root", () => {
    const dir = makeTempDir();
    const paths = resolveDataPaths({ CODETRAIL_DATA_DIR: dir });
    expect(paths.db).toBe(path.join(paths.root, "db", "codetrail.sqlite"));
    expect(paths.mirrors).toBe(path.join(paths.root, "mirrors"));
    expect(paths.work).toBe(path.join(paths.root, "work"));
    expect(paths.knowledge).toBe(path.join(paths.root, "knowledge"));
    expect(paths.staging).toBe(path.join(paths.root, "staging"));
    expect(paths.external).toBe(path.join(paths.root, "external"));
    expect(paths.logs).toBe(path.join(paths.root, "logs"));
    expect(paths.backups).toBe(path.join(paths.root, "backups"));
    expect(paths.credentials).toBe(path.join(paths.root, "credentials.json"));
    expect(paths.session).toBe(path.join(paths.root, "session.json"));
    expect(paths.openwikiHome).toBe(path.join(paths.root, "openwiki-home"));
  });

  it("has exactly one build area under staging/<jobId>", () => {
    const dir = makeTempDir();
    const paths = resolveDataPaths({ CODETRAIL_DATA_DIR: dir });

    const staging = stagingPath(paths, JOB_ID);
    expect(staging).toBe(path.join(paths.root, "staging", JOB_ID));
    expect(stagingTreePath(paths, JOB_ID)).toBe(path.join(staging, "tree"));
    expect(stagingKnowledgePath(paths, JOB_ID)).toBe(
      path.join(staging, "knowledge"),
    );
    expect(isUnder(paths.root, staging)).toBe(true);
    expect(isUnder(paths.root, stagingTreePath(paths, JOB_ID))).toBe(true);
    expect(isUnder(paths.root, stagingKnowledgePath(paths, JOB_ID))).toBe(true);
  });

  it("exposes no second build-area constructor", () => {
    expect(Object.keys(pathsModule)).not.toContain("workspacePath");
    expect(Object.keys(pathsModule)).not.toContain("tempWorkspace");
  });

  it("keeps every accessor inside the root", () => {
    const dir = makeTempDir();
    const paths = resolveDataPaths({ CODETRAIL_DATA_DIR: dir });
    const values = [
      mirrorPath(paths, REPO_ID),
      worktreePath(paths, REPO_ID, COMMIT_SHA),
      knowledgePath(paths, GENERATION_ID),
      stagingPath(paths, JOB_ID),
      stagingTreePath(paths, JOB_ID),
      stagingKnowledgePath(paths, JOB_ID),
    ];
    for (const value of values) {
      expect(path.isAbsolute(value)).toBe(true);
      expect(isUnder(paths.root, value), value).toBe(true);
    }
    expect(mirrorPath(paths, REPO_ID)).toBe(
      path.join(paths.root, "mirrors", `${REPO_ID}.git`),
    );
    expect(worktreePath(paths, REPO_ID, COMMIT_SHA)).toBe(
      path.join(paths.root, "work", REPO_ID, COMMIT_SHA),
    );
    expect(knowledgePath(paths, GENERATION_ID)).toBe(
      path.join(paths.root, "knowledge", GENERATION_ID),
    );
  });

  it("rejects an id that would escape the root", () => {
    const dir = makeTempDir();
    const paths = resolveDataPaths({ CODETRAIL_DATA_DIR: dir });
    const error = capture(() => stagingPath(paths, "../escape" as JobId));
    expect(error).toBeInstanceOf(LearningError);
    expect((error as LearningError).code).toBe("invalid_input");
  });
});

describe("ensureDataDir", () => {
  it("creates every managed directory with owner-only permissions", async () => {
    const dir = makeTempDir();
    const paths = resolveDataPaths({ CODETRAIL_DATA_DIR: dir });
    await ensureDataDir(paths);
    for (const directory of [
      paths.root,
      path.dirname(paths.db),
      paths.mirrors,
      paths.work,
      paths.knowledge,
      paths.staging,
      paths.external,
      paths.logs,
      paths.backups,
      paths.openwikiHome,
    ]) {
      expect(fs.statSync(directory).isDirectory(), directory).toBe(true);
      expect(fs.statSync(directory).mode & 0o777, directory).toBe(0o700);
    }
  });
});

describe("assertInsideDataDir", () => {
  it("accepts relative and absolute paths inside the root", () => {
    const dir = makeTempDir();
    const paths = resolveDataPaths({ CODETRAIL_DATA_DIR: dir });
    const inside = path.join(paths.root, "knowledge", "x");

    expect(assertInsideDataDir(paths, "knowledge/x")).toBe(inside);
    expect(assertInsideDataDir(paths, inside)).toBe(inside);
    expect(assertInsideDataDir(paths, paths.root)).toBe(paths.root);
  });

  it("rejects .. traversal", () => {
    const dir = makeTempDir();
    const paths = resolveDataPaths({ CODETRAIL_DATA_DIR: dir });
    for (const candidate of [
      "../escape",
      "mirrors/../../escape",
      path.join(dir, "..", "escape"),
    ]) {
      const error = capture(() => assertInsideDataDir(paths, candidate));
      expect(error, candidate).toBeInstanceOf(LearningError);
      expect((error as LearningError).code).toBe("out_of_scope_path");
    }
  });

  it("rejects an absolute path outside the root", () => {
    const dir = makeTempDir();
    const paths = resolveDataPaths({ CODETRAIL_DATA_DIR: dir });
    for (const candidate of [
      "/etc/passwd",
      path.join(os.tmpdir(), "elsewhere"),
    ]) {
      const error = capture(() => assertInsideDataDir(paths, candidate));
      expect(error, candidate).toBeInstanceOf(LearningError);
      expect((error as LearningError).code).toBe("out_of_scope_path");
    }
  });

  it("rejects a symlink that leaves the root", () => {
    const dir = makeTempDir();
    const outside = makeTempDir();
    const paths = resolveDataPaths({ CODETRAIL_DATA_DIR: dir });
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
    fs.symlinkSync(outside, path.join(dir, "link"));

    const error = capture(() => assertInsideDataDir(paths, "link/secret.txt"));
    expect(error).toBeInstanceOf(LearningError);
    expect((error as LearningError).code).toBe("out_of_scope_path");
    expect((error as LearningError).details?.reason).toBe("symlink_escape");
  });

  it("rejects a dangling symlink that points outside the root", () => {
    const dir = makeTempDir();
    const outside = makeTempDir();
    const paths = resolveDataPaths({ CODETRAIL_DATA_DIR: dir });
    fs.symlinkSync(
      path.join(outside, "not-yet-created"),
      path.join(dir, "dangling"),
    );

    const error = capture(() => assertInsideDataDir(paths, "dangling"));
    expect(error).toBeInstanceOf(LearningError);
    expect((error as LearningError).code).toBe("out_of_scope_path");
    expect((error as LearningError).details?.reason).toBe("dangling_symlink");
  });

  it("rejects a dangling symlink in the middle of the path", () => {
    const dir = makeTempDir();
    const outside = makeTempDir();
    const paths = resolveDataPaths({ CODETRAIL_DATA_DIR: dir });
    fs.symlinkSync(
      path.join(outside, "not-yet-created"),
      path.join(dir, "dangling"),
    );

    const error = capture(() =>
      assertInsideDataDir(paths, "dangling/child/file.txt"),
    );
    expect(error).toBeInstanceOf(LearningError);
    expect((error as LearningError).code).toBe("out_of_scope_path");
    expect((error as LearningError).details?.reason).toBe("dangling_symlink");
  });

  it("follows a symlink that stays inside the root", () => {
    const dir = makeTempDir();
    const paths = resolveDataPaths({ CODETRAIL_DATA_DIR: dir });
    fs.mkdirSync(path.join(dir, "logs"));
    fs.symlinkSync(path.join(dir, "logs"), path.join(dir, "logs-link"));

    expect(assertInsideDataDir(paths, "logs-link/app.log")).toBe(
      path.join(paths.root, "logs", "app.log"),
    );
  });

  it("rejects an empty candidate", () => {
    const paths = resolveDataPaths({ CODETRAIL_DATA_DIR: makeTempDir() });
    const error = capture(() => assertInsideDataDir(paths, ""));
    expect(error).toBeInstanceOf(LearningError);
    expect((error as LearningError).code).toBe("out_of_scope_path");
  });
});

describe("one build area in the source tree", () => {
  it("contains no workspace path literal under src/learning", () => {
    const violations: string[] = [];
    for (const file of walkTypeScript(SRC_LEARNING)) {
      const relative = path.relative(SRC_LEARNING, file);
      const source = fs.readFileSync(file, "utf8");
      if (/["'`](?:\.\/)?workspace(?:\/[^"'`]*)?["'`]/u.test(source)) {
        violations.push(`${relative}: workspace path literal`);
      }
      if (/\bworkspacePath\b|\btempWorkspace\b/u.test(source)) {
        violations.push(`${relative}: removed build-area accessor`);
      }
      if (/\/workspace(?:\/|["'`])/u.test(source)) {
        violations.push(`${relative}: workspace path segment`);
      }
      if (relative.split(path.sep).some((part) => part.includes("workspace"))) {
        violations.push(`${relative}: workspace in the file name`);
      }
    }
    expect(violations).toEqual([]);
  });
});
