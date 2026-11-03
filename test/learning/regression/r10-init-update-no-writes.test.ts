/**
 * AC-R10-01: neither entry point writes into the analysed checkout. Init and
 * update run through the production upstream port (`createUpstreamGenerationPort`
 * -> `ensureCodeModeRepoSetup`) with `writeRepoFiles: false`, so no CI workflow,
 * `AGENTS.md` or `CLAUDE.md` appears and both the user repository and the build
 * worktree hash the same before and after.
 */
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { UpstreamGenerationPort } from "../../../src/learning/contracts/index.ts";
import { workingTreeHash } from "../../../src/learning/upstream/guard.ts";
import { createUpstreamGenerationPort } from "../../../src/learning/upstream/generation.ts";
import { ensureCodeModeRepoSetup } from "../../../src/ingestion/code-mode.ts";
import {
  createGitRepositoryAt,
  createHarness,
  generationInput,
  runToCompletion,
  type Harness,
} from "../generation/harness.ts";

const WORKFLOW = ".github/workflows/openwiki-update.yml";
const AGENT_FILES = ["AGENTS.md", "CLAUDE.md"];

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

function relativeFiles(root: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path.join(root, prefix), {
    withFileTypes: true,
  })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...relativeFiles(root, relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files.sort();
}

describe("AC-R10-01 — init and update write nothing", () => {
  it("leaves no workflow or agent files and keeps the analysed tree stable", async () => {
    const dataDir = process.env.CODETRAIL_DATA_DIR!;
    const repoRoot = mkdtempSync(path.join(dataDir, "r10-repo-"));
    const shas = await createGitRepositoryAt(repoRoot, ["base", "head"]);

    const writeFlags: boolean[] = [];
    const worktreeHashes: boolean[] = [];
    const analysedFiles: string[][] = [];
    const upstream: UpstreamGenerationPort = createUpstreamGenerationPort({
      run: async (options) => {
        writeFlags.push(options.writeRepoFiles === false);
        const hashBefore = await workingTreeHash(options.root);
        await ensureCodeModeRepoSetup(options.root, {
          createWorkflow: true,
          writeRepoFiles: options.writeRepoFiles,
        });
        const hashAfter = await workingTreeHash(options.root);
        worktreeHashes.push(hashBefore === hashAfter);
        analysedFiles.push(relativeFiles(options.root));
        return { skipped: false, sourceChanged: true };
      },
    });

    const harness = await createHarness({
      mirrorPath: repoRoot,
      commits: shas,
      upstream,
    });
    harnesses.push(harness);

    const userTreeBefore = await workingTreeHash(repoRoot);
    const userFilesBefore = relativeFiles(repoRoot);

    const init = await runToCompletion(
      harness,
      generationInput(harness, { sha: shas[0] }),
    );
    expect(init.state).toBe("completed");
    const update = await runToCompletion(
      harness,
      generationInput(harness, {
        sha: shas[1],
        mode: "update",
        baselineFromGenerationId: init.outputGenerationId,
      }),
    );
    expect(update.state).toBe("completed");

    // Both entry points forwarded the read-only flag and wrote nothing into the
    // analysed build worktree.
    expect(writeFlags).toEqual([true, true]);
    expect(worktreeHashes).toEqual([true, true]);
    for (const files of analysedFiles) {
      expect(files).not.toContain(WORKFLOW);
      expect(files.some((file) => file.startsWith(".github/"))).toBe(false);
      for (const agentFile of AGENT_FILES) {
        expect(files).not.toContain(agentFile);
      }
    }

    // The user's repository is byte-identical (Git's own worktree bookkeeping
    // under `.git/` is not source content and is excluded).
    const sourceFiles = (files: string[]): string[] =>
      files.filter((file) => !file.startsWith(".git/"));
    expect(await workingTreeHash(repoRoot)).toBe(userTreeBefore);
    expect(sourceFiles(relativeFiles(repoRoot))).toEqual(
      sourceFiles(userFilesBefore),
    );
    expect(existsSync(path.join(repoRoot, WORKFLOW))).toBe(false);
    expect(existsSync(path.join(repoRoot, ".github"))).toBe(false);
    for (const agentFile of AGENT_FILES) {
      expect(existsSync(path.join(repoRoot, agentFile))).toBe(false);
    }
  }, 120_000);
});
