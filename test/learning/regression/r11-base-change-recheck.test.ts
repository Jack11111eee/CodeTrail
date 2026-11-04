/**
 * AC-R11-02: a moved base with an unchanged head is a new analysis. The second
 * event and job carry a different `base_context_sha` and `dedupe_key`, and the
 * cache key of the old result no longer satisfies the new context, so the old
 * published result can never be reused as the new baseline.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  computeCacheKey,
  computeConfigHash,
  computeDedupeKey,
  generationIdFromCacheKey,
  type GenerationRecord,
} from "../../../src/learning/contracts/index.ts";
import {
  LESSON_PIPELINE_VERSION,
  PROMPT_TEMPLATE_VERSION,
  UPSTREAM_VERSION,
} from "../../../src/learning/config/defaults.ts";
import {
  cleanupHarness,
  createUpdateHarness,
  makePull,
  type UpdateHarness,
} from "../updates/harness.ts";

let harness: UpdateHarness | undefined;

afterEach(() => {
  cleanupHarness(harness);
  harness = undefined;
});

/** The default analysis config discovery hashes for a change job. */
function analysisConfig() {
  return {
    language: "zh" as const,
    model: {
      provider: "unknown",
      model: "unknown",
      maxOutputTokens: 1024,
      temperature: 0,
    },
    pageConcurrency: 1,
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
    lessonPipelineVersion: LESSON_PIPELINE_VERSION,
    includeTests: false,
    externalDocs: { enabled: false, maxPerLesson: 0 },
  };
}

describe("AC-R11-02 — base change re-checks impact", () => {
  it("creates a new job and a new cache key when only the base moves", async () => {
    harness = await createUpdateHarness();
    const firstBase = harness.git.head("main");
    harness.git.createBranch("feature");
    harness.git.write("src/feature.ts", "export const feature = 1;\n");
    const head = harness.git.commit("feat: feature");
    harness.git.checkout("main");

    harness.github.setPulls([
      makePull({
        number: 11,
        headSha: head,
        baseHeadSha: firstBase,
        updatedAt: "2024-06-01T00:59:00.000Z",
      }),
    ]);
    await harness.tick();

    const first = harness
      .jobs()
      .filter((job) => job.streamId === "pull_request:11");
    expect(first).toHaveLength(1);

    const cacheKeyFor = (baseContextSha: string): string =>
      computeCacheKey({
        repoIdentity: harness!.repo.identity,
        targetCommitSha: head,
        baseContextSha,
        scopeHash: harness!.project.scope.hash,
        generationConfigHash: computeConfigHash(analysisConfig()),
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
        preferencesVersion: harness!.repos.prefs.version(),
        upstreamVersion: UPSTREAM_VERSION,
      });

    // Publish the result of the first analysis (as the job would have).
    const firstCacheKey = cacheKeyFor(firstBase);
    const firstGenerationId = generationIdFromCacheKey(firstCacheKey);
    const now = harness.clock.now().toISOString();
    const published: GenerationRecord = {
      generationId: firstGenerationId,
      cacheKey: firstCacheKey,
      repoId: harness.repo.repoId,
      projectId: harness.project.projectId,
      commitSha: head,
      comparisonBaseSha: null,
      kind: "change",
      scopeHash: harness.project.scope.hash,
      configHash: computeConfigHash(analysisConfig()),
      promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
      preferencesVersion: harness.repos.prefs.version(),
      upstreamVersion: UPSTREAM_VERSION,
      status: "published",
      contentDir: "/tmp/r11-base-change",
      sealedTreeHash: "sha256:r11",
      baselineFromGenerationId: null,
      fallbackReason: null,
      jobId: first[0].jobId,
      createdAt: now,
      publishedAt: now,
    };
    harness.repos.generations.insertPublished(published);
    expect(harness.repos.generations.byCacheKey(firstCacheKey)).not.toBeNull();

    // Only the base head moves; the PR head is byte-identical.
    harness.git.write("src/main-advance.ts", "export const advance = 1;\n");
    const secondBase = harness.git.commit("feat: advance main");
    harness.github.setPulls([
      makePull({
        number: 11,
        headSha: head,
        baseHeadSha: secondBase,
        updatedAt: "2024-06-01T00:59:40.000Z",
      }),
    ]);
    harness.clock.advance(30_000);
    await harness.tick();

    const jobs = harness
      .jobs()
      .filter((job) => job.streamId === "pull_request:11");
    expect(jobs).toHaveLength(2);
    const [firstJob, secondJob] = jobs;
    const headOf = (job: (typeof jobs)[number]): string | null =>
      job.payload.kind === "change" ? job.payload.headSha : null;
    expect(headOf(firstJob)).toBe(head);
    expect(headOf(secondJob)).toBe(head);
    const prEvents = harness
      .events()
      .filter((event) => event.kind === "pull_request");
    expect(new Set(prEvents.map((event) => event.baseContextSha))).toEqual(
      new Set([firstBase, secondBase]),
    );
    expect(secondJob?.dedupeKey).not.toBe(firstJob?.dedupeKey);
    expect(secondJob?.jobId).not.toBe(firstJob?.jobId);
    // Independently recomputed dedupe key matches what discovery stored: the
    // base context is part of the identity, so the second job cannot collapse
    // into the first.
    expect(
      computeDedupeKey({
        repoId: harness.repo.repoId,
        streamId: "pull_request:11",
        comparisonBaseSha: null,
        headSha: head,
        baseContextSha: secondBase,
        scopeHash: harness.project.scope.hash,
        analysisConfigHash: computeConfigHash(analysisConfig()),
      }),
    ).toBe(secondJob?.dedupeKey);

    // The old generation cannot satisfy the new context: the new cache key is
    // absent, so the old result is never reused as the new baseline.
    const secondCacheKey = cacheKeyFor(secondBase);
    expect(secondCacheKey).not.toBe(firstCacheKey);
    expect(harness.repos.generations.byCacheKey(secondCacheKey)).toBeNull();
    expect(generationIdFromCacheKey(secondCacheKey)).not.toBe(
      firstGenerationId,
    );
  });
});
