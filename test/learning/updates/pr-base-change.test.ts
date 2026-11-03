import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupHarness,
  createUpdateHarness,
  makePull,
  type UpdateHarness,
} from "./harness.ts";

/**
 * AC-UPD-10: an unchanged head with a changed base head creates a new job
 * with a different `base_context_sha` and `dedupe_key`.
 */
describe("pull request base change", () => {
  let harness: UpdateHarness | undefined;

  afterEach(() => {
    cleanupHarness(harness);
    harness = undefined;
  });

  it("creates a second event and job when only the base moves", async () => {
    harness = await createUpdateHarness();
    const base = harness.git.head("main");
    harness.git.createBranch("feature");
    harness.git.write("src/feature.ts", "export const feature = 1;\n");
    const head = harness.git.commit("feat: feature");
    harness.git.checkout("main");

    harness.github.setPulls([
      makePull({
        number: 11,
        headSha: head,
        baseHeadSha: base,
        updatedAt: "2024-06-01T00:59:00.000Z",
      }),
    ]);
    await harness.tick();

    harness.git.write("src/main-advance.ts", "export const advance = 1;\n");
    const movedBase = harness.git.commit("feat: advance main");
    harness.github.setPulls([
      makePull({
        number: 11,
        headSha: head,
        baseHeadSha: movedBase,
        updatedAt: "2024-06-01T00:59:40.000Z",
      }),
    ]);
    harness.clock.set("2024-06-01T01:00:30.000Z");
    await harness.tick();

    const prEvents = harness
      .events()
      .filter((event) => event.kind === "pull_request");
    expect(prEvents).toHaveLength(2);
    const contexts = prEvents.map((event) => event.baseContextSha);
    expect(new Set(contexts)).toEqual(new Set([base, movedBase]));

    const jobs = harness
      .jobs()
      .filter((job) => job.streamId === "pull_request:11");
    expect(jobs).toHaveLength(2);
    // The stored dedupe keys themselves must differ (base context is part of
    // the key), so the second job cannot be collapsed into the first.
    expect(new Set(jobs.map((job) => job.dedupeKey)).size).toBe(2);
  });
});
