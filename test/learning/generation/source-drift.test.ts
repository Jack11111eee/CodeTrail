import { execFile } from "node:child_process";
import {
  lstat,
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

import { resolveDataPaths } from "../../../src/learning/config/paths.js";
import { createUpstreamGenerationPort } from "../../../src/learning/upstream/generation.js";
import {
  assertNoRepoMutation,
  assertTreeUnchanged,
} from "../../../src/learning/upstream/guard.js";

/**
 * Source drift (architecture §6.5, AC-GEN-17).
 *
 * The build worktree starts at the target commit, so its working-tree hash
 * equals `git rev-parse <sha>^{tree}`. Any write to the source portion changes
 * that hash; `assertTreeUnchanged` fails `source_drift` before a publisher can
 * create a knowledge directory.
 */

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: root });
  return stdout.trim();
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

interface DriftFixture {
  repository: string;
  buildWorktree: string;
  expectedTreeHash: string;
}

async function createFixture(
  options: { withOpenwiki?: boolean } = {},
): Promise<DriftFixture> {
  const repository = await temporaryDirectory("codetrail-drift-repo-");
  await git(repository, ["init", "--quiet"]);
  await git(repository, ["config", "user.email", "test@example.com"]);
  await git(repository, ["config", "user.name", "Drift Test"]);
  await writeFile(path.join(repository, "app.ts"), "export const v = 1;\n", "utf8");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "--quiet", "-m", "initial"]);
  if (options.withOpenwiki === true) {
    await mkdir(path.join(repository, "openwiki"), { recursive: true });
    await writeFile(
      path.join(repository, "openwiki", "page.md"),
      "---\ntype: Guide\ntitle: Guide\n---\n\n# Guide\n",
      "utf8",
    );
    await git(repository, ["add", "."]);
    await git(repository, ["commit", "--quiet", "-m", "wiki"]);
  }
  const headSha = await git(repository, ["rev-parse", "HEAD"]);
  const expectedTreeHash = await git(repository, ["rev-parse", `${headSha}^{tree}`]);

  const parent = await temporaryDirectory("codetrail-drift-build-");
  const buildWorktree = path.join(parent, "tree");
  await git(repository, ["worktree", "add", "--detach", buildWorktree, headSha]);

  return { repository, buildWorktree, expectedTreeHash };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("source drift", () => {
  test("a clean build worktree hashes to the target commit tree", async () => {
    const fixture = await createFixture();
    const port = createUpstreamGenerationPort();

    await expect(
      port.treeHashOfWorktree(fixture.buildWorktree),
    ).resolves.toBe(fixture.expectedTreeHash);
    await expect(
      assertTreeUnchanged(fixture.buildWorktree, fixture.expectedTreeHash),
    ).resolves.toBeUndefined();
    await expect(
      assertNoRepoMutation(fixture.repository, fixture.expectedTreeHash),
    ).resolves.toBeUndefined();
  });

  test("ignores newly generated openwiki output", async () => {
    const fixture = await createFixture();
    const port = createUpstreamGenerationPort();

    await mkdir(path.join(fixture.buildWorktree, "openwiki"), {
      recursive: true,
    });
    await writeFile(
      path.join(fixture.buildWorktree, "openwiki", "generated.md"),
      "# Generated\n",
      "utf8",
    );

    await expect(
      port.treeHashOfWorktree(fixture.buildWorktree),
    ).resolves.toBe(fixture.expectedTreeHash);
    await expect(
      assertTreeUnchanged(fixture.buildWorktree, fixture.expectedTreeHash),
    ).resolves.toBeUndefined();
  });

  test("ignores changes to a committed openwiki page", async () => {
    const fixture = await createFixture({ withOpenwiki: true });
    const port = createUpstreamGenerationPort();

    await writeFile(
      path.join(fixture.buildWorktree, "openwiki", "page.md"),
      "# Rewritten by generation\n",
      "utf8",
    );

    await expect(
      port.treeHashOfWorktree(fixture.buildWorktree),
    ).resolves.toBe(fixture.expectedTreeHash);
    await expect(
      assertTreeUnchanged(fixture.buildWorktree, fixture.expectedTreeHash),
    ).resolves.toBeUndefined();
  });

  test.each([
    {
      label: "an untracked source file",
      drift: async (buildWorktree: string) => {
        await mkdir(path.join(buildWorktree, "src"), { recursive: true });
        await writeFile(
          path.join(buildWorktree, "src", "drift.ts"),
          "export const drift = true;\n",
          "utf8",
        );
      },
    },
    {
      label: "a modified tracked file",
      drift: async (buildWorktree: string) => {
        await writeFile(
          path.join(buildWorktree, "app.ts"),
          "export const v = 999;\n",
          "utf8",
        );
      },
    },
  ])("fails source_drift after $label and publishes nothing", async ({
    drift,
  }) => {
    const fixture = await createFixture();
    const port = createUpstreamGenerationPort();

    await drift(fixture.buildWorktree);

    await expect(
      port.treeHashOfWorktree(fixture.buildWorktree),
    ).resolves.not.toBe(fixture.expectedTreeHash);

    let published = false;
    const publishIfClean = async (): Promise<void> => {
      await assertTreeUnchanged(fixture.buildWorktree, fixture.expectedTreeHash);
      published = true;
    };
    await expect(publishIfClean()).rejects.toMatchObject({
      code: "source_drift",
    });
    expect(published).toBe(false);
    expect(
      await exists(path.join(resolveDataPaths(process.env).knowledge)),
    ).toBe(false);

    // Drift in the throwaway build worktree never touches the user's checkout.
    await expect(
      assertNoRepoMutation(fixture.repository, fixture.expectedTreeHash),
    ).resolves.toBeUndefined();
    expect(await readFile(path.join(fixture.repository, "app.ts"), "utf8")).toBe(
      "export const v = 1;\n",
    );
  });

  test("assertNoRepoMutation fails when the user repository changes", async () => {
    const fixture = await createFixture();
    await writeFile(
      path.join(fixture.repository, "app.ts"),
      "export const v = 2;\n",
      "utf8",
    );

    await expect(
      assertNoRepoMutation(fixture.repository, fixture.expectedTreeHash),
    ).rejects.toMatchObject({ code: "source_drift" });
  });
});
