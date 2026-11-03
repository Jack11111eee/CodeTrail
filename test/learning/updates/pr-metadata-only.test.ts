import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupHarness,
  createUpdateHarness,
  makePull,
  type UpdateHarness,
} from "./harness.ts";

/**
 * AC-UPD-09: a title/state change with an unchanged head updates metadata
 * only: no new job and no rebuilt generation.
 */
describe("pull request metadata-only change", () => {
  let harness: UpdateHarness | undefined;

  afterEach(() => {
    cleanupHarness(harness);
    harness = undefined;
  });

  it("updates the payload without creating another job", async () => {
    harness = await createUpdateHarness();
    const baseHead = harness.git.head("main");
    harness.git.createBranch("feature");
    harness.git.write("src/feature.ts", "export const feature = 1;\n");
    const head = harness.git.commit("feat: feature");
    harness.git.checkout("main");

    const pull = makePull({
      number: 3,
      headSha: head,
      baseHeadSha: baseHead,
      title: "Original title",
      updatedAt: "2024-06-01T00:59:00.000Z",
    });
    harness.github.setPulls([pull]);
    await harness.tick();

    harness.github.setPulls([
      {
        ...pull,
        title: "Renamed title",
        state: "closed",
        updatedAt: "2024-06-01T00:59:40.000Z",
      },
    ]);
    harness.clock.set("2024-06-01T01:00:30.000Z");
    await harness.tick();

    const prEvents = harness
      .events()
      .filter((event) => event.kind === "pull_request");
    expect(prEvents).toHaveLength(1);
    expect(prEvents[0]?.payload.pr?.title).toBe("Renamed title");
    expect(prEvents[0]?.payload.pr?.state).toBe("closed");
    expect(
      harness.jobs().filter((job) => job.kind === "change_analysis"),
    ).toHaveLength(1);
    expect(
      harness.repos.generations.listByProject(harness.project.projectId),
    ).toHaveLength(0);
  });
});
