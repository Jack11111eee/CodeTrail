import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupHarness,
  createUpdateHarness,
  type UpdateHarness,
} from "./harness.ts";

/**
 * AC-UPD-05: a merge commit is one default-branch event; commits reachable
 * only through the second parent appear in `payload.commit.associatedCommits`
 * and never become events of their own.
 */
describe("first-parent walking", () => {
  let harness: UpdateHarness | undefined;

  afterEach(() => {
    cleanupHarness(harness);
    harness = undefined;
  });

  it("records a merge commit once and associates second-parent commits", async () => {
    harness = await createUpdateHarness();
    await harness.tick();
    const base = harness.git.head("main");

    harness.git.createBranch("feature");
    harness.git.write("src/feature-a.ts", "export const a = 1;\n");
    harness.git.commit("feat: feature a");
    harness.git.write("src/feature-b.ts", "export const b = 1;\n");
    const featureHead = harness.git.commit("feat: feature b");

    harness.git.checkout("main");
    harness.git.write("src/main.ts", "export const main = 1;\n");
    harness.git.commit("feat: main work");
    const merge = harness.git.merge("feature", "merge: feature");

    const result = await harness.tick();
    expect(result.discovered).toBe(2); // the main commit and the merge commit

    const mergeEvent = harness
      .events()
      .find((event) => event.headSha === merge);
    expect(mergeEvent?.kind).toBe("merge_commit");
    expect(mergeEvent?.payload.commit?.firstParent).not.toBeNull();
    expect(mergeEvent?.payload.commit?.associatedCommits).toContain(
      featureHead,
    );

    // No event is created for the featur-branch commit itself.
    expect(
      harness.events().some((event) => event.headSha === featureHead),
    ).toBe(false);
    expect(mergeEvent?.payload.commit?.firstParent).not.toBe(base);
  });
});
