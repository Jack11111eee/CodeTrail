import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { PROMPT_TEMPLATE_VERSION, UPSTREAM_VERSION } from "../../../src/learning/config/defaults.js";
import { resolveDataPaths } from "../../../src/learning/config/paths.js";
import type { BaselineSource } from "../../../src/learning/upstream/baseline.js";
import {
  materializeBaseline,
  planBaseline,
} from "../../../src/learning/upstream/baseline.js";
import type { GenerationId } from "../../../src/learning/contracts/index.js";

/**
 * Baseline planning and materialisation (architecture §6.4, AC-R10-02).
 *
 * One sealed fixture per failing check proves `planBaseline` never throws and
 * names the exact incompatibility; the happy path proves a compatible baseline
 * is returned with its knowledge directory. Materialisation must copy
 * `openwiki/**` while never copying `.run.json` (PRD §6.1 item 5).
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

interface FixtureRepository {
  root: string;
  baseSha: string;
  headSha: string;
}

async function createFixtureRepository(): Promise<FixtureRepository> {
  const root = await temporaryDirectory("codetrail-baseline-repo-");
  await git(root, ["init", "--quiet"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Baseline Test"]);
  // A unique byte keeps two fixture repositories from minting identical commits
  // (same tree, author and second), which would defeat the not-ancestor case.
  const marker = randomUUID();
  await writeFile(
    path.join(root, "app.ts"),
    `export const v = "${marker}";\n`,
    "utf8",
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "--quiet", "-m", "base"]);
  const baseSha = await git(root, ["rev-parse", "HEAD"]);
  await writeFile(
    path.join(root, "app.ts"),
    `export const v = "${marker}:2";\n`,
    "utf8",
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "--quiet", "-m", "head"]);
  const headSha = await git(root, ["rev-parse", "HEAD"]);
  return { root, baseSha, headSha };
}

interface KnowledgeOverrides {
  metadata?: Partial<{
    commitSha: string;
    upstreamVersion: string;
    promptTemplateVersion: string;
    language: string;
  }>;
  manifest?: unknown;
  claims?: unknown;
  pageContent?: string;
  runState?: string;
}

interface KnowledgeFixture {
  generationId: GenerationId;
  knowledgeDir: string;
}

async function listFiles(
  directory: string,
  relative = "",
): Promise<string[]> {
  const entries = await readdir(path.join(directory, relative), {
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries) {
    const candidate = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(directory, candidate)));
    } else if (entry.isFile()) {
      files.push(candidate);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

/** Writes `seal.json` for every current file except the seal itself. */
async function sealKnowledge(
  knowledgeDir: string,
  generationId: GenerationId,
): Promise<void> {
  const files = (await listFiles(knowledgeDir)).filter(
    (file) => file !== "seal.json",
  );
  const entries = [];
  for (const file of files) {
    const content = await readFile(path.join(knowledgeDir, file));
    entries.push({
      path: file,
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: content.byteLength,
    });
  }
  const treeHash = `sha256:${createHash("sha256")
    .update(entries.map((entry) => `${entry.path}\0${entry.sha256}\n`).join(""))
    .digest("hex")}`;
  await writeFile(
    path.join(knowledgeDir, "seal.json"),
    `${JSON.stringify(
      { schemaVersion: 1, generationId, treeHash, files: entries },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

/**
 * Creates a sealed `knowledge/<generationId>` fixture. Content is written before
 * sealing, so an intentionally invalid check fails for its own reason rather
 * than for a stale seal hash.
 */
async function writeKnowledgeFixture(
  overrides: KnowledgeOverrides = {},
): Promise<KnowledgeFixture> {
  const generationId = `g_${randomUUID().replace(/-/gu, "")}` as GenerationId;
  const knowledgeDir = path.join(
    resolveDataPaths(process.env).knowledge,
    generationId,
  );
  const wikiDir = path.join(knowledgeDir, "openwiki");
  await mkdir(path.join(wikiDir, ".claims"), { recursive: true });

  await writeFile(
    path.join(wikiDir, "guide.md"),
    overrides.pageContent ??
      "---\ntype: Guide\ntitle: 指南\n---\n\n# 指南\n\n内容。\n",
    "utf8",
  );
  await writeFile(
    path.join(wikiDir, ".page-manifest.json"),
    `${JSON.stringify(overrides.manifest ?? { schemaVersion: 1, pages: {} })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(wikiDir, ".claims", "guide.json"),
    `${JSON.stringify(
      overrides.claims ?? {
        schemaVersion: 1,
        pageVersion: `sha256:${"a".repeat(64)}`,
        claims: [],
      },
    )}\n`,
    "utf8",
  );
  await writeFile(
    path.join(wikiDir, ".last-update.json"),
    `${JSON.stringify({
      updatedAt: "2026-11-01T00:00:00.000Z",
      command: "init",
      model: "test-model",
      status: "complete",
      language: "zh",
    })}\n`,
    "utf8",
  );
  if (overrides.runState !== undefined) {
    await writeFile(
      path.join(wikiDir, ".run.json"),
      overrides.runState,
      "utf8",
    );
  }

  await writeFile(
    path.join(knowledgeDir, "generation.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      generationId,
      promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
      upstreamVersion: UPSTREAM_VERSION,
      language: "zh",
      ...(overrides.metadata ?? {}),
    })}\n`,
    "utf8",
  );

  await sealKnowledge(knowledgeDir, generationId);
  return { generationId, knowledgeDir };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("planBaseline", () => {
  test("accepts a compatible ancestor baseline", async () => {
    const repo = await createFixtureRepository();
    const fixture = await writeKnowledgeFixture({
      metadata: { commitSha: repo.baseSha },
    });

    await expect(
      planBaseline({
        candidate: fixture.generationId,
        targetSha: repo.headSha,
        language: "zh",
        repoPath: repo.root,
      }),
    ).resolves.toEqual({
      usable: true,
      source: {
        generationId: fixture.generationId,
        knowledgeDir: fixture.knowledgeDir,
        commitSha: repo.baseSha,
      },
    });
  });

  test("reports no_baseline when there is no candidate", async () => {
    const repo = await createFixtureRepository();
    await expect(
      planBaseline({
        candidate: null,
        targetSha: repo.headSha,
        language: "zh",
        repoPath: repo.root,
      }),
    ).resolves.toEqual({ usable: false, reason: "no_baseline" });
  });

  test("reports no_baseline when the knowledge directory is absent", async () => {
    const repo = await createFixtureRepository();
    await expect(
      planBaseline({
        candidate: `g_${randomUUID().replace(/-/gu, "")}` as GenerationId,
        targetSha: repo.headSha,
        language: "zh",
        repoPath: repo.root,
      }),
    ).resolves.toEqual({ usable: false, reason: "no_baseline" });
  });

  test("reports seal_mismatch when a sealed file changed", async () => {
    const repo = await createFixtureRepository();
    const fixture = await writeKnowledgeFixture({
      metadata: { commitSha: repo.baseSha },
    });
    await writeFile(
      path.join(fixture.knowledgeDir, "openwiki", "guide.md"),
      "tampered",
      "utf8",
    );

    await expect(
      planBaseline({
        candidate: fixture.generationId,
        targetSha: repo.headSha,
        language: "zh",
        repoPath: repo.root,
      }),
    ).resolves.toEqual({ usable: false, reason: "seal_mismatch" });
  });

  test("reports manifest_schema for an unknown manifest version", async () => {
    const repo = await createFixtureRepository();
    const fixture = await writeKnowledgeFixture({
      metadata: { commitSha: repo.baseSha },
      manifest: { schemaVersion: 2, pages: {} },
    });

    await expect(
      planBaseline({
        candidate: fixture.generationId,
        targetSha: repo.headSha,
        language: "zh",
        repoPath: repo.root,
      }),
    ).resolves.toEqual({ usable: false, reason: "manifest_schema" });
  });

  test("reports claims_schema for an unknown claims sidecar version", async () => {
    const repo = await createFixtureRepository();
    const fixture = await writeKnowledgeFixture({
      metadata: { commitSha: repo.baseSha },
      claims: {
        schemaVersion: 2,
        pageVersion: `sha256:${"b".repeat(64)}`,
        claims: [],
      },
    });

    await expect(
      planBaseline({
        candidate: fixture.generationId,
        targetSha: repo.headSha,
        language: "zh",
        repoPath: repo.root,
      }),
    ).resolves.toEqual({ usable: false, reason: "claims_schema" });
  });

  test("reports prompt_template when the baseline used another template", async () => {
    const repo = await createFixtureRepository();
    const fixture = await writeKnowledgeFixture({
      metadata: {
        commitSha: repo.baseSha,
        promptTemplateVersion: "codetrail-lesson-v0",
      },
    });

    await expect(
      planBaseline({
        candidate: fixture.generationId,
        targetSha: repo.headSha,
        language: "zh",
        repoPath: repo.root,
      }),
    ).resolves.toEqual({ usable: false, reason: "prompt_template" });
  });

  test("reports upstream_version when the baseline used another pin", async () => {
    const repo = await createFixtureRepository();
    const fixture = await writeKnowledgeFixture({
      metadata: {
        commitSha: repo.baseSha,
        upstreamVersion: "0.0.0+000000000000",
      },
    });

    await expect(
      planBaseline({
        candidate: fixture.generationId,
        targetSha: repo.headSha,
        language: "zh",
        repoPath: repo.root,
      }),
    ).resolves.toEqual({ usable: false, reason: "upstream_version" });
  });

  test("reports language when the baseline wiki is not Chinese", async () => {
    const repo = await createFixtureRepository();
    const fixture = await writeKnowledgeFixture({
      metadata: { commitSha: repo.baseSha, language: "en" },
    });

    await expect(
      planBaseline({
        candidate: fixture.generationId,
        targetSha: repo.headSha,
        language: "zh",
        repoPath: repo.root,
      }),
    ).resolves.toEqual({ usable: false, reason: "language" });
  });

  test("reports not_ancestor when the baseline commit is unrelated", async () => {
    const repo = await createFixtureRepository();
    const unrelated = await createFixtureRepository();
    const fixture = await writeKnowledgeFixture({
      metadata: { commitSha: unrelated.baseSha },
    });

    await expect(
      planBaseline({
        candidate: fixture.generationId,
        targetSha: repo.headSha,
        language: "zh",
        repoPath: repo.root,
      }),
    ).resolves.toEqual({ usable: false, reason: "not_ancestor" });
  });
});

describe("materializeBaseline", () => {
  function sourceOf(fixture: KnowledgeFixture, commitSha: string): BaselineSource {
    return {
      generationId: fixture.generationId,
      knowledgeDir: fixture.knowledgeDir,
      commitSha,
    };
  }

  test("copies openwiki but never copies .run.json", async () => {
    const repo = await createFixtureRepository();
    const fixture = await writeKnowledgeFixture({
      metadata: { commitSha: repo.baseSha },
      runState: `${JSON.stringify({ schemaVersion: 1, runId: "stale" })}\n`,
    });
    const buildWorktree = await temporaryDirectory("codetrail-build-");
    // A stale checkpoint from the target checkout must be removed, not reused.
    await mkdir(path.join(buildWorktree, "openwiki"), { recursive: true });
    await writeFile(
      path.join(buildWorktree, "openwiki", ".run.json"),
      "leftover",
      "utf8",
    );

    await materializeBaseline({
      source: sourceOf(fixture, repo.baseSha),
      buildWorktree,
    });

    await expect(
      readFile(path.join(buildWorktree, "openwiki", "guide.md"), "utf8"),
    ).resolves.toContain("# 指南");
    expect(
      await exists(path.join(buildWorktree, "openwiki", ".claims", "guide.json")),
    ).toBe(true);
    expect(await exists(path.join(buildWorktree, "openwiki", ".run.json"))).toBe(
      false,
    );
    // The source knowledge directory keeps its own recovery state.
    expect(
      await exists(path.join(fixture.knowledgeDir, "openwiki", ".run.json")),
    ).toBe(true);
  });

  test("refuses to materialise a baseline whose seal no longer matches", async () => {
    const repo = await createFixtureRepository();
    const fixture = await writeKnowledgeFixture({
      metadata: { commitSha: repo.baseSha },
    });
    await writeFile(
      path.join(fixture.knowledgeDir, "openwiki", "guide.md"),
      "tampered",
      "utf8",
    );
    const buildWorktree = await temporaryDirectory("codetrail-build-");

    await expect(
      materializeBaseline({
        source: sourceOf(fixture, repo.baseSha),
        buildWorktree,
      }),
    ).rejects.toMatchObject({
      code: "internal_error",
      details: { reason: "seal_mismatch" },
    });
    expect(await exists(path.join(buildWorktree, "openwiki"))).toBe(false);
  });
});
