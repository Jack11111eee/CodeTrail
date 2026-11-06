import { afterEach, describe, expect, it } from "vitest";
import {
  computeScopeHash,
  type ProjectRecord,
} from "../../../src/learning/contracts/index.ts";
import { latestProjectJob } from "../../../src/learning/api/jobs/project-job.ts";
import {
  createHarness,
  generationInput,
  insertJob,
  SHA_A,
  type Harness,
} from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.close();
});

async function setup() {
  const h = await createHarness();
  harnesses.push(h);
  const old: ProjectRecord = {
    projectId: "p_removed" as never,
    repoId: h.repoId,
    kind: "local",
    displayName: "Example",
    remoteUrl: null,
    defaultBranch: "main",
    scope: h.scope,
    watchEnabled: false,
    createdAt: h.clock.now().toISOString(),
    deletedAt: h.clock.now().toISOString(),
  };
  const current: ProjectRecord = {
    ...old,
    projectId: "p_reimported" as never,
    deletedAt: null,
  };
  h.repos.projects.insert(old);
  h.repos.projects.insert(current);
  const input = {
    ...generationInput(h, { sha: SHA_A }),
    projectId: old.projectId,
  };
  const job = insertJob(h, input, "cancelled", { attempt: 5 });
  h.repos.jobs.updateProgress(job.jobId, {
    phase: "pages",
    done: 7,
    total: 22,
    resumeAvailable: true,
  });
  return { h, old, current, job };
}

describe("resuming an unpublished task after re-import", () => {
  it("finds the original checkpoint through the current project and retries the same job under its active owner", async () => {
    const { h, current, job } = await setup();
    expect(latestProjectJob(h.repos, current)?.jobId).toBe(job.jobId);
    const continued = await h.runner.retry(job.jobId);
    expect(continued).toMatchObject({
      jobId: job.jobId,
      attempt: 6,
      projectId: current.projectId,
    });
    await h.runner.drain();
    const completed = (await h.runner.get(job.jobId))!;
    expect(completed.state, completed.errorDetail ?? "").toBe("completed");
    expect(
      h.repos.generations.byId(completed.outputGenerationId!)?.projectId,
    ).toBe(current.projectId);
  });

  it("refuses a different read scope and preserves the stopped task", async () => {
    const { h, current, job } = await setup();
    const scope = { ...h.scope, include: ["src/**"] };
    h.repos.projects.setWatch(current.projectId, false, {
      ...scope,
      hash: computeScopeHash(scope),
    });
    expect(
      latestProjectJob(h.repos, h.repos.projects.byId(current.projectId)!),
    ).toBeNull();
    await expect(h.runner.retry(job.jobId)).rejects.toMatchObject({
      code: "source_removed",
    });
    expect((await h.runner.get(job.jobId))?.attempt).toBe(5);
  });

  it("does not choose between multiple matching live imports", async () => {
    const { h, current, job } = await setup();
    h.repos.projects.insert({ ...current, projectId: "p_another" as never });
    expect(latestProjectJob(h.repos, current)).toBeNull();
    await expect(h.runner.retry(job.jobId)).rejects.toMatchObject({
      code: "source_removed",
    });
  });

  it("does not borrow jobs from another active project", async () => {
    const { h, old, current } = await setup();
    h.db.raw
      .prepare("UPDATE projects SET deleted_at = NULL WHERE project_id = ?")
      .run(old.projectId);
    expect(latestProjectJob(h.repos, current)).toBeNull();
  });
});
