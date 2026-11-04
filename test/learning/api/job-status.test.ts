import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeConfigHash,
  computeDedupeKey,
  DEFAULT_SCOPE,
  jobIdFromDedupeKey,
  repoIdFromIdentity,
  type EnqueueJobInput,
} from "../../../src/learning/contracts/index.ts";
import { normalizeScope } from "../../../src/learning/projects/scope.ts";
import {
  errorCode,
  httpRequest,
  jsonBody,
  type StubResponse,
} from "../helpers/stub-server.ts";
import { startRoutesHarness, type RoutesHarness } from "../projects/routes-harness.ts";

/**
 * Job routes (§3.8, §14.4): status is the durable row projected to `JobView`,
 * cancel and retry delegate to the runner's state machine, an unknown id is
 * 404, and the display-only SSE stream never mutates state — a reconnect reads
 * exactly what `GET /api/jobs/:id` reports.
 */

let server: RoutesHarness | undefined;

beforeEach(async () => {
  server = await startRoutesHarness();
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function get(path: string): Promise<StubResponse> {
  return httpRequest(server!.port, { path, headers: { ...server!.cookie } });
}

function post(path: string): Promise<StubResponse> {
  return httpRequest(server!.port, {
    method: "POST",
    path,
    headers: { ...server!.cookie },
  });
}

let sequence = 0;

function insertJob(state: "queued" | "failed" | "completed"): {
  jobId: string;
} {
  sequence += 1;
  const commitSha = sequence.toString(16).padStart(40, "c");
  const config = {
    language: "zh" as const,
    model: {
      provider: "stub",
      model: "stub",
      maxOutputTokens: 1024,
      temperature: 0,
    },
    pageConcurrency: 1,
    promptTemplateVersion: "prompt",
    lessonPipelineVersion: "lp1",
    includeTests: false,
    externalDocs: { enabled: false, maxPerLesson: 0 },
  };
  const scope = normalizeScope();
  const input: EnqueueJobInput = {
    kind: "generation_initial",
    repoId: repoIdFromIdentity("local:/tmp/job-routes"),
    projectId: null,
    streamId: null,
    comparisonBaseSha: null,
    headSha: commitSha,
    baseContextSha: null,
    scopeHash: scope.hash,
    analysisConfigHash: computeConfigHash(config),
    payload: {
      kind: "generation",
      mode: "init",
      ref: "HEAD",
      commitSha,
      baseContextSha: null,
      scope: { ...DEFAULT_SCOPE, hash: scope.hash },
      config,
      baselineFromGenerationId: null,
    },
  };
  const dedupeKey = computeDedupeKey(input);
  const jobId = jobIdFromDedupeKey(dedupeKey);
  const at = server!.clock.now().toISOString();
  server!.repos.jobs.insert({
    jobId,
    dedupeKey,
    kind: input.kind,
    repoId: input.repoId,
    projectId: null,
    streamId: null,
    state,
    payload: input.payload,
    attempt: state === "queued" ? 0 : 1,
    errorCode: state === "failed" ? "internal_error" : null,
    errorDetail: state === "failed" ? "boom" : null,
    progress: null,
    outputGenerationId: null,
    createdAt: at,
    startedAt: state === "queued" ? null : at,
    finishedAt: state === "queued" ? null : at,
  });
  return { jobId };
}

describe("job status routes", () => {
  it("returns 404 for an unknown job", async () => {
    const response = await get("/api/jobs/j_missing");
    expect(response.status).toBe(404);
    expect(errorCode(response)).toBe("not_found");
    const events = await get("/api/jobs/j_missing/events");
    expect(events.status).toBe(404);
    expect(errorCode(events)).toBe("not_found");
  });

  it("cancels a queued job and refuses to retry a completed one", async () => {
    const queued = insertJob("queued");
    const cancelled = await post(`/api/jobs/${queued.jobId}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(jsonBody(cancelled)).toMatchObject({
      jobId: queued.jobId,
      state: "cancelled",
    });
    expect(server!.repos.jobs.byId(queued.jobId as never)?.state).toBe(
      "cancelled",
    );

    const done = insertJob("completed");
    const refused = await post(`/api/jobs/${done.jobId}/retry`);
    expect(refused.status).toBe(409);
    expect(errorCode(refused)).toBe("job_not_retryable");
  });

  it("re-queues a failed job with an incremented attempt", async () => {
    const failed = insertJob("failed");
    const retried = await post(`/api/jobs/${failed.jobId}/retry`);
    expect(retried.status).toBe(202);
    await server!.jobRunner.drain();
    const job = server!.repos.jobs.byId(failed.jobId as never);
    expect(job?.attempt).toBe(2);
  });

  it("streams the durable state and agrees with GET /api/jobs/:id", async () => {
    const done = insertJob("completed");
    const view = jsonBody(await get(`/api/jobs/${done.jobId}`)) as {
      state: string;
    };
    expect(view.state).toBe("completed");

    const stream = await get(`/api/jobs/${done.jobId}/events`);
    expect(stream.status).toBe(200);
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    expect(stream.text).toContain("retry: 2000");
    expect(stream.text).toContain("event: state");
    expect(stream.text).toContain("event: done");
    expect(stream.text).toContain('"state":"completed"');
    // Display only: neither the row nor the job table changed.
    expect(server!.repos.jobs.byId(done.jobId as never)?.state).toBe(
      "completed",
    );
  });
});
