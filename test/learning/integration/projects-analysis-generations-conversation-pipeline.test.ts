/**
 * Merge boundary: project import ◊ analysis job ◊ published generation reads ◊
 * conversation binding (PRD §5, AC-API-02/03/04/09).
 *
 * `routes-projects` owns import/analysis/job/generation reads and
 * `routes-conversations` owns conversation binding. They were built apart, so
 * this suite drives one real server end to end:
 *
 *   POST /api/projects → POST .../analyses → GET /api/jobs/:id (SSE too)
 *   → GET project detail → GET lessons/lesson/source/coverage
 *   → POST /api/conversations (same generation, then a foreign lesson id)
 *
 * Two analyses whose scopes differ must produce two generations while an
 * identical resubmission dedupes to one job. The conversation route must then
 * enforce generation ownership with `409 version_mismatch` instead of letting
 * a lesson from one generation be bound to another.
 */

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ConversationView,
  CoverageReport,
  CreateAnalysisResponse,
  CreateComparisonResponse,
  CreateProjectResponse,
  DependentsView,
  JobView,
  LessonDetailView,
  LessonListView,
  ProjectDetail,
  ProjectListView,
  SourceView,
} from "../../../src/learning/contracts/index.ts";
import { fixturePath, fixtureSha } from "../helpers/git-fixture.ts";
import { httpRequest, jsonBody, errorCode } from "../helpers/stub-server.ts";
import { startMergedServer, type MergedServer } from "./merged-learning-server.ts";

let server: MergedServer | undefined;

function get(path: string) {
  return httpRequest(server!.port, {
    path,
    headers: { ...server!.cookie },
  });
}

function post(path: string, body: unknown) {
  return httpRequest(server!.port, {
    method: "POST",
    path,
    headers: { ...server!.cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function detailsOf(response: { text: string }): Record<string, unknown> {
  const parsed = jsonBody(response as never) as {
    error?: { details?: Record<string, unknown> };
  };
  return parsed?.error?.details ?? {};
}

beforeEach(async () => {
  server = await startMergedServer();
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("import → analysis → generation → conversation", () => {
  it("runs the merged pipeline and keeps generation ownership strict", async () => {
    const localPath = fixturePath("last-mile-mini");
    const headSha = fixtureSha("last-mile-mini", "HEAD");

    // ── the precheck in validate.ts runs before the strict union ───────────
    const ambiguous = await post("/api/projects", {
      localPath,
      githubUrl: "https://github.com/acme/widgets",
    });
    expect(ambiguous.status).toBe(400);
    expect(errorCode(ambiguous)).toBe("invalid_input");
    expect(detailsOf(ambiguous).reason).toBe("local_path_and_url");

    const emptyList = jsonBody(await get("/api/projects")) as ProjectListView;
    expect(emptyList.projects).toEqual([]);

    // ── import ────────────────────────────────────────────────────────────
    const created = await post("/api/projects", { localPath });
    expect(created.status).toBe(201);
    const ids = jsonBody(created) as CreateProjectResponse;
    expect(ids.projectId).toMatch(/^p_/u);

    // ── identical submissions share one job (AC-API-09) ───────────────────
    const first = await post(`/api/projects/${ids.projectId}/analyses`, {
      ref: "HEAD",
    });
    expect(first.status).toBe(202);
    const submission = jsonBody(first) as CreateAnalysisResponse;
    const again = await post(`/api/projects/${ids.projectId}/analyses`, {
      ref: "HEAD",
    });
    expect(again.status).toBe(202);
    expect((jsonBody(again) as CreateAnalysisResponse).jobId).toBe(
      submission.jobId,
    );
    expect(
      server!.repos.jobs.listByProject(ids.projectId as never, [
        "queued",
        "running",
        "cancelling",
        "completed",
        "failed",
        "cancelled",
        "interrupted",
      ]),
    ).toHaveLength(1);

    await server!.jobRunner.drain();

    // ── durable job view and the display-only SSE view agree ──────────────
    const jobResponse = await get(`/api/jobs/${submission.jobId}`);
    expect(jobResponse.status).toBe(200);
    const job = jsonBody(jobResponse) as JobView;
    expect(job.state).toBe("completed");
    expect(job.outputGenerationId).toBe(submission.generationId);
    expect(job.retryable).toBe(false);

    const events = await get(`/api/jobs/${submission.jobId}/events`);
    expect(events.status).toBe(200);
    expect(events.text).toContain("event: state");
    expect(events.text).toContain('"completed"');

    // ── project detail reflects the job + the published generation ────────
    const detail = jsonBody(
      await get(`/api/projects/${ids.projectId}`),
    ) as ProjectDetail;
    expect(detail.analyzedCommitSha).toBe(headSha);
    expect(detail.latestJobState).toBe("completed");
    expect(detail.lastSuccessAt).not.toBeNull();
    expect(detail.generationCount).toBe(1);
    expect(detail.coverage).toEqual({ complete: true, gapCount: 0 });

    // ── generation reads are served from the sealed content ───────────────
    const lessonsResponse = await get(
      `/api/generations/${submission.generationId}/lessons`,
    );
    expect(lessonsResponse.status).toBe(200);
    const lessons = jsonBody(lessonsResponse) as LessonListView;
    expect(lessons.commitSha).toBe(headSha);
    expect(lessons.lessons).toHaveLength(1);
    const firstLessonId = lessons.lessons[0].lessonId;

    const lessonResponse = await get(
      `/api/generations/${submission.generationId}/lessons/${firstLessonId}`,
    );
    expect(lessonResponse.status).toBe(200);
    const lesson = jsonBody(lessonResponse) as LessonDetailView;
    expect(lesson.lesson.kind).toBe("research");
    expect(lesson.lesson.context.commitSha).toBe(headSha);
    expect(lesson.diagram.kind).toBe("component");

    const firstSourceId = lesson.lesson.evidence[0];
    const sourceResponse = await get(
      `/api/generations/${submission.generationId}/sources/${firstSourceId}`,
    );
    expect(sourceResponse.status).toBe(200);
    const source = jsonBody(sourceResponse) as SourceView;
    expect(source.commitSha).toBe(headSha);
    expect(source.availability).toBe("available");
    // The source route re-reads the immutable snapshot at the pinned commit,
    // so its body must equal the fixture file byte for byte.
    const row = server!.repos.sources.get(
      submission.generationId,
      firstSourceId,
    );
    const sourcePath = (
      JSON.parse(row!.payloadJson) as { path: string }
    ).path;
    expect(source.content).toBe(
      fs.readFileSync(path.join(localPath, sourcePath), "utf8"),
    );

    const coverageResponse = await get(
      `/api/generations/${submission.generationId}/coverage`,
    );
    expect(coverageResponse.status).toBe(200);
    expect((jsonBody(coverageResponse) as CoverageReport).complete).toBe(true);

    // ── a conversation binds the published generation ─────────────────────
    const conversationResponse = await post("/api/conversations", {
      generationIds: [submission.generationId],
      lessonId: firstLessonId,
      moduleId: "src",
    });
    expect(conversationResponse.status).toBe(201);
    const conversation = jsonBody(conversationResponse) as ConversationView;
    expect(conversation.generationIds).toEqual([submission.generationId]);
    expect(conversation.selections[0]?.lessonId).toBe(firstLessonId);

    // ── a changed scope is a new job and a new generation ─────────────────
    const scoped = await post(`/api/projects/${ids.projectId}/analyses`, {
      ref: "HEAD",
      scope: { include: ["src/**"] },
    });
    expect(scoped.status).toBe(202);
    const scopedSubmission = jsonBody(scoped) as CreateAnalysisResponse;
    expect(scopedSubmission.jobId).not.toBe(submission.jobId);
    expect(scopedSubmission.generationId).not.toBe(submission.generationId);
    await server!.jobRunner.drain();

    const secondLessons = jsonBody(
      await get(`/api/generations/${scopedSubmission.generationId}/lessons`),
    ) as LessonListView;
    expect(secondLessons.lessons).toHaveLength(1);
    expect(secondLessons.lessons[0].lessonId).not.toBe(firstLessonId);

    // ── cross-generation lesson/source access is 409, not 404 ─────────────
    const foreignLesson = await get(
      `/api/generations/${scopedSubmission.generationId}/lessons/${firstLessonId}`,
    );
    expect(foreignLesson.status).toBe(409);
    expect(errorCode(foreignLesson)).toBe("version_mismatch");
    expect(detailsOf(foreignLesson).ownerGenerationId).toBe(
      submission.generationId,
    );

    const foreignSource = await get(
      `/api/generations/${scopedSubmission.generationId}/sources/${firstSourceId}`,
    );
    expect(foreignSource.status).toBe(409);
    expect(errorCode(foreignSource)).toBe("version_mismatch");

    // The conversation route applies the same ownership rule before opening
    // a stream (assertSelectionOwned).
    const crossBound = await post("/api/conversations", {
      generationIds: [scopedSubmission.generationId],
      lessonId: firstLessonId,
    });
    expect(crossBound.status).toBe(409);
    expect(errorCode(crossBound)).toBe("version_mismatch");

    const sameGeneration = await post("/api/conversations", {
      generationIds: [scopedSubmission.generationId],
      moduleId: "src",
    });
    expect(sameGeneration.status).toBe(201);

    // ── a comparison is a job, an inbox event and a readable generation ───
    const comparisonResponse = await post(
      `/api/projects/${ids.projectId}/comparisons`,
      { baseSha: "HEAD~1", headSha: "HEAD" },
    );
    expect(comparisonResponse.status).toBe(202);
    const comparison = jsonBody(
      comparisonResponse,
    ) as CreateComparisonResponse;
    expect(comparison.jobId).toMatch(/^j_/u);
    await server!.jobRunner.drain();

    const comparisonLessons = jsonBody(
      await get(`/api/generations/${comparison.generationId}/lessons`),
    ) as LessonListView;
    expect(comparisonLessons.lessons).toHaveLength(1);
    expect(comparisonLessons.lessons[0].kind).toBe("comparison");

    const changeEvents = server!.repos.changes.page(
      ids.projectId,
      null,
      100,
    ).items;
    expect(changeEvents).toHaveLength(1);
    expect(changeEvents[0].kind).toBe("comparison");
    expect(changeEvents[0].streamKind).toBe("comparison");
    expect(changeEvents[0].baseSha).toBe(
      fixtureSha("last-mile-mini", "HEAD~1"),
    );
    expect(changeEvents[0].headSha).toBe(headSha);
    expect(changeEvents[0].mergeBaseSha).toBe(changeEvents[0].baseSha);

    const dependents = jsonBody(
      await get(`/api/projects/${ids.projectId}/dependents`),
    ) as DependentsView;
    expect(dependents.changeEvents.count).toBe(1);
    expect(dependents.changeEvents.ids).toEqual([changeEvents[0].eventId]);
    expect(dependents.generations.count).toBe(3);
  });
});
