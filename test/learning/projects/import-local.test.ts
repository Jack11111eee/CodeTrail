import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CreateAnalysisResponse,
  CreateProjectResponse,
  ProjectDetail,
  ProjectListView,
} from "../../../src/learning/contracts/index.ts";
import { fixturePath, fixtureSha } from "../helpers/git-fixture.ts";
import { httpRequest, jsonBody } from "../helpers/stub-server.ts";
import { startRoutesHarness, type RoutesHarness } from "./routes-harness.ts";

/**
 * AC-PRJ-01/02/03: a local import is a 201 with `projectId`/`repoId`, appears in
 * the list and detail, and after an analysis the detail carries the analysed
 * commit, the last success instant and the latest job state.
 */

let server: RoutesHarness | undefined;

beforeEach(async () => {
  server = await startRoutesHarness();
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function post(path: string, body: unknown) {
  return httpRequest(server!.port, {
    method: "POST",
    path,
    headers: { ...server!.cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path: string) {
  return httpRequest(server!.port, { path, headers: { ...server!.cookie } });
}

describe("local import", () => {
  it("returns 201, lists the project and exposes analysis state", async () => {
    const localPath = fixturePath("last-mile-mini");
    const sha = fixtureSha("last-mile-mini", "HEAD");

    const created = await post("/api/projects", { localPath });
    expect(created.status).toBe(201);
    const ids = jsonBody(created) as CreateProjectResponse;
    expect(ids.projectId).toMatch(/^p_/u);
    expect(ids.repoId).toMatch(/^r_/u);

    const listed = await get("/api/projects");
    expect(listed.status).toBe(200);
    const list = jsonBody(listed) as ProjectListView;
    expect(list.projects.map((p) => p.projectId)).toContain(ids.projectId);

    const before = await get(`/api/projects/${ids.projectId}`);
    expect(before.status).toBe(200);
    const beforeDetail = jsonBody(before) as ProjectDetail;
    expect(beforeDetail.analyzedCommitSha).toBeNull();
    expect(beforeDetail.lastSuccessAt).toBeNull();
    expect(beforeDetail.latestJobState).toBeNull();
    expect(beforeDetail.defaultBranch).toBe("main");
    expect(beforeDetail.watchEnabled).toBe(false);
    expect(beforeDetail.generationCount).toBe(0);

    const analysis = await post(`/api/projects/${ids.projectId}/analyses`, {
      ref: "HEAD",
    });
    expect(analysis.status).toBe(202);
    const submission = jsonBody(analysis) as CreateAnalysisResponse;
    expect(submission.jobId).toMatch(/^j_/u);
    expect(submission.generationId).toMatch(/^g_/u);
    expect(submission.cacheHit).toBe(false);

    await server!.jobRunner.drain();

    const job = await get(`/api/jobs/${submission.jobId}`);
    expect(job.status).toBe(200);
    const jobView = jsonBody(job) as {
      state: string;
      outputGenerationId: string | null;
    };
    expect(jobView.state).toBe("completed");
    expect(jobView.outputGenerationId).toBe(submission.generationId);

    const after = await get(`/api/projects/${ids.projectId}`);
    expect(after.status).toBe(200);
    const detail = jsonBody(after) as ProjectDetail;
    expect(detail.analyzedCommitSha).toBe(sha);
    expect(detail.lastSuccessAt).not.toBeNull();
    expect(detail.latestJobState).toBe("completed");
    expect(detail.generationCount).toBe(1);
    expect(detail.coverage.complete).toBe(true);
    expect(detail.coverage.gapCount).toBe(0);

    const lessons = await get(
      `/api/generations/${submission.generationId}/lessons`,
    );
    expect(lessons.status).toBe(200);
    const lessonView = jsonBody(lessons) as {
      generationId: string;
      commitSha: string;
      lessons: { lessonId: string }[];
    };
    expect(lessonView.generationId).toBe(submission.generationId);
    expect(lessonView.commitSha).toBe(sha);
    expect(lessonView.lessons.length).toBeGreaterThan(0);

    const lessonId = lessonView.lessons[0].lessonId;
    const lessonDetail = await get(
      `/api/generations/${submission.generationId}/lessons/${lessonId}`,
    );
    expect(lessonDetail.status).toBe(200);
    const lessonBody = jsonBody(lessonDetail) as {
      lesson: { lessonId: string };
      diagram: { kind: string };
      html: string;
    };
    expect(lessonBody.lesson.lessonId).toBe(lessonId);
    expect(lessonBody.diagram.kind).toBeTypeOf("string");
    expect(lessonBody.html).toBeTypeOf("string");

    const coverage = await get(
      `/api/generations/${submission.generationId}/coverage`,
    );
    expect(coverage.status).toBe(200);
    const report = jsonBody(coverage) as {
      complete: boolean;
      gaps: unknown[];
    };
    expect(report.complete).toBe((report.gaps.length === 0));
  });

  it("re-imports the same path as a new project that reuses the repo row", async () => {
    const localPath = fixturePath("last-mile-mini");
    const first = jsonBody(await post("/api/projects", { localPath })) as
      CreateProjectResponse;
    const second = jsonBody(await post("/api/projects", { localPath })) as
      CreateProjectResponse;

    expect(second.repoId).toBe(first.repoId);
    expect(second.projectId).not.toBe(first.projectId);

    const list = jsonBody(await get("/api/projects")) as ProjectListView;
    const ids = list.projects.map((project) => project.projectId);
    expect(ids).toEqual(expect.arrayContaining([first.projectId, second.projectId]));
  });
});
