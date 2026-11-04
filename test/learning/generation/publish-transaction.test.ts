import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  emptyCursor,
  type ChangeEventId,
  type GenerationId,
  type LessonRow,
  type ProjectId,
  type PublishCommit,
} from "../../../src/learning/contracts/index.ts";
import { knowledgePath } from "../../../src/learning/config/paths.ts";
import {
  createHarness,
  generationInput,
  insertJob,
  runToCompletion,
  SHA_A,
  SHA_B,
  SHA_C,
  type Harness,
} from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

describe("publish transaction", () => {
  test("generation, lessons and sources become visible together", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const job = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_A }),
    );
    const generationId = job.outputGenerationId!;

    expect(harness.repos.generations.byId(generationId)?.status).toBe(
      "published",
    );
    expect(harness.repos.lessons.listByGeneration(generationId).length).toBeGreaterThan(0);
    expect(harness.repos.sources.all(generationId).length).toBeGreaterThan(0);
    expect(harness.repos.jobs.byId(job.jobId)?.state).toBe("completed");
  });

  test("a failure rolls back generation, lessons, sources, event state and cursor", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const input = generationInput(harness, { sha: SHA_A });
    const job = insertJob(harness, input, "running");

    const generationId = "g_transactiontest" as GenerationId;
    const workspace = harness.publisher.buildWorkspace(job.jobId);
    await mkdir(workspace.knowledgeDir, { recursive: true });
    await writeFile(
      path.join(workspace.knowledgeDir, "lesson.json"),
      JSON.stringify({ lesson: true }),
      "utf8",
    );
    const manifest = await harness.publisher.seal(
      workspace.knowledgeDir,
      generationId,
    );

    const eventId = "e_transactiontest" as ChangeEventId;
    const at = harness.clock.now().toISOString();
    harness.repos.changes.insertMany([
      {
        eventId,
        eventKey: "event-key",
        repoId: harness.repoId,
        projectId: "p_transaction" as ProjectId,
        streamId: "main",
        streamKind: "default_branch",
        kind: "commit",
        baseSha: SHA_A,
        headSha: SHA_B,
        mergeBaseSha: SHA_A,
        baseContextSha: null,
        significance: "full",
        state: "discovered",
        jobId: null,
        gapReason: null,
        linkedEventId: null,
        linkRelation: null,
        discoveredAt: at,
        publishedAt: null,
        payload: { commit: { firstParent: SHA_A, associatedCommits: [] } },
      },
    ]);
    const cursor = emptyCursor("default_branch");
    expect(
      harness.repos.cursors.put({
        repoId: harness.repoId,
        streamId: "main",
        kind: "published",
        cursor,
        expectedPrevious: null,
      }),
    ).toBe(true);

    const badLesson: LessonRow = {
      lessonId: "l_transactiontest" as LessonRow["lessonId"],
      // FK to a generation that does not exist ⇒ the whole transaction rolls back.
      generationId: "g_missing" as GenerationId,
      kind: "research",
      title: "bad",
      relPath: "lessons/bad.json",
      jsonSha256: "0".repeat(64),
      publishedAt: at,
    };
    const commit: PublishCommit = {
      manifest,
      generationId,
      jobId: job.jobId,
      kind: "research",
      comparisonBaseSha: null,
      lessons: [badLesson],
      sources: [],
      changeEventId: eventId,
      linkedEventId: null,
      linkRelation: null,
      publishedCursor: {
        repoId: harness.repoId,
        streamId: "main",
        kind: "published",
        cursor: { ...cursor, headSha: SHA_A, lastPollAt: at },
        expectedPrevious: { headSha: null, updatedAt: null },
      },
    };

    await expect(harness.publisher.publishAtomic(commit)).rejects.toThrow();

    expect(harness.repos.generations.byId(generationId)).toBeNull();
    expect(harness.repos.lessons.listByGeneration(generationId)).toEqual([]);
    expect(harness.repos.sources.all(generationId)).toEqual([]);
    expect(harness.repos.changes.byId(eventId)?.state).toBe("discovered");
    expect(
      harness.repos.cursors.get(harness.repoId, "main", "published")?.headSha,
    ).toBeNull();
    expect(harness.repos.jobs.byId(job.jobId)?.state).toBe("running");
  });

  test("buildWorkspace is the same algebra as config/paths", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const job = insertJob(harness, generationInput(harness, { sha: SHA_A }), "queued");
    const workspace = harness.publisher.buildWorkspace(job.jobId);
    const { stagingPath, stagingTreePath, stagingKnowledgePath } = await import(
      "../../../src/learning/config/paths.ts"
    );
    expect(workspace.stagingDir).toBe(stagingPath(harness.paths, job.jobId));
    expect(workspace.treeDir).toBe(stagingTreePath(harness.paths, job.jobId));
    expect(workspace.knowledgeDir).toBe(
      stagingKnowledgePath(harness.paths, job.jobId),
    );
    expect(workspace.lessonsDir).toBe(
      path.join(workspace.knowledgeDir, "lessons"),
    );
    expect(workspace.knowledgeDir).not.toBe(
      knowledgePath(harness.paths, "g_other" as GenerationId),
    );
  });

  test("a cancel that lands during publish rolls the generation back", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const job = insertJob(
      harness,
      generationInput(harness, { sha: SHA_A }),
      "running",
    );
    const generationId = "g_cancelrace" as GenerationId;
    const workspace = harness.publisher.buildWorkspace(job.jobId);
    await mkdir(workspace.knowledgeDir, { recursive: true });
    await writeFile(
      path.join(workspace.knowledgeDir, "page.md"),
      "# page\n",
      "utf8",
    );
    const manifest = await harness.publisher.seal(
      workspace.knowledgeDir,
      generationId,
    );
    const commit: PublishCommit = {
      manifest,
      generationId,
      jobId: job.jobId,
      kind: "research",
      comparisonBaseSha: null,
      lessons: [],
      sources: [],
      changeEventId: null,
      linkedEventId: null,
      linkRelation: null,
      publishedCursor: null,
    };

    // `publishAtomic` yields while the staging tree is renamed; the cancel
    // lands in that window, after the entry check has already passed.
    const publishing = harness.publisher.publishAtomic(commit);
    const cancelling = await harness.runner.cancel(job.jobId);
    expect(cancelling.state).toBe("cancelling");

    await expect(publishing).rejects.toThrow();
    expect(harness.repos.generations.byId(generationId)).toBeNull();
    expect(harness.repos.jobs.byId(job.jobId)?.state).toBe("cancelling");

    // The rename happened, but no row references the directory: GC reclaims it.
    const renamed = knowledgePath(harness.paths, generationId);
    expect(existsSync(renamed)).toBe(true);
    const report = await harness.publisher.gc();
    expect(report.removedKnowledge).toContain(generationId);
    expect(existsSync(renamed)).toBe(false);
  });

  test("gc reclaims unreferenced directories and keeps published and in-flight ones", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const published = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_A }),
    );
    const publishedId = published.outputGenerationId!;

    const orphanStaging = path.join(harness.paths.staging, "j_orphan");
    await mkdir(orphanStaging, { recursive: true });
    await writeFile(path.join(orphanStaging, "junk.txt"), "junk", "utf8");
    const orphanKnowledge = knowledgePath(
      harness.paths,
      "g_orphan" as GenerationId,
    );
    await mkdir(orphanKnowledge, { recursive: true });
    await writeFile(path.join(orphanKnowledge, "junk.txt"), "junk", "utf8");

    const queued = insertJob(
      harness,
      generationInput(harness, { sha: SHA_B }),
      "queued",
    );
    const running = insertJob(
      harness,
      generationInput(harness, { sha: SHA_C }),
      "running",
    );
    for (const job of [queued, running]) {
      const workspace = harness.publisher.buildWorkspace(job.jobId);
      await mkdir(workspace.treeDir, { recursive: true });
      await writeFile(path.join(workspace.treeDir, "keep.txt"), "x", "utf8");
    }
    const queuedDir = harness.publisher.buildWorkspace(queued.jobId).stagingDir;
    const runningDir = harness.publisher.buildWorkspace(running.jobId).stagingDir;

    const report = await harness.publisher.gc();

    expect(report.removedWorkspaces).toContain(orphanStaging);
    expect(report.removedWorkspaces).not.toContain(queuedDir);
    expect(report.removedWorkspaces).not.toContain(runningDir);
    expect(report.removedKnowledge).toContain("g_orphan" as GenerationId);
    expect(report.keptPublished).toBe(1);
    expect(report.keptInFlight).toBe(2);
    expect(report.bytesFreed).toBeGreaterThan(0);

    expect(existsSync(orphanStaging)).toBe(false);
    expect(existsSync(orphanKnowledge)).toBe(false);
    expect(existsSync(knowledgePath(harness.paths, publishedId))).toBe(true);
    expect(existsSync(queuedDir)).toBe(true);
    expect(existsSync(runningDir)).toBe(true);
  });
});
