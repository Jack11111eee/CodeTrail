import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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

import { afterEach, describe, expect, it } from "vitest";

import { PAGE_MANIFEST_PATH } from "../../../src/config/constants.ts";
import {
  PROMPT_TEMPLATE_VERSION,
  UPSTREAM_VERSION,
} from "../../../src/learning/config/defaults.ts";
import {
  ensureDataDir,
  knowledgePath,
  resolveDataPaths,
} from "../../../src/learning/config/paths.ts";
import { computeSealTreeHash } from "../../../src/learning/contracts/keys.ts";
import type { GenerationId, SealedFile } from "../../../src/learning/contracts/index.ts";
import {
  assembleComponentDiagram,
  assembleContext,
  scenarioKindFor,
} from "../../../src/learning/lessons/assemble.ts";
import { parseLesson } from "../../../src/learning/lessons/schema.ts";
import { planBaseline, materializeBaseline } from "../../../src/learning/upstream/baseline.ts";
import {
  assembleInput,
  emptyCoverage,
  researchLesson,
  defaultGeneration,
} from "../helpers/lesson-sample.ts";

/**
 * Integration: cross-version baseline (issue-13) + deterministic lesson
 * assembler (issue-15).
 *
 * `planBaseline`/`materializeBaseline` produce the `openwiki/**` tree an update
 * run starts from; the assembler consumes the resulting page list to build the
 * lesson context and diagram. This test proves the baseline's output is the
 * input the next generation's skeleton sees, and that the run checkpoint
 * (`.run.json`) and non-wiki content never travel.
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

interface BaselineRepo {
  repository: string;
  baseSha: string;
  targetSha: string;
  sideSha: string;
}

/** C0 → C1 on `main`; C2 branches from C0 (so C1 is not an ancestor of C2). */
async function createRepository(): Promise<BaselineRepo> {
  const repository = await temporaryDirectory("codetrail-baseline-repo-");
  await git(repository, ["init", "--quiet"]);
  await git(repository, ["config", "user.email", "test@example.com"]);
  await git(repository, ["config", "user.name", "Baseline Test"]);
  await mkdir(path.join(repository, "src"), { recursive: true });
  await writeFile(path.join(repository, "src", "app.ts"), "export const v = 1;\n", "utf8");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "--quiet", "-m", "c0"]);
  const baseSha = await git(repository, ["rev-parse", "HEAD"]);

  await writeFile(path.join(repository, "src", "app.ts"), "export const v = 2;\n", "utf8");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "--quiet", "-m", "c1"]);
  const targetSha = await git(repository, ["rev-parse", "HEAD"]);

  await git(repository, ["checkout", "--quiet", "-b", "side", baseSha]);
  await writeFile(path.join(repository, "src", "side.ts"), "export const side = true;\n", "utf8");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "--quiet", "-m", "c2"]);
  const sideSha = await git(repository, ["rev-parse", "HEAD"]);
  await git(repository, ["checkout", "--quiet", "main"]);

  return { repository, baseSha, targetSha, sideSha };
}

async function sha256Of(file: string): Promise<{ sha256: string; bytes: number }> {
  const content = await readFile(file);
  return {
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: content.byteLength,
  };
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes a sealed published knowledge tree: `openwiki/**` pages, a page
 * manifest, a non-wiki `lessons/` file, a stale `.run.json`, `generation.json`
 * and `seal.json` covering every content file.
 */
async function writeBaselineKnowledge(
  knowledgeDir: string,
  commitSha: string,
): Promise<void> {
  await mkdir(path.join(knowledgeDir, "openwiki", "guides"), { recursive: true });
  await mkdir(path.join(knowledgeDir, "openwiki", "reference"), { recursive: true });
  await mkdir(path.join(knowledgeDir, "lessons"), { recursive: true });
  await writeFile(
    path.join(knowledgeDir, "openwiki", "guides", "intro.md"),
    "---\ntype: Guide\ntitle: Intro\n---\n\n# Intro\n",
    "utf8",
  );
  await writeFile(
    path.join(knowledgeDir, "openwiki", "reference", "api.md"),
    "---\ntype: Reference\ntitle: API\n---\n\n# API\n",
    "utf8",
  );
  await writeFile(
    path.join(knowledgeDir, PAGE_MANIFEST_PATH),
    JSON.stringify({ schemaVersion: 1, pages: {} }),
    "utf8",
  );
  await writeFile(
    path.join(knowledgeDir, "openwiki", ".run.json"),
    JSON.stringify({ status: "interrupted" }),
    "utf8",
  );
  await writeFile(
    path.join(knowledgeDir, "lessons", "lesson.json"),
    JSON.stringify({ lessonId: "l_1" }),
    "utf8",
  );
  await writeFile(
    path.join(knowledgeDir, "generation.json"),
    JSON.stringify({
      commitSha,
      repoId: "r_1",
      upstreamVersion: UPSTREAM_VERSION,
      promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
      language: "zh",
    }),
    "utf8",
  );

  const relative = [
    "openwiki/guides/intro.md",
    "openwiki/reference/api.md",
    "openwiki/.run.json",
    "lessons/lesson.json",
  ];
  const files: SealedFile[] = [];
  for (const rel of relative) {
    files.push({ path: rel, ...(await sha256Of(path.join(knowledgeDir, rel))) });
  }
  await writeFile(
    path.join(knowledgeDir, "seal.json"),
    JSON.stringify({ files, treeHash: computeSealTreeHash(files) }),
    "utf8",
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("baseline materialisation × lesson assembly", () => {
  it("materialises only openwiki content and feeds the next lesson skeleton", async () => {
    const repo = await createRepository();
    const paths = resolveDataPaths(process.env);
    await ensureDataDir(paths);
    const candidate = "g_baseline" as GenerationId;
    const knowledgeDir = knowledgePath(paths, candidate);
    await writeBaselineKnowledge(knowledgeDir, repo.baseSha);

    const plan = await planBaseline({
      candidate,
      targetSha: repo.targetSha,
      language: "zh",
      repoPath: repo.repository,
    });
    expect(plan.usable).toBe(true);
    expect(plan.source?.commitSha).toBe(repo.baseSha);

    const buildWorktree = path.join(
      await temporaryDirectory("codetrail-baseline-build-"),
      "tree",
    );
    await mkdir(buildWorktree, { recursive: true });
    await materializeBaseline({ source: plan.source!, buildWorktree });

    // Wiki content travels byte-for-byte …
    await expect(
      readFile(path.join(buildWorktree, "openwiki", "guides", "intro.md"), "utf8"),
    ).resolves.toBe("---\ntype: Guide\ntitle: Intro\n---\n\n# Intro\n");
    expect(await exists(path.join(buildWorktree, "openwiki", "reference", "api.md"))).toBe(true);

    // … the upstream run checkpoint never does (PRD §6.1 item 5).
    expect(await exists(path.join(buildWorktree, "openwiki", ".run.json"))).toBe(false);
    // … and non-wiki knowledge (lessons) is not part of the baseline.
    expect(await exists(path.join(buildWorktree, "lessons", "lesson.json"))).toBe(false);

    // The copied page list is exactly what the assembler consumes.
    const pages = ["guides/intro.md", "reference/api.md"];
    const input = assembleInput({
      generation: defaultGeneration({
        generationId: "g_next" as GenerationId,
        commitSha: repo.targetSha,
      }),
      pages,
      coverage: emptyCoverage(["src/app.ts"]),
    });
    const context = assembleContext(input);
    expect(context.commitSha).toBe(repo.targetSha);
    expect(context.moduleIds).toEqual([...pages].sort());
    expect(scenarioKindFor(input)).toBe("library_interface");

    // The assembled context/diagram produce a schema-valid lesson.
    const draft = researchLesson();
    draft.generationId = "g_next";
    draft.context = context;
    draft.diagram = assembleComponentDiagram(input);
    expect(parseLesson(draft).ok).toBe(true);
  });

  it("refuses a seal that no longer matches the knowledge content", async () => {
    const repo = await createRepository();
    const paths = resolveDataPaths(process.env);
    await ensureDataDir(paths);
    const candidate = "g_tampered" as GenerationId;
    const knowledgeDir = knowledgePath(paths, candidate);
    await writeBaselineKnowledge(knowledgeDir, repo.baseSha);
    await writeFile(
      path.join(knowledgeDir, "openwiki", "guides", "intro.md"),
      "---\ntype: Guide\ntitle: Tampered\n---\n\n# Tampered\n",
      "utf8",
    );

    const plan = await planBaseline({
      candidate,
      targetSha: repo.targetSha,
      language: "zh",
      repoPath: repo.repository,
    });
    expect(plan).toEqual({ usable: false, reason: "seal_mismatch" });
  });

  it("reports no_baseline and not_ancestor instead of reusing the wrong version", async () => {
    const repo = await createRepository();

    await expect(
      planBaseline({
        candidate: null,
        targetSha: repo.targetSha,
        language: "zh",
        repoPath: repo.repository,
      }),
    ).resolves.toEqual({ usable: false, reason: "no_baseline" });

    const paths = resolveDataPaths(process.env);
    await ensureDataDir(paths);
    // The candidate was built at C1; the target C2 branched before C1.
    const knowledgeDir = knowledgePath(paths, "g_side" as GenerationId);
    await writeBaselineKnowledge(knowledgeDir, repo.targetSha);

    const plan = await planBaseline({
      candidate: "g_side" as GenerationId,
      targetSha: repo.sideSha,
      language: "zh",
      repoPath: repo.repository,
    });
    expect(plan).toEqual({ usable: false, reason: "not_ancestor" });
  });
});
