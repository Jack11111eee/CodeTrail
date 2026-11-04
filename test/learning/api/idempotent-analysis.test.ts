import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CreateAnalysisResponse,
  CreateProjectResponse,
  JobState,
} from "../../../src/learning/contracts/index.ts";
import { fixturePath } from "../helpers/git-fixture.ts";
import { httpRequest, jsonBody } from "../helpers/stub-server.ts";
import {
  startRoutesHarness,
  type RoutesHarness,
} from "../projects/routes-harness.ts";

/**
 * AC-API-09: identical analyses return the same `jobId` with exactly one `jobs`
 * row, a changed scope hashes to a new job, and a completed job answers with
 * `cacheHit:true` and no extra row.
 */

const ALL_STATES: JobState[] = [
  "queued",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

let server: RoutesHarness | undefined;
let projectId: string;

beforeEach(async () => {
  server = await startRoutesHarness();
  const imported = await httpRequest(server.port, {
    method: "POST",
    path: "/api/projects",
    headers: { ...server.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ localPath: fixturePath("last-mile-mini") }),
  });
  expect(imported.status).toBe(201);
  projectId = (jsonBody(imported) as CreateProjectResponse).projectId;
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function submit(body: unknown) {
  return httpRequest(server!.port, {
    method: "POST",
    path: `/api/projects/${projectId}/analyses`,
    headers: { ...server!.cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function jobsForProject() {
  return server!.repos.jobs.listByProject(projectId as never, ALL_STATES);
}

describe("idempotent analysis", () => {
  it("returns the same jobId for identical input and a new one for a new scope", async () => {
    const first = jsonBody(await submit({ ref: "HEAD" })) as CreateAnalysisResponse;
    const second = jsonBody(await submit({ ref: "HEAD" })) as CreateAnalysisResponse;

    expect(second.jobId).toBe(first.jobId);
    expect(jobsForProject()).toHaveLength(1);

    const changedScope = jsonBody(
      await submit({ ref: "HEAD", scope: { include: ["src/**"] } }),
    ) as CreateAnalysisResponse;
    expect(changedScope.jobId).not.toBe(first.jobId);
    expect(jobsForProject()).toHaveLength(2);

    await server!.jobRunner.drain();

    const cached = jsonBody(await submit({ ref: "HEAD" })) as CreateAnalysisResponse;
    expect(cached.jobId).toBe(first.jobId);
    expect(cached.cacheHit).toBe(true);
    expect(cached.generationId).toBe(first.generationId);
    expect(jobsForProject()).toHaveLength(2);
  });
});
