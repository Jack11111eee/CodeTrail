/**
 * AC-F10-01 — every failure class ends in its own explicit state with staging
 * unpublished, usage and retry scope visible, limits enforced and the previous
 * version readable.
 *
 * One `describe` block per class: a generation failure, a cancellation, an
 * exhausted budget, a rate limit and a missing credential. Each block drives
 * the class through HTTP and reads the resulting state back through the public
 * job, generation and usage surfaces.
 */

import { afterEach, describe, expect, test } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fixturePath } from "../helpers/git-fixture.ts";
import {
  analyzeToCompletion,
  generationScripts,
  importGithub,
  importLocal,
  jsonOf,
  makeBareCopy,
  postJson,
  putJson,
  startAcceptance,
  submitAnalysis,
  waitForJob,
  type AcceptanceServer,
} from "./support.ts";

const SOURCE_PATH = "src/lmp/state/snapshot_cache.py";
const LINES = { start: 6, end: 20 };
const DESIGN_PATH = "docs/decisions/decision-log.md";

let server: AcceptanceServer | null = null;
const tempDirs: string[] = [];

afterEach(async () => {
  await server?.close();
  server = null;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

function goodScripts(target: AcceptanceServer): void {
  target.writeScripts(
    generationScripts({
      sourcePath: SOURCE_PATH,
      lines: LINES,
      designPath: DESIGN_PATH,
      commitSha: target.commitSha,
    }),
  );
}

async function lessonIds(
  target: AcceptanceServer,
  generationId: string,
): Promise<string[]> {
  return jsonOf<{ lessons: { lessonId: string }[] }>(
    await target.request(`/api/generations/${generationId}/lessons`),
    200,
  ).lessons.map((lesson) => lesson.lessonId);
}

async function usageTotals(
  target: AcceptanceServer,
): Promise<{ calls: number; inputTokens: number; outputTokens: number }> {
  return jsonOf<{
    totals: { calls: number; inputTokens: number; outputTokens: number };
  }>(await target.request("/api/usage"), 200).totals;
}

describe("failure: a generation failure is explicit and keeps the old version", () => {
  test("the job fails, nothing is staged and the previous generation still reads", async () => {
    server = await startAcceptance();
    goodScripts(server);
    const project = await importLocal(server);
    const published = await analyzeToCompletion(server, project.projectId);
    expect(published.job.state).toBe("completed");
    const oldGeneration = published.analysis.generationId;
    const oldLessons = await lessonIds(server, oldGeneration);
    expect(oldLessons.length).toBeGreaterThan(0);

    // A lesson that cannot pass the publish gate: nothing may be published.
    server.writeScripts(
      generationScripts({
        sourcePath: SOURCE_PATH,
        lines: LINES,
        designPath: DESIGN_PATH,
        commitSha: server.commitSha,
        lessonOverride: "{}",
      }),
    );
    const failed = await analyzeToCompletion(server, project.projectId, {
      ref: "main",
      scope: { include: ["src/**", "docs/**"] },
    });
    expect(failed.job.state).toBe("failed");
    expect(failed.job.errorCode).toBe("internal_error");
    expect(failed.job.retryable).toBe(true);

    // Staging is unpublished: no generation row is exposed for the failed job.
    expect(failed.job.outputGenerationId).toBeNull();
    const staged = await server.request(
      `/api/generations/${failed.analysis.generationId}/lessons`,
    );
    expect(staged.status).not.toBe(200);
    const detail = jsonOf<{
      generationCount: number;
      analyzedCommitSha: string | null;
    }>(await server.request(`/api/projects/${project.projectId}`), 200);
    expect(detail.generationCount).toBe(1);
    expect(detail.analyzedCommitSha).toBe(server.commitSha);

    // The previous version is still byte-for-byte readable.
    expect(await lessonIds(server, oldGeneration)).toEqual(oldLessons);
    const oldLesson = jsonOf<{ lesson: { lessonId: string } }>(
      await server.request(
        `/api/generations/${oldGeneration}/lessons/${oldLessons[0]}`,
      ),
      200,
    );
    expect(oldLesson.lesson.lessonId).toBe(oldLessons[0]);

    // Retry scope is visible and honoured: a completed job is not retryable.
    const retried = await postJson(
      server,
      `/api/jobs/${published.job.jobId}/retry`,
      {},
    );
    expect(retried.status).toBe(409);
    expect(retried.json).toMatchObject({
      error: { code: "job_not_retryable" },
    });
  }, 180_000);
});

describe("cancel: a cancelled job publishes nothing and stays retryable", () => {
  test("cancelling the queued job leaves the published version intact", async () => {
    server = await startAcceptance();
    goodScripts(server);
    const project = await importLocal(server);
    const published = await analyzeToCompletion(server, project.projectId);
    expect(published.job.state).toBe("completed");

    const queued = await submitAnalysis(server, project.projectId, {
      ref: "main",
      scope: { include: ["src/**", "docs/**"] },
    });
    const cancelled = await postJson(
      server,
      `/api/jobs/${queued.jobId}/cancel`,
      {},
    );
    expect(cancelled.status).toBe(200);
    const final = await waitForJob(server, queued.jobId);
    expect(final.state).toBe("cancelled");
    expect(final.errorCode).toBe("cancelled");
    expect(final.retryable).toBe(true);
    expect(final.outputGenerationId).toBeNull();

    const staged = await server.request(
      `/api/generations/${queued.generationId}/lessons`,
    );
    expect(staged.status).not.toBe(200);
    const detail = jsonOf<{ generationCount: number }>(
      await server.request(`/api/projects/${project.projectId}`),
      200,
    );
    expect(detail.generationCount).toBe(1);

    const oldLessons = await lessonIds(server, published.analysis.generationId);
    expect(oldLessons.length).toBeGreaterThan(0);
    const oldLesson = await server.request(
      `/api/generations/${published.analysis.generationId}/lessons/${oldLessons[0]}`,
    );
    expect(oldLesson.status).toBe(200);

    // The cancelled job can be retried, which is the visible retry scope.
    const retry = await postJson(server, `/api/jobs/${queued.jobId}/retry`, {});
    expect(retry.status).toBe(202);
    const retried = await waitForJob(server, queued.jobId);
    expect(retried.attempt).toBe(2);
    expect(retried.outputGenerationId).toBe(queued.generationId);
  }, 240_000);
});

describe("budget: an exhausted quota stops before the next call", () => {
  test("the job fails with budget_exhausted and usage is still visible", async () => {
    server = await startAcceptance();
    goodScripts(server);
    const project = await importLocal(server);
    const published = await analyzeToCompletion(server, project.projectId);
    expect(published.job.state).toBe("completed");
    const spent = await usageTotals(server);
    expect(spent.calls).toBeGreaterThan(0);

    // Lower the quota to exactly what has been consumed: the next call must be
    // refused before it is issued.
    const settings = jsonOf<{ quota: { maxCalls: number } }>(
      await putJson(server, "/api/settings/model", {
        provider: "fixture",
        model: "fixture",
        quota: {
          maxCalls: spent.calls,
          maxInputTokens: 10_000_000,
          maxOutputTokens: 10_000_000,
        },
      }),
      200,
    );
    expect(settings.quota.maxCalls).toBe(spent.calls);

    const second = await importLocal(server, fixturePath("numbering-schema"));
    const blocked = await analyzeToCompletion(server, second.projectId);
    expect(blocked.job.state).toBe("failed");
    expect(blocked.job.retryable).toBe(true);
    // The quota refusal is explicit and distinguishable from a generic
    // failure: the upstream worker wraps the model error, so the persisted
    // message carries the budget copy end-to-end.
    expect(blocked.job.errorDetail).toContain("配额");

    // Nothing new was published, the old version still reads, and the consumed
    // usage was neither reset nor lost.
    expect(blocked.job.outputGenerationId).toBeNull();
    const staged = await server.request(
      `/api/generations/${blocked.analysis.generationId}/lessons`,
    );
    expect(staged.status).not.toBe(200);
    const oldLessons = await lessonIds(server, published.analysis.generationId);
    expect(oldLessons.length).toBeGreaterThan(0);
    const after = await usageTotals(server);
    expect(after.calls).toBe(spent.calls);
    expect(after.inputTokens).toBeGreaterThanOrEqual(spent.inputTokens);
  }, 240_000);
});

describe("rate limit: the tick reports 429 and a later tick recovers", () => {
  test("a rate-limited discovery tick is explicit and retryable", async () => {
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-bare-"));
    tempDirs.push(bareDir);
    server = await startAcceptance({
      github: {
        ownerRepo: "acme/limited",
        pages: 1,
        perPage: 1,
        retryAfter: 30,
        failFirst: 1,
        gitRepoPath: makeBareCopy("last-mile-mini", bareDir),
      },
    });
    const project = await importGithub(
      server,
      "https://github.com/acme/limited",
    );

    const limited = await putJson(
      server,
      `/api/projects/${project.projectId}/watch`,
      { enabled: true, refreshNow: true },
    );
    expect(limited.status).toBe(429);
    expect(limited.json).toMatchObject({ error: { code: "rate_limited" } });

    // The watch is enabled but nothing was discovered by the failed tick.
    const afterFailure = jsonOf<{ items: unknown[] }>(
      await server.request(`/api/projects/${project.projectId}/changes`),
      200,
    );
    expect(afterFailure.items).toEqual([]);

    // Retry scope is visible: the next tick succeeds and baselines.
    const retried = jsonOf<{
      watchEnabled: boolean;
      refreshed: { discovered: number } | null;
    }>(
      await putJson(server, `/api/projects/${project.projectId}/watch`, {
        enabled: true,
        refreshNow: true,
      }),
      200,
    );
    expect(retried.watchEnabled).toBe(true);
    expect(retried.refreshed?.discovered).toBeGreaterThanOrEqual(1);
  }, 180_000);
});

describe("missing credential: each absence has its own code", () => {
  test("a private import without a token is 401 and a missing model is 400", async () => {
    server = await startAcceptance({
      github: {
        ownerRepo: "acme/secret",
        pages: 1,
        perPage: 1,
        token: "ghp_never_supplied",
      },
    });
    const denied = await server.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ githubUrl: "https://github.com/acme/secret" }),
    });
    expect(denied.status).toBe(401);
    expect(denied.json).toMatchObject({
      error: { code: "github_auth_failed" },
    });

    // A model-less deployment answers its own distinct 400 while reads work.
    const unconfigured = await startAcceptance({ configureModel: false });
    try {
      const local = await server.request("/api/health");
      expect(local.status).toBe(200);
      const response = await unconfigured.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localPath: unconfigured.fixturePath }),
      });
      expect(response.status).toBe(201);
      const projectId = (response.json as { projectId: string }).projectId;
      const analysis = await unconfigured.request(
        `/api/projects/${projectId}/analyses`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ref: "main" }),
        },
      );
      expect(analysis.status).toBe(400);
      expect(analysis.json).toMatchObject({
        error: { code: "model_not_configured" },
      });
      // Reads are still served.
      const list = await unconfigured.request("/api/projects");
      expect(list.status).toBe(200);
    } finally {
      await unconfigured.close();
    }
  }, 180_000);
});
