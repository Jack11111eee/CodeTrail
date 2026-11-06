import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { LearningError } from "../../../src/learning/contracts/index.ts";
import type {
  ExternalDocService,
  GenerationId,
  RepoId,
} from "../../../src/learning/contracts/index.ts";
import { createSourceReader } from "../../../src/learning/evidence/registry.ts";
import { createUpstreamGenerationPort } from "../../../src/learning/upstream/generation.ts";
import {
  assertNoRepoMutation,
  assertTreeUnchanged,
  snapshotProtectedHashes,
  verifyProtectedHashes,
} from "../../../src/learning/upstream/guard.ts";
import {
  DEFAULT_SCOPE,
  HEAD_SHA,
  createEvidenceHarness,
  fakeSnapshot,
} from "../retrieval/evidence-harness.ts";

/**
 * Integration: upstream write/drift guard (issue-13) + evidence source reader
 * (issue-14), on a real Git worktree.
 *
 * The publish pipeline has two independent drift checks: the upstream guard
 * hashes the working tree before/after generation, and the evidence reader
 * re-verifies a registered ref's `contentHash`. They must agree on the same
 * failure vocabulary (`source_drift`) for the same change, while generated
 * `openwiki/**` output must never count as drift.
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

interface DriftFixture {
  repository: string;
  buildWorktree: string;
  treeHash: string;
}

async function createFixture(): Promise<DriftFixture> {
  const repository = await temporaryDirectory("codetrail-int-repo-");
  await git(repository, ["init", "--quiet"]);
  await git(repository, ["config", "user.email", "test@example.com"]);
  await git(repository, ["config", "user.name", "Integration Test"]);
  await writeFile(path.join(repository, "app.ts"), "export const v = 1;\n", "utf8");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "--quiet", "-m", "initial"]);

  const headSha = await git(repository, ["rev-parse", "HEAD"]);
  const treeHash = await git(repository, ["rev-parse", `${headSha}^{tree}`]);
  const parent = await temporaryDirectory("codetrail-int-build-");
  const buildWorktree = path.join(parent, "tree");
  await git(repository, ["worktree", "add", "--detach", buildWorktree, headSha]);

  return { repository, buildWorktree, treeHash };
}

async function driftCode(run: () => Promise<void>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof LearningError ? error.code : String(error);
  }
}

const noExternalDocs: ExternalDocService = {
  fetchExact: () =>
    Promise.resolve({
      ok: false,
      status: "source_missing",
      reason: "not_found",
    }),
  cached: () => Promise.resolve(null),
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("upstream guard × evidence drift", () => {
  it("hashes the clean worktree to the commit tree and ignores generated openwiki output", async () => {
    const fixture = await createFixture();
    const port = createUpstreamGenerationPort();

    await expect(port.treeHashOfWorktree(fixture.buildWorktree)).resolves.toBe(
      fixture.treeHash,
    );
    await expect(
      assertTreeUnchanged(fixture.buildWorktree, fixture.treeHash),
    ).resolves.toBeUndefined();

    // The run legitimately writes `openwiki/**`; that is not source drift.
    await mkdir(path.join(fixture.buildWorktree, "openwiki"), {
      recursive: true,
    });
    await writeFile(
      path.join(fixture.buildWorktree, "openwiki", "intro.md"),
      "---\ntype: Guide\ntitle: Intro\n---\n\n# Intro\n",
      "utf8",
    );
    await expect(
      assertTreeUnchanged(fixture.buildWorktree, fixture.treeHash),
    ).resolves.toBeUndefined();
  });

  it("reports the same source_drift code as the evidence reader for the same source change", async () => {
    const fixture = await createFixture();
    const harness = await createEvidenceHarness();
    const changedText = "export const v = 2;\n";

    try {
      const ref = await harness.registry.registerRepo({
        generationId: "g_1" as GenerationId,
        repoId: "r_1" as RepoId,
        commitSha: HEAD_SHA,
        path: "app.ts",
        lines: null,
        snapshot: fakeSnapshot(
          { "app.ts": "export const v = 1;\n" },
          { commitSha: HEAD_SHA },
        ),
        scope: DEFAULT_SCOPE,
      });

      // Guard half: mutate the build worktree source.
      await writeFile(
        path.join(fixture.buildWorktree, "app.ts"),
        changedText,
        "utf8",
      );
      const guardCode = await driftCode(() =>
        assertTreeUnchanged(fixture.buildWorktree, fixture.treeHash),
      );
      expect(guardCode).toBe("source_drift");

      // Evidence half: the reader sees the same changed bytes for the same ref.
      const reader = createSourceReader({
        snapshotFor: () =>
          fakeSnapshot({ "app.ts": changedText }, { commitSha: HEAD_SHA }),
        external: noExternalDocs,
      });
      const readerCode = await driftCode(async () => {
        await reader.readRepo(ref, DEFAULT_SCOPE);
      });
      expect(readerCode).toBe("source_drift");
      expect(readerCode).toBe(guardCode);

      // Unchanged content still reads exactly.
      const stableReader = createSourceReader({
        snapshotFor: () =>
          fakeSnapshot(
            { "app.ts": "export const v = 1;\n" },
            { commitSha: HEAD_SHA },
          ),
        external: noExternalDocs,
      });
      await expect(stableReader.readRepo(ref, DEFAULT_SCOPE)).resolves.toBe(
        "export const v = 1;\n",
      );
    } finally {
      harness.close();
    }
  });

  it("detects a write to the user's checkout with the same drift error", async () => {
    const fixture = await createFixture();

    await expect(
      assertNoRepoMutation(fixture.repository, fixture.treeHash),
    ).resolves.toBeUndefined();

    await writeFile(
      path.join(fixture.repository, "app.ts"),
      "export const v = 2;\n",
      "utf8",
    );
    const code = await driftCode(() =>
      assertNoRepoMutation(fixture.repository, fixture.treeHash),
    );
    expect(code).toBe("source_drift");
  });

  it("flags protected-path creation (agent files and workflows) but not openwiki", async () => {
    const fixture = await createFixture();
    const before = await snapshotProtectedHashes(fixture.buildWorktree);

    await mkdir(path.join(fixture.buildWorktree, ".github", "workflows"), {
      recursive: true,
    });
    await writeFile(
      path.join(fixture.buildWorktree, ".github", "workflows", "x.yml"),
      "name: injected\n",
      "utf8",
    );
    await writeFile(
      path.join(fixture.buildWorktree, "AGENTS.md"),
      "# injected\n",
      "utf8",
    );
    await mkdir(path.join(fixture.buildWorktree, "openwiki"), {
      recursive: true,
    });
    await writeFile(
      path.join(fixture.buildWorktree, "openwiki", "page.md"),
      "# allowed\n",
      "utf8",
    );

    const violation = await verifyProtectedHashes(
      before,
      fixture.buildWorktree,
    );
    expect(violation.blocked).toMatch(/^(?:\.github\/workflows\/x\.yml|AGENTS\.md)$/u);
    expect(violation.blocked).not.toContain("openwiki");

    // README.md is protected too: an upstream attempt to rewrite it is caught.
    const afterAgents = await snapshotProtectedHashes(fixture.buildWorktree);
    await writeFile(
      path.join(fixture.buildWorktree, "README.md"),
      "# rewritten by upstream\n",
      "utf8",
    );
    const readmeViolation = await verifyProtectedHashes(
      afterAgents,
      fixture.buildWorktree,
    );
    expect(readmeViolation.blocked).toBe("README.md");
    expect(await readFile(path.join(fixture.repository, "app.ts"), "utf8")).toBe(
      "export const v = 1;\n",
    );
  });
});
