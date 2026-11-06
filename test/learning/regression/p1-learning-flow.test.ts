import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppDeps } from "../../../src/learning/api/cli.ts";
import { handlers as settings } from "../../../src/learning/api/routes/settings.ts";
import { createStaticUi } from "../../../src/learning/api/static.ts";
import { resolveDataPaths } from "../../../src/learning/config/paths.ts";
import {
  computeCacheKey,
  computeConfigHash,
  type AppDeps,
  type RouteRequest,
} from "../../../src/learning/contracts/index.ts";
import { UPSTREAM_VERSION } from "../../../src/learning/config/defaults.ts";
import { insertJobRow } from "../../../src/learning/updates/discovery.ts";
import { createRemovalService } from "../../../src/learning/projects/removal.ts";
import {
  createHarness,
  generationInput,
  comparisonInput,
  seedPublishedGeneration,
  SHA_A,
  SHA_B,
  SHA_C,
} from "../generation/harness.ts";
import * as qa from "../qa/qa-helpers.ts";
import * as fixtures from "../ui/fixtures.ts";
const request = (body = {}, params = {}, query = {}) =>
  ({
    body,
    params,
    query,
    headers: {},
    signal: new AbortController().signal,
  }) as RouteRequest;
afterEach(() => qa.cleanupTempDirs());

describe("P1 runtime and durable execution", () => {
  it("activates first model configuration immediately and pins earlier handles", async () => {
    const deps = await createAppDeps({
      ...process.env,
      CODETRAIL_DATA_DIR: process.env.CODETRAIL_DATA_DIR!,
    });
    try {
      expect(deps.model).toBeNull();
      await settings["settings.model.put"]!(deps)(
        request({
          provider: "anthropic",
          model: "model-first",
          apiKey: "audit-secret-key",
        }),
      );
      const first = deps.model!;
      expect(first.modelId).toBe("model-first");
      await settings["settings.model.put"]!(deps)(
        request({ provider: "anthropic", model: "model-next" }),
      );
      expect(deps.model?.modelId).toBe("model-next");
      expect(first.modelId).toBe("model-first");
      expect(JSON.stringify(deps.repos.settings.model())).not.toContain(
        "audit-secret-key",
      );
      const view = await settings["settings.model.get"]!(deps)(request());
      expect(JSON.stringify(view)).not.toContain("audit-secret-key");
      expect(
        fs.statSync(path.join(deps.paths.root, "model-credentials.json")).mode &
          0o777,
      ).toBe(0o600);
      expect(() =>
        settings["settings.model.put"]!(deps)(
          request({ provider: "unsupported", model: "bad" }),
        ),
      ).toThrow();
      expect(deps.model?.modelId).toBe("model-next");
    } finally {
      deps.db.close();
    }
  });
  it("executes committed discovery jobs without a second enqueue", async () => {
    const h = await createHarness();
    try {
      const { jobId } = insertJobRow(
        h.repos,
        generationInput(h, { sha: SHA_A }),
        h.clock.now().toISOString(),
      );
      h.runner.wake!();
      await h.runner.drain();
      expect(h.repos.jobs.byId(jobId)?.state).toBe("completed");
      expect(h.calls.count).toBeGreaterThan(0);
    } finally {
      h.close();
    }
  });
  it("recovers queued rows at startup", async () => {
    const h = await createHarness();
    try {
      const { jobId } = insertJobRow(
        h.repos,
        generationInput(h, { sha: SHA_A }),
        h.clock.now().toISOString(),
      );
      await h.runner.recoverInterrupted();
      await h.runner.drain();
      expect(h.repos.jobs.byId(jobId)?.state).toBe("completed");
    } finally {
      h.close();
    }
  });
  it("does not reuse a comparison for another base sharing head and merge-base", async () => {
    const h = await createHarness();
    try {
      const head = "d".repeat(40),
        mergeBase = SHA_A;
      const key = computeCacheKey({
        kind: "comparison",
        comparisonBaseSha: SHA_B,
        repoIdentity: h.repos.repos.byId(h.repoId)!.identity,
        targetCommitSha: head,
        baseContextSha: mergeBase,
        scopeHash: h.scope.hash,
        generationConfigHash: computeConfigHash(h.config),
        promptTemplateVersion: h.config.promptTemplateVersion,
        preferencesVersion: 0,
        upstreamVersion: UPSTREAM_VERSION,
      });
      const seeded = await seedPublishedGeneration(h, {
        generationId: "g_base_b" as never,
        commitSha: head,
      });
      h.repos.generations.setStatus(seeded.generationId, "published", {
        kind: "comparison",
        comparisonBaseSha: SHA_B,
        cacheKey: key,
      });
      const input = comparisonInput(h, { baseSha: SHA_C, headSha: head });
      input.baseContextSha = mergeBase;
      const job = await h.runner.enqueue(input);
      expect(job.state).toBe("queued");
      expect(job.outputGenerationId).toBeNull();
      await h.runner.cancel(job.jobId);
      await h.runner.drain();
      expect(
        computeCacheKey({
          kind: "comparison",
          comparisonBaseSha: SHA_C,
          repoIdentity: "same",
          targetCommitSha: head,
          baseContextSha: mergeBase,
          scopeHash: "s",
          generationConfigHash: "c",
          promptTemplateVersion: "p",
          preferencesVersion: 0,
          upstreamVersion: "u",
        }),
      ).not.toBe(
        computeCacheKey({
          kind: "comparison",
          comparisonBaseSha: SHA_B,
          repoIdentity: "same",
          targetCommitSha: head,
          baseContextSha: mergeBase,
          scopeHash: "s",
          generationConfigHash: "c",
          promptTemplateVersion: "p",
          preferencesVersion: 0,
          upstreamVersion: "u",
        }),
      );
    } finally {
      h.close();
    }
  });
});

describe("P1 QA accounting and source reads", () => {
  it("records QA usage and blocks the next call before invoking a provider", async () => {
    let calls = 0;
    const h = qa.createHarness({
      modelDir: qa.scriptDir([
        qa.answerEntry(
          { answer: "资料不足。", conclusion: "unknown", citations: [] },
          1,
        ),
      ]),
      onCall: () => {
        calls++;
      },
      filesByGeneration: { g_quota: { "src/index.ts": "export const x=1;" } },
      generationOfCommit: { [qa.COMMIT_A]: "g_quota" },
    });
    try {
      qa.publishGeneration(h.db, { generationId: "g_quota" });
      h.db.repos.settings.putModel({
        ...h.model!.settings,
        quota: { maxCalls: 1, maxInputTokens: 0, maxOutputTokens: 0 },
      });
      const c = await h.conversations.create({
        generationIds: ["g_quota" as never],
      });
      const turn = () =>
        qa.collect(
          h.answers.answer({
            conversationId: c.conversationId,
            text: "解释一下",
            selection: null,
            signal: new AbortController().signal,
          }),
        );
      await turn();
      const events = await turn();
      expect(calls).toBe(1);
      expect(events).toContainEqual(
        expect.objectContaining({ type: "error", code: "budget_exhausted" }),
      );
      expect(h.db.repos.usage.groupByKind("qa")[0].calls).toBe(1);
      expect(
        h.db.repos.conversations
          .messages(c.conversationId)
          .some((message) => message.unknownReason === "budget_exhausted"),
      ).toBe(true);
    } finally {
      h.db.close();
    }
  });
  it("opens source deep links through the same guarded read as the API", async () => {
    const generation = fixtures.GENERATION_ID;
    const h = qa.createHarness({
      filesByGeneration: {
        [generation]: { "src/index.ts": "export const evidence = 'visible';" },
      },
      generationOfCommit: { [fixtures.HEAD_SHA]: generation },
    });
    try {
      const paths = resolveDataPaths(process.env);
      qa.publishGeneration(h.db, {
        generationId: generation,
        repoId: fixtures.REPO_ID,
        projectId: fixtures.PROJECT_ID,
        commitSha: fixtures.HEAD_SHA,
        contentDir: path.join(paths.knowledge, generation),
        sources: [{ sourceId: fixtures.SOURCE_ID, path: "src/index.ts" }],
        lessons: [{ lessonId: fixtures.LESSON_ID }],
        files: {
          [`lessons/${fixtures.LESSON_ID}.json`]: JSON.stringify(
            fixtures.researchLesson(),
          ),
        },
      });
      const deps = {
        paths,
        db: h.db.db,
        repos: h.db.repos,
        clock: h.db.clock,
        snapshotService: h.snapshotService,
        removal: createRemovalService({
          db: h.db.db,
          repos: h.db.repos,
          clock: h.db.clock,
        }),
      } as AppDeps;
      const ui = createStaticUi(deps);
      const read = () =>
        ui.handle(
          request(
            {},
            { path: "/learn/reader" },
            { generation, source: fixtures.SOURCE_ID },
          ),
        );
      const response = await read();
      expect(response?.status).toBe(200);
      expect(JSON.stringify(response)).toContain("evidence = 'visible'");
      h.db.repos.projects.markDeleted(fixtures.PROJECT_ID, qa.AT);
      await expect(read()).rejects.toMatchObject({ code: "source_removed" });
    } finally {
      h.db.close();
    }
  });
  it("keeps user-before-assistant order and pages tied timestamps without loss", async () => {
    const h = qa.createHarness();
    try {
      qa.publishGeneration(h.db, { generationId: "g_order" });
      const c = await h.conversations.create({
        generationIds: ["g_order" as never],
      });
      for (const [id, role] of [
        ["m_z_user", "user"],
        ["m_a_answer", "assistant"],
        ["m_y_user", "user"],
        ["m_b_answer", "assistant"],
      ] as const)
        h.db.repos.conversations.insertMessage({
          messageId: id as never,
          conversationId: c.conversationId,
          role,
          content: id,
          status: "complete",
          answerPhase: "complete",
          citations: [],
          selection: null,
          checks: null,
          unknownReason: null,
          incomplete: false,
          createdAt: qa.AT,
        });
      const rows = h.db.repos.conversations.messages(c.conversationId);
      expect(rows.map((row) => row.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
      const last = h.db.repos.conversations.messages(c.conversationId, {
        limit: 2,
      });
      const first = h.db.repos.conversations.messages(c.conversationId, {
        limit: 2,
        before: last[0].messageId,
      });
      expect([...first, ...last].map((row) => row.messageId)).toEqual(
        rows.map((row) => row.messageId),
      );
    } finally {
      h.db.close();
    }
  });
});
