import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupHarness,
  createUpdateHarness,
  makePull,
  type UpdateHarness,
} from "./harness.ts";

/**
 * AC-UPD-08: a PR that appears in two consecutive overlapping windows yields
 * one `change_events` row and one job.
 */
describe("pull request overlap dedupe", () => {
  let harness: UpdateHarness | undefined;

  afterEach(() => {
    cleanupHarness(harness);
    harness = undefined;
  });

  it("keeps one event and one job across two ticks", async () => {
    harness = await createUpdateHarness();
    const baseHead = harness.git.head("main");
    harness.git.createBranch("feature");
    harness.git.write("src/feature.ts", "export const feature = 1;\n");
    const head = harness.git.commit("feat: feature");
    harness.git.checkout("main");

    harness.github.setPulls([
      makePull({
        number: 7,
        headSha: head,
        baseHeadSha: baseHead,
        updatedAt: "2024-06-01T00:59:30.000Z",
      }),
    ]);

    await harness.tick();
    harness.clock.set("2024-06-01T01:00:30.000Z"); // inside the 120 s overlap
    await harness.tick();

    const prEvents = harness
      .events()
      .filter((event) => event.kind === "pull_request");
    expect(prEvents).toHaveLength(1);
    expect(prEvents[0]?.payload.pr?.headSha).toBe(head);

    const changeJobs = harness
      .jobs()
      .filter((job) => job.kind === "change_analysis");
    expect(changeJobs).toHaveLength(1);
  });
});
