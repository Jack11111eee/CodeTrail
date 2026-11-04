import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CreateComparisonResponse,
  CreateProjectResponse,
} from "../../../src/learning/contracts/index.ts";
import { fixturePath } from "../helpers/git-fixture.ts";
import { errorCode, httpRequest, jsonBody } from "../helpers/stub-server.ts";
import { startRoutesHarness, type RoutesHarness } from "./routes-harness.ts";

/**
 * AC-PRJ-13 (comparison half): a manual comparison of two readable commits
 * creates a comparison job **and** a change event; repeating the identical
 * submission reuses both. The watch-toggle half belongs to `routes-changes`.
 */

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

function compare(body: unknown) {
  return httpRequest(server!.port, {
    method: "POST",
    path: `/api/projects/${projectId}/comparisons`,
    headers: { ...server!.cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("manual comparison", () => {
  it("creates a comparison job plus one change event", async () => {
    const request = { baseSha: "HEAD~2", headSha: "HEAD" };
    const first = await compare(request);
    expect(first.status).toBe(202);
    const submission = jsonBody(first) as CreateComparisonResponse;
    expect(submission.jobId).toMatch(/^j_/u);
    expect(submission.generationId).toMatch(/^g_/u);

    const job = await server!.jobRunner.get(submission.jobId);
    expect(job?.kind).toBe("comparison");
    expect(job?.projectId).toBe(projectId);
    expect(job?.streamId).toMatch(/^cmp:/u);

    const page = server!.repos.changes.page(projectId as never, null, 10);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      kind: "comparison",
      streamKind: "comparison",
      jobId: submission.jobId,
    });
    expect(page.items[0]?.baseSha).toBe(
      job?.payload.kind === "comparison" ? job.payload.baseSha : null,
    );

    // The same comparison is the same job and the same event.
    const second = await compare(request);
    expect(second.status).toBe(202);
    expect((jsonBody(second) as CreateComparisonResponse).jobId).toBe(
      submission.jobId,
    );
    expect(
      server!.repos.changes.page(projectId as never, null, 10).items,
    ).toHaveLength(1);
  });

  it("rejects a ref that does not resolve", async () => {
    const response = await compare({
      baseSha: "HEAD",
      headSha: "no-such-branch",
    });
    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe("invalid_input");
    expect(
      (jsonBody(response) as { error?: { details?: { reason?: string } } }).error
        ?.details?.reason,
    ).toBe("unknown_ref");
  });
});
