import { afterEach, describe, expect, it } from "vitest";

import { type GenerationId } from "../../../src/learning/contracts/index.ts";
import {
  diffBetween,
  readDeletedFile,
} from "../../../src/learning/updates/diff.ts";
import {
  cleanupHarness,
  createUpdateHarness,
  discoveryOptions,
  makePull,
  type UpdateHarness,
} from "./harness.ts";

/**
 * AC-UPD-21: an unavailable object yields `object_unavailable`, a recorded
 * gap, and never a complete explanation; previously published knowledge stays
 * readable.
 */
describe("object unavailable", () => {
  let harness: UpdateHarness | undefined;

  afterEach(() => {
    cleanupHarness(harness);
    harness = undefined;
  });

  it("reports a gap and keeps deleted-side reads explicit", async () => {
    harness = await createUpdateHarness();
    const head = harness.git.head("main");
    const missing = "f".repeat(40);
    const mirror = {
      repoId: harness.repo.repoId,
      path: harness.git.path,
      identity: harness.repo.identity,
    };
    const diff = await diffBetween(mirror, head, missing, { maxFiles: 100 });
    expect(diff.entries).toHaveLength(0);
    expect(diff.gaps).toContain(missing);

    await expect(
      readDeletedFile(mirror, missing, "src/app.ts"),
    ).rejects.toMatchObject({ code: "object_unavailable" });
  });

  it("records a gap for a PR whose head object is absent", async () => {
    harness = await createUpdateHarness();
    const baseHead = harness.git.head("main");
    const missingHead = "e".repeat(40);

    const generationId = "g_old000000000000" as GenerationId;
    harness.repos.generations.insertPublished({
      generationId,
      cacheKey: "old",
      repoId: harness.repo.repoId,
      projectId: harness.project.projectId,
      commitSha: baseHead,
      comparisonBaseSha: null,
      kind: "research",
      scopeHash: harness.project.scope.hash,
      configHash: "cfg",
      promptTemplateVersion: "v1",
      preferencesVersion: 1,
      upstreamVersion: "u1",
      status: "published",
      contentDir: "/tmp/old",
      sealedTreeHash: "tree",
      baselineFromGenerationId: null,
      fallbackReason: null,
      jobId: null,
      createdAt: harness.clock.now().toISOString(),
      publishedAt: harness.clock.now().toISOString(),
    });

    harness.github.setPulls([
      makePull({
        number: 99,
        headSha: missingHead,
        baseHeadSha: baseHead,
        updatedAt: "2024-06-01T00:25:00.000Z",
      }),
    ]);
    const result = await harness.discovery.tickPullRequests(
      harness.project.projectId,
      discoveryOptions(harness.clock.now()),
    );
    expect(result.gaps).toBe(1);

    const event = harness
      .events()
      .find((candidate) => candidate.kind === "pull_request");
    expect(event?.significance).toBe("full");
    // The old published generation is untouched.
    expect(harness.repos.generations.byId(generationId)).not.toBeNull();
    expect(
      harness.repos.generations.listByProject(harness.project.projectId),
    ).toHaveLength(1);
  });
});
