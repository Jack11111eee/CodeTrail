import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import type { ChatModelLike } from "../../../src/learning/contracts/index.js";
import { createUpstreamGenerationPort } from "../../../src/learning/upstream/generation.js";
import {
  PROTECTED_WRITE_PATHS,
  snapshotProtectedHashes,
  verifyProtectedHashes,
} from "../../../src/learning/upstream/guard.js";

/**
 * Protected writes (architecture §6.5, AC-GEN-15).
 *
 * Generation runs in a throwaway build worktree, so the analysed repository is
 * safe by construction. The guard additionally proves that nothing created the
 * protected workflow or agent files: the port snapshots them before the run and
 * fails `protected_write_blocked` if a write lands, leaving the user's files
 * byte-identical.
 */

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

const README = "# User repository\n";
const AGENTS = "# Hand-written agent notes\n";
const WORKFLOW = "name: existing\non: push\n";

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: root });
  return stdout.trim();
}

async function createRepository(): Promise<{ root: string; headSha: string }> {
  const root = await temporaryDirectory("codetrail-protected-repo-");
  await git(root, ["init", "--quiet"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Protected Write Test"]);
  await writeFile(path.join(root, "README.md"), README, "utf8");
  await writeFile(path.join(root, "AGENTS.md"), AGENTS, "utf8");
  await mkdir(path.join(root, ".github/workflows"), { recursive: true });
  await writeFile(
    path.join(root, ".github/workflows/x.yml"),
    WORKFLOW,
    "utf8",
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "--quiet", "-m", "initial"]);
  return { root, headSha: await git(root, ["rev-parse", "HEAD"]) };
}

async function createBuildWorktree(
  repositoryRoot: string,
  sha: string,
): Promise<string> {
  const parent = await temporaryDirectory("codetrail-protected-build-");
  const buildPath = path.join(parent, "tree");
  await git(repositoryRoot, ["worktree", "add", "--detach", buildPath, sha]);
  return buildPath;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("protected write guard", () => {
  test.each([
    {
      label: "README.md",
      target: "README.md",
      write: async (root: string) => {
        await writeFile(path.join(root, "README.md"), "rewritten", "utf8");
      },
    },
    {
      label: "AGENTS.md",
      target: "AGENTS.md",
      write: async (root: string) => {
        await writeFile(path.join(root, "AGENTS.md"), "generated", "utf8");
      },
    },
    {
      label: ".github/workflows/x.yml",
      target: ".github/workflows/x.yml",
      write: async (root: string) => {
        await mkdir(path.join(root, ".github/workflows"), { recursive: true });
        await writeFile(
          path.join(root, ".github/workflows/x.yml"),
          "name: rewritten\n",
          "utf8",
        );
      },
    },
  ])("blocks an upstream write to $label", async ({ target, write }) => {
    const repository = await createRepository();
    const buildWorktree = await createBuildWorktree(
      repository.root,
      repository.headSha,
    );
    const userHashesBefore = await snapshotProtectedHashes(repository.root);

    const port = createUpstreamGenerationPort({
      run: async (options) => {
        await write(options.root);
        return { skipped: false };
      },
    });

    await expect(
      port.run({
        worktreePath: buildWorktree,
        mode: "init",
        language: "zh",
        modelId: "test-model",
        model: {} as unknown as ChatModelLike,
        writeRepoFiles: false,
      }),
    ).rejects.toMatchObject({
      code: "protected_write_blocked",
      details: { path: target },
    });

    // The write landed in the throwaway build worktree, so the guard had
    // something to detect — but the analysed repository is byte-identical.
    expect(await snapshotProtectedHashes(repository.root)).toEqual(
      userHashesBefore,
    );
    expect(await readFile(path.join(repository.root, "README.md"), "utf8")).toBe(
      README,
    );
    expect(await readFile(path.join(repository.root, "AGENTS.md"), "utf8")).toBe(
      AGENTS,
    );
    expect(
      await readFile(
        path.join(repository.root, ".github/workflows/x.yml"),
        "utf8",
      ),
    ).toBe(WORKFLOW);
  });

  test("detects a newly created protected file", async () => {
    const worktree = await temporaryDirectory("codetrail-protected-new-");
    const before = await snapshotProtectedHashes(worktree);
    expect(before["AGENTS.md"]).toBe("");

    await writeFile(path.join(worktree, "AGENTS.md"), "created", "utf8");

    await expect(verifyProtectedHashes(before, worktree)).resolves.toEqual({
      blocked: "AGENTS.md",
    });
  });

  test("lists every protected path the guard covers", () => {
    expect(PROTECTED_WRITE_PATHS).toEqual(
      expect.arrayContaining([
        "README.md",
        "AGENTS.md",
        "CLAUDE.md",
        ".github/workflows/**",
        ".gitmodules",
        ".gitattributes",
      ]),
    );
  });

  test("leaves a clean run untouched", async () => {
    const repository = await createRepository();
    const buildWorktree = await createBuildWorktree(
      repository.root,
      repository.headSha,
    );
    const port = createUpstreamGenerationPort({
      run: () => Promise.resolve({ skipped: true }),
    });
    const before = await snapshotProtectedHashes(repository.root);

    await expect(
      port.run({
        worktreePath: buildWorktree,
        mode: "update",
        language: "zh",
        modelId: "test-model",
        model: {} as unknown as ChatModelLike,
        writeRepoFiles: false,
      }),
    ).resolves.toEqual({ skipped: true, sourceChanged: false });
    expect(await snapshotProtectedHashes(repository.root)).toEqual(before);
  });
});
