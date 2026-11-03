/**
 * Phase A gate (AC-GATE-A, PRD §15.4, architecture §7, §18, §21).
 *
 * Phase A is the base every later gate builds on, so it is a *composition*
 * gate, not a smoke test:
 *
 *   1. knowledge comes from a fixed SHA, and the recorded commit/tree hash
 *      match Git exactly;
 *   2. the analysed source repository is byte-identical afterwards (no
 *      workflow, no `AGENTS.md`/`CLAUDE.md`, same recursive sha256 manifest and
 *      same `git status --porcelain`);
 *   3. a compatible baseline is reused with fewer model calls, an incompatible
 *      one triggers a full regeneration with a recorded `fallback_reason`, and
 *      sources are validated in both cases;
 *   4. a job killed mid-flight recovers as `interrupted` and retries as
 *      attempt 2 on the same `job_id`, then publishes;
 *   5. a failed job leaves the previous published generation, its
 *      `sealed_tree_hash` and its lesson bytes untouched.
 *
 * The second half of the file proves the `scripts/phase-check.mjs` contract by
 * spawning it. Those tests are skipped when the file itself is executed by
 * `phase:check` (the stage sets `CODETRAIL_PHASE_CHECK=1`); otherwise
 * `--through=A` would spawn itself forever. The five property tests above run
 * in both modes.
 */
/* eslint-disable @typescript-eslint/require-await -- test doubles implement async ports */
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { PROMPT_TEMPLATE_VERSION } from "../../../src/learning/config/defaults.ts";
import {
  ensureDataDir,
  knowledgePath,
  mirrorPath,
  resolveDataPaths,
} from "../../../src/learning/config/paths.ts";
import {
  computeDedupeKey,
  jobIdFromDedupeKey,
  LearningError,
  repoIdFromIdentity,
} from "../../../src/learning/contracts/index.ts";
import type {
  ExternalDocService,
  GenerationId,
  JobRunner,
  LessonBuilderPort,
  ModelHandle,
  SnapshotService,
  UpstreamGenerationPort,
} from "../../../src/learning/contracts/index.ts";
import { createJobRunner } from "../../../src/learning/api/jobs/runner.ts";
import { createSnapshotService } from "../../../src/learning/projects/snapshot.ts";
import {
  createScriptedModel,
  SCRIPT_FILE_NAME,
} from "../../../src/learning/testing/scripted-model.ts";
import {
  createGitRepositoryAt,
  createHarness,
  generationInput,
  listRelativeFiles,
  readSealManifest,
  runToCompletion,
  sampleLesson,
  seedPublishedGeneration,
  SHA_A,
  SHA_B,
  type Harness,
} from "../generation/harness.ts";
import {
  fixtureGit,
  fixturePath,
  fixtureSha,
  fixturesDir,
  requireFixtures,
} from "../helpers/git-fixture.ts";

const execFileAsync = promisify(execFile);

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PHASE_CHECK = path.join(REPO_ROOT, "scripts", "phase-check.mjs");
const INSIDE_PHASE_CHECK = process.env.CODETRAIL_PHASE_CHECK === "1";

const harnesses: Harness[] = [];
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

afterAll(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

beforeAll(async () => {
  // `pnpm run test:learning -- test/learning/phase/a-gate.test.ts` must work on
  // a clean checkout, so build the deterministic fixtures when they are
  // absent. `--through=A` does the same for the whole phase.
  if (!existsSync(path.join(fixturesDir(), "manifest.json"))) {
    await execFileAsync(
      process.execPath,
      [path.join(REPO_ROOT, "scripts", "make-fixtures.mjs")],
      { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 },
    );
  }
  requireFixtures();
}, 180_000);

// ── helpers ─────────────────────────────────────────────────────────────────

async function sha256File(absolutePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(absolutePath))
    .digest("hex");
}

/**
 * Recursive path → sha256 manifest of a working tree.
 *
 * `.git/` is bookkeeping, not source: a read-only `git status` may refresh the
 * index. The property under test is that the *source bytes* did not move.
 */
async function treeManifest(root: string): Promise<Record<string, string>> {
  const files = (await listRelativeFiles(root)).filter(
    (relative) => relative !== ".git" && !relative.startsWith(".git/"),
  );
  const manifest: Record<string, string> = {};
  for (const relative of files) {
    manifest[relative] = await sha256File(path.join(root, relative));
  }
  return manifest;
}

async function directoryHashes(root: string): Promise<Record<string, string>> {
  const files = await listRelativeFiles(root);
  const hashes: Record<string, string> = {};
  for (const relative of files) {
    hashes[relative] = await sha256File(path.join(root, relative));
  }
  return hashes;
}

/**
 * A job runner wired with the production pipeline, publisher, store, source
 * registry and the *real* Git snapshot service. Only the upstream generator
 * and the lesson builder are doubles, exactly like the generation harness.
 */
function createGateRunner(
  harness: Harness,
  snapshotService: SnapshotService,
): { runner: JobRunner; calls: { count: number } } {
  const calls = { count: 0 };
  const scriptDir = path.join(harness.paths.root, "test-scripts");
  if (!existsSync(path.join(scriptDir, SCRIPT_FILE_NAME))) {
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(
      path.join(scriptDir, SCRIPT_FILE_NAME),
      JSON.stringify({
        scripts: Array.from({ length: 24 }, (_, index) => ({
          workerKind: "planner",
          occurrence: index + 1,
          steps: [{ content: "ok" }],
        })),
      }),
      "utf8",
    );
  }

  const chat = createScriptedModel({
    dir: scriptDir,
    role: "repo_job",
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
    onCall: () => {
      calls.count += 1;
    },
  });
  const model: ModelHandle = {
    modelId: "scripted",
    settings: {
      provider: "scripted",
      model: "scripted",
      maxOutputTokens: 1024,
      temperature: 0,
      pricing: null,
      quota: {
        maxCalls: 1000,
        maxInputTokens: 1_000_000,
        maxOutputTokens: 1_000_000,
      },
    },
    chat: () => chat,
    estimate: () => ({ calls: 1, tokens: 100 }),
  };

  const upstream: UpstreamGenerationPort = {
    async run(request) {
      // Baseline materialisation is visible as an existing wiki page; the
      // full path pays for three calls, the reused path for one.
      const total = existsSync(
        path.join(request.worktreePath, "openwiki", "quickstart.md"),
      )
        ? 1
        : 3;
      for (let index = 0; index < total; index += 1) {
        await (
          request.model as unknown as {
            invoke: (input: string) => Promise<unknown>;
          }
        ).invoke(`call ${index}`);
      }
      const wiki = path.join(request.worktreePath, "openwiki");
      await mkdir(path.join(wiki, ".claims"), { recursive: true });
      await writeFile(
        path.join(wiki, "quickstart.md"),
        `# Quickstart\n\ncommit ${path.basename(request.worktreePath)}\n`,
        "utf8",
      );
      await writeFile(
        path.join(wiki, ".page-manifest.json"),
        JSON.stringify({ schemaVersion: 1, pages: {} }),
        "utf8",
      );
      await writeFile(
        path.join(wiki, ".claims", "quickstart.json"),
        JSON.stringify({ schemaVersion: 1, claims: [] }),
        "utf8",
      );
      // Recovery state must never be copied into a published generation.
      await writeFile(
        path.join(wiki, ".run.json"),
        JSON.stringify({ status: "running" }),
        "utf8",
      );
      return { skipped: false, sourceChanged: true };
    },
    sourceFingerprint: async () => "fingerprint",
    treeHashOfWorktree: async () => "tree",
    changedPaths: async () => [],
    lastUpdate: async () => null,
    pageManifest: async () => null,
  };

  const lessons: LessonBuilderPort = {
    async buildResearchLessons(input) {
      const files = await input.snapshot.list(input.scope);
      const chosen =
        files.find((file) => file.path.startsWith("src/")) ?? files[0];
      if (chosen === undefined) {
        throw new LearningError(
          "internal_error",
          "snapshot has no readable file",
        );
      }
      const ref = await input.registry.registerRepo({
        generationId: input.generation.generationId,
        repoId: input.generation.repoId,
        commitSha: input.generation.commitSha,
        path: chosen.path,
        lines: null,
        snapshot: input.snapshot,
        scope: input.scope,
      });
      return {
        lessons: [
          sampleLesson("research", input.generation, [ref.sourceId], {
            repoId: input.generation.repoId,
            commitSha: input.generation.commitSha,
            generationId: input.generation.generationId,
            scenarioId: "sc_phase_a",
            moduleIds: [path.posix.dirname(chosen.path)],
          }),
        ],
        failures: [],
        blankTeaching: false,
      };
    },
    async buildChangeLesson() {
      throw new LearningError(
        "internal_error",
        "change lessons are not part of A",
      );
    },
    async buildComparisonLesson() {
      throw new LearningError(
        "internal_error",
        "comparison lessons are not part of A",
      );
    },
  };

  const external: ExternalDocService = {
    fetchExact: async () => ({
      ok: false,
      status: "source_missing",
      reason: "not_found",
    }),
    cached: async () => null,
  };

  const runner = createJobRunner({
    db: harness.db,
    repos: harness.repos,
    paths: harness.paths,
    clock: harness.clock,
    snapshotService,
    publisher: harness.publisher,
    upstream,
    lessons,
    model,
    usage: harness.usage,
    registry: harness.registry,
    external,
  });
  return { runner, calls };
}

interface EvolutionRun {
  harness: Harness;
  job: import("../../../src/learning/contracts/index.ts").JobRecord;
  snapshot: import("../../../src/learning/contracts/index.ts").SnapshotRecord;
  sourcePath: string;
  sha: string;
  tree: string;
  beforeManifest: Record<string, string>;
  beforeStatus: string;
}

/**
 * Clones the `evolution` fixture into the data directory, runs one generation
 * at its fixed HEAD through the real snapshot service and pipeline, and
 * returns everything a durability assertion needs.
 */
async function runEvolutionGeneration(): Promise<EvolutionRun> {
  const name = "evolution";
  const sourcePath = fixturePath(name);
  const sha = fixtureSha(name, "HEAD");
  const tree = fixtureGit(name, ["rev-parse", "HEAD^{tree}"]);
  const beforeManifest = await treeManifest(sourcePath);
  const beforeStatus = fixtureGit(name, ["status", "--porcelain"]);

  const dataDir = process.env.CODETRAIL_DATA_DIR!;
  const paths = resolveDataPaths({
    ...process.env,
    CODETRAIL_DATA_DIR: dataDir,
  });
  await ensureDataDir(paths);
  const repoId = repoIdFromIdentity(`local:${dataDir}`);
  const mirror = mirrorPath(paths, repoId);
  mkdirSync(path.dirname(mirror), { recursive: true, mode: 0o700 });
  await execFileAsync("git", ["clone", "--mirror", sourcePath, mirror], {
    maxBuffer: 64 * 1024 * 1024,
  });

  const harness = await createHarness({ commits: [sha] });
  harnesses.push(harness);

  const snapshotService = createSnapshotService({
    paths: harness.paths,
    repos: harness.repos,
    clock: harness.clock,
  });
  const gate = createGateRunner(harness, snapshotService);

  const job = await gate.runner.enqueue(
    generationInput(harness, { sha, mode: "init" }),
  );
  await gate.runner.drain();
  const completed = await gate.runner.get(job.jobId);
  if (completed === null) throw new Error("generation job disappeared");

  const snapshot = harness.repos.snapshots.byCommit(harness.repoId, sha);
  if (snapshot === null)
    throw new Error("generation did not record a snapshot");

  return {
    harness,
    job: completed,
    snapshot,
    sourcePath,
    sha,
    tree,
    beforeManifest,
    beforeStatus,
  };
}

function runCrashChild(
  dataDir: string,
  fault: string,
): Promise<{ code: number | null; stderr: string }> {
  const childPath = path.join(
    import.meta.dirname,
    "..",
    "generation",
    "crash-child.ts",
  );
  const tsxPath = path.join(
    REPO_ROOT,
    "node_modules",
    "tsx",
    "dist",
    "cli.mjs",
  );
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxPath, childPath], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CODETRAIL_DATA_DIR: dataDir,
        CODETRAIL_FAULT_INJECT: fault,
        CODETRAIL_CRASH_SHA: SHA_B,
        CODETRAIL_CRASH_OLD_SHA: SHA_A,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

// ── the five A properties ───────────────────────────────────────────────────

describe("phase A — knowledge, source, baseline, recovery, isolation", () => {
  test("knowledge is generated from a fixed SHA with matching commit and tree hash", async () => {
    const run = await runEvolutionGeneration();

    expect(run.job.state).toBe("completed");
    expect(run.job.outputGenerationId).toBeTruthy();

    const record = run.harness.repos.generations.byId(
      run.job.outputGenerationId!,
    );
    expect(record?.status).toBe("published");
    expect(record?.commitSha).toBe(run.sha);
    expect(run.snapshot.commitSha).toBe(run.sha);
    // `git rev-parse <sha>^{tree}` is the only acceptable tree hash.
    expect(run.snapshot.treeHash).toBe(run.tree);

    const knowledgeDir = knowledgePath(
      run.harness.paths,
      run.job.outputGenerationId!,
    );
    expect(existsSync(path.join(knowledgeDir, "seal.json"))).toBe(true);
    expect(
      existsSync(path.join(knowledgeDir, "openwiki", "quickstart.md")),
    ).toBe(true);
    const seal = await readSealManifest(knowledgeDir);
    expect(seal.treeHash).toBe(record?.sealedTreeHash);
  }, 120_000);

  test("the analysed source repository stays byte-identical and receives no fork files", async () => {
    const run = await runEvolutionGeneration();

    expect(await treeManifest(run.sourcePath)).toEqual(run.beforeManifest);
    expect(fixtureGit("evolution", ["status", "--porcelain"])).toBe(
      run.beforeStatus,
    );
    expect(run.beforeStatus).toBe("");

    for (const relative of [
      ".github/workflows/openwiki-update.yml",
      "AGENTS.md",
      "CLAUDE.md",
    ]) {
      expect(existsSync(path.join(run.sourcePath, relative))).toBe(false);
      // The snapshot worktree is the tree the generator actually sees.
      expect(existsSync(path.join(run.snapshot.worktreePath, relative))).toBe(
        false,
      );
    }
  }, 120_000);

  test("a compatible baseline is reused with fewer model calls and validated sources", async () => {
    const dataDir = process.env.CODETRAIL_DATA_DIR!;
    const repoRoot = mkdtempSync(path.join(dataDir, "gate-baseline-"));
    const shas = await createGitRepositoryAt(repoRoot, [
      "base",
      "head",
      "third",
    ]);
    const harness = await createHarness({
      mirrorPath: repoRoot,
      commits: shas,
    });
    harnesses.push(harness);

    const seeded = await seedPublishedGeneration(harness, {
      generationId: "g_gate_baseline_reuse" as GenerationId,
      commitSha: shas[0],
      withRunJson: true,
    });

    const reused = await runToCompletion(
      harness,
      generationInput(harness, {
        sha: shas[1],
        mode: "update",
        baselineFromGenerationId: seeded.generationId,
      }),
    );
    expect(reused.state).toBe("completed");
    const reusedRecord = harness.repos.generations.byId(
      reused.outputGenerationId!,
    )!;
    expect(reusedRecord.baselineFromGenerationId).toBe(seeded.generationId);
    expect(reusedRecord.fallbackReason).toBeNull();
    const reusedCalls = harness.calls.count;
    expect(reusedCalls).toBe(1);
    expect(
      harness.repos.sources.all(reused.outputGenerationId!).length,
    ).toBeGreaterThan(0);

    // A full run on the same data root pays for the whole generation.
    harness.calls.count = 0;
    const full = await runToCompletion(
      harness,
      generationInput(harness, { sha: shas[2], mode: "init" }),
    );
    expect(full.state).toBe("completed");
    expect(harness.calls.count).toBe(3);
    expect(reusedCalls).toBeLessThan(harness.calls.count);
  }, 120_000);

  test("an incompatible baseline regenerates in full and records a fallback reason", async () => {
    const dataDir = process.env.CODETRAIL_DATA_DIR!;
    const repoRoot = mkdtempSync(path.join(dataDir, "gate-fallback-"));
    const shas = await createGitRepositoryAt(repoRoot, [
      "base",
      "head",
      "third",
    ]);
    const harness = await createHarness({
      mirrorPath: repoRoot,
      commits: shas,
    });
    harnesses.push(harness);

    const stale = await seedPublishedGeneration(harness, {
      generationId: "g_gate_baseline_stale" as GenerationId,
      commitSha: shas[0],
      upstreamVersion: "0.0.0-stale",
    });

    harness.calls.count = 0;
    const fallback = await runToCompletion(
      harness,
      generationInput(harness, {
        sha: shas[1],
        mode: "update",
        baselineFromGenerationId: stale.generationId,
      }),
    );
    expect(fallback.state).toBe("completed");
    const record = harness.repos.generations.byId(
      fallback.outputGenerationId!,
    )!;
    expect(record.fallbackReason).toBe("upstream_version");
    expect(record.fallbackReason).toBeTruthy();
    expect(record.baselineFromGenerationId).toBeNull();
    // Full regeneration: the baseline was not copied into the build tree.
    expect(harness.calls.count).toBe(3);
    // Sources are fully validated/registered either way.
    expect(
      harness.repos.sources.all(fallback.outputGenerationId!).length,
    ).toBeGreaterThan(0);
  }, 120_000);

  test("a job killed mid-flight recovers as interrupted and retries on the same job id", async () => {
    const dataDir = process.env.CODETRAIL_DATA_DIR!;
    const crashed = await runCrashChild(dataDir, "tx_before");
    expect(crashed.code).not.toBe(0);
    expect(crashed.stderr).toContain("injected fault at tx_before");

    const harness = await createHarness({
      dataDir,
      commits: [SHA_A, SHA_B],
    });
    harnesses.push(harness);

    await expect(harness.runner.recoverInterrupted()).resolves.toBe(1);

    const input = generationInput(harness, { sha: SHA_B, mode: "update" });
    const jobId = jobIdFromDedupeKey(computeDedupeKey(input));
    const interrupted = await harness.runner.get(jobId);
    expect(interrupted?.state).toBe("interrupted");
    expect(interrupted?.errorCode).toBe("interrupted");
    expect(interrupted?.attempt).toBe(1);
    expect(interrupted?.outputGenerationId).toBeNull();

    const retried = await harness.runner.retry(jobId);
    expect(retried.jobId).toBe(jobId);
    expect(retried.state).toBe("queued");
    expect(retried.attempt).toBe(2);

    await harness.runner.drain();
    const completed = await harness.runner.get(jobId);
    expect(completed?.state).toBe("completed");
    expect(completed?.attempt).toBe(2);
    expect(completed?.outputGenerationId).toBeTruthy();
    expect(
      harness.repos.attempts.list(jobId).map((entry) => entry.attempt),
    ).toEqual([1, 2]);

    const knowledgeDir = knowledgePath(
      harness.paths,
      completed!.outputGenerationId!,
    );
    const seal = await readSealManifest(knowledgeDir);
    expect(
      harness.repos.generations.byId(completed!.outputGenerationId!)
        ?.sealedTreeHash,
    ).toBe(seal.treeHash);
  }, 180_000);

  test("a failed job leaves the previous published version untouched", async () => {
    const harness = await createHarness({ failForSha: SHA_B });
    harnesses.push(harness);

    const first = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_A }),
    );
    const oldId = first.outputGenerationId!;
    const oldRecord = harness.repos.generations.byId(oldId)!;
    const oldDir = knowledgePath(harness.paths, oldId);
    const oldHashes = await directoryHashes(oldDir);
    const oldLessons = harness.repos.lessons.listByGeneration(oldId);

    const failed = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_B }),
    );
    expect(failed.state).toBe("failed");
    expect(failed.outputGenerationId).toBeNull();

    const stillOld = harness.repos.generations.byId(oldId)!;
    expect(stillOld.status).toBe("published");
    expect(stillOld.sealedTreeHash).toBe(oldRecord.sealedTreeHash);
    expect(await directoryHashes(oldDir)).toEqual(oldHashes);
    expect(harness.repos.lessons.listByGeneration(oldId)).toEqual(oldLessons);
    expect(
      harness.repos.generations.latestPublished(harness.repoId)?.generationId,
    ).toBe(oldId);
    expect(
      harness.db.raw
        .prepare(
          "SELECT COUNT(*) AS total FROM generations WHERE status = 'published'",
        )
        .get(),
    ).toEqual({ total: 1 });
  }, 120_000);
});

// ── phase-check CLI contract (AC-GATE-A / AC-GATE-ORDER) ────────────────────

function runPhaseCheck(
  args: string[],
  options: { timeoutMs?: number } = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [PHASE_CHECK, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs ?? 20 * 60 * 1000,
    windowsHide: true,
  });
}

function parsedStdout(
  result: ReturnType<typeof spawnSync>,
): Record<string, unknown> {
  expect(typeof result.stdout).toBe("string");
  return JSON.parse(String(result.stdout).trim()) as Record<string, unknown>;
}

/**
 * A copy of the repository with one path removed, used to prove the gate fails
 * when a prerequisite is missing. `node_modules`, `.git` and generated trees
 * are not copied; the copy is only read by phase-check's preflight.
 */
function copyRepositoryWithout(relativeToRemove: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "codetrail-phase-root-"));
  temporaryRoots.push(root);
  const skip = new Set([
    "node_modules",
    ".git",
    ".tmp",
    "dist",
    "coverage",
    ".worktrees",
  ]);
  cpSync(REPO_ROOT, root, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(REPO_ROOT, source);
      if (relative === "") return true;
      const top = relative.split(path.sep)[0];
      if (skip.has(top)) return false;
      if (top.startsWith(".agentfield-out-")) return false;
      return true;
    },
  });
  symlinkSync(
    path.join(REPO_ROOT, "node_modules"),
    path.join(root, "node_modules"),
    "dir",
  );
  rmSync(path.join(root, relativeToRemove), { recursive: true, force: true });
  return root;
}

function runScriptModule(expression: string): unknown {
  const moduleUrl = pathToFileURL(PHASE_CHECK).href;
  const source = `import * as phaseCheck from ${JSON.stringify(moduleUrl)};\nprocess.stdout.write(JSON.stringify(${expression}));\n`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  expect(result.status).toBe(0);
  return JSON.parse(String(result.stdout)) as unknown;
}

describe.skipIf(INSIDE_PHASE_CHECK)("phase-check CLI contract", () => {
  test("STAGES is ordered, complete, and keeps the A seam", () => {
    const seam = runScriptModule(
      "({ phases: phaseCheck.STAGES.map((stage) => stage.phase), testFiles: phaseCheck.STAGES.map((stage) => stage.testFile), suites: phaseCheck.STAGES.map((stage) => stage.suites.map((suite) => suite.name)) })",
    ) as {
      phases: string[];
      testFiles: string[];
      suites: string[][];
    };

    expect(seam.phases[0]).toBe("A");
    // Every registered phase follows the canonical order; later issues append.
    const expected = ["A", "B", "C", "D"].slice(0, seam.phases.length);
    expect(seam.phases).toEqual(expected);
    expect(seam.testFiles[0]).toBe("test/learning/phase/a-gate.test.ts");
    for (const required of [
      "check-env",
      "check-provenance",
      "contracts-leaf",
      "architecture",
      "environment",
      "fork",
      "store",
      "projects",
      "upstream",
      "lessons",
      "retrieval",
      "generation",
      "api",
      "security",
      "ops",
      "a-gate",
    ]) {
      expect(seam.suites[0]).toContain(required);
    }
  }, 60_000);

  test("checkOrder rejects a green phase behind a red A", () => {
    const order = runScriptModule(
      "phaseCheck.checkOrder([{ phase: 'A', passed: false }, { phase: 'B', passed: true }])",
    ) as { ok: boolean; brokenBy?: string; greenWhileRed?: string };
    expect(order.ok).toBe(false);
    expect(order.brokenBy).toBe("A");
    expect(order.greenWhileRed).toBe("B");

    const healthy = runScriptModule(
      "phaseCheck.checkOrder([{ phase: 'A', passed: true }, { phase: 'B', passed: true }, { phase: 'C', pending: true }])",
    ) as { ok: boolean };
    expect(healthy.ok).toBe(true);
  }, 60_000);

  test("--simulate is red-only and the JSON shape is stable", () => {
    const red = runPhaseCheck(["--through=A", "--simulate", "A=fail"]);
    expect(red.status).not.toBe(0);
    const json = parsedStdout(red);
    expect(json.phase).toBe("A");
    expect(json.passed).toBe(false);
    expect(Array.isArray(json.stages)).toBe(true);
    expect(json.order).toMatchObject({
      ok: false,
      phases: ["A", "B", "C", "D"],
    });
    expect(json.failed).toMatchObject({ phase: "A", simulated: true });
    expect(String(red.stdout)).not.toContain('"passed":true');

    const green = runPhaseCheck(["--simulate", "A=pass"]);
    expect(green.status).not.toBe(0);
    expect(String(green.stderr)).toContain("simulate_green_forbidden");
    expect(String(green.stdout)).not.toContain('"passed":true');
  }, 120_000);

  test("--through=B fails while A is red and names the red A stage", () => {
    const result = runPhaseCheck(["--through=B", "--simulate", "A=fail"]);
    expect(result.status).not.toBe(0);
    const json = parsedStdout(result);
    expect(json.phase).toBe("B");
    expect(json.passed).toBe(false);
    expect(json.failed).toMatchObject({ phase: "A" });
    expect(String(result.stderr)).toContain("phase A is red");
    expect(String(result.stdout)).not.toContain('"passed":true');
  }, 120_000);

  test("--verify-order fails when A is red", () => {
    const result = runPhaseCheck(["--verify-order", "--simulate", "A=fail"]);
    expect(result.status).not.toBe(0);
    const json = parsedStdout(result);
    expect(json.passed).toBe(false);
    expect(json.order).toMatchObject({ ok: false, brokenBy: "A" });
    expect(String(result.stderr)).toContain("phase A");
    expect(String(result.stdout)).not.toContain('"passed":true');
  }, 120_000);

  test("an unknown --through value never prints passed:true", () => {
    const result = runPhaseCheck(["--through=Z"]);
    expect(result.status).not.toBe(0);
    expect(String(result.stderr)).toContain("unknown_phase");
    expect(String(result.stdout)).not.toContain('"passed":true');
  }, 120_000);

  test("a missing suite makes A red and names the missing path", () => {
    const root = copyRepositoryWithout("test/learning/generation");
    const result = runPhaseCheck(["--root", root, "--through=A"]);
    expect(result.status).not.toBe(0);
    const json = parsedStdout(result);
    expect(json.passed).toBe(false);
    expect(String(result.stderr)).toContain(
      "missing_suite test/learning/generation",
    );
    expect(String(result.stdout)).not.toContain('"passed":true');
  }, 180_000);

  test("a missing gate test makes A red instead of vacuously green", () => {
    const root = copyRepositoryWithout("test/learning/phase/a-gate.test.ts");
    const result = runPhaseCheck(["--root", root, "--through=A"]);
    expect(result.status).not.toBe(0);
    const json = parsedStdout(result);
    expect(json.passed).toBe(false);
    expect(String(result.stderr)).toContain(
      "missing_gate_test test/learning/phase/a-gate.test.ts",
    );
    expect(String(result.stdout)).not.toContain('"passed":true');
  }, 180_000);

  test(
    "--through=A composes every wave 0a–3d suite and exits 0 with passed:true",
    () => {
      const result = runPhaseCheck(["--through=A"], {
        timeoutMs: 25 * 60 * 1000,
      });
      expect(result.status).toBe(0);
      const json = parsedStdout(result);
      expect(json.phase).toBe("A");
      expect(json.passed).toBe(true);
      expect(json.order).toMatchObject({ ok: true });
      const names = (json.stages as { name: string }[]).map(
        (stage) => stage.name,
      );
      for (const required of [
        "check-env",
        "check-provenance",
        "contracts-leaf",
        "architecture",
        "environment",
        "fork",
        "store",
        "projects",
        "upstream",
        "lessons",
        "retrieval",
        "generation",
        "api",
        "security",
        "ops",
        "a-gate",
      ]) {
        expect(names).toContain(required);
      }
    },
    30 * 60 * 1000,
  );

  test(
    "--verify-order derives pass state by running the stages and exits 0",
    () => {
      const result = runPhaseCheck(["--verify-order"], {
        timeoutMs: 25 * 60 * 1000,
      });
      expect(result.status).toBe(0);
      const json = parsedStdout(result);
      expect(json.passed).toBe(true);
      expect(json.order).toMatchObject({ ok: true });
    },
    30 * 60 * 1000,
  );
});
