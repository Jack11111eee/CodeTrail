import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupHarness,
  createUpdateHarness,
  type UpdateHarness,
} from "./harness.ts";

/**
 * AC-UPD-14: a force-push/broken first-parent chain produces a `history_gap`
 * event with the reason and a comparison of the available snapshots. No
 * intermediate versions are claimed.
 */
describe("history gap", () => {
  let harness: UpdateHarness | undefined;

  afterEach(() => {
    cleanupHarness(harness);
    harness = undefined;
  });

  it("records history_gap and a new baseline after a rewrite", async () => {
    harness = await createUpdateHarness();
    const oldHead = harness.git.head("main");
    await harness.tick();

    // An unrelated root: the old head is not an ancestor of the new head.
    harness.git.git(["checkout", "-q", "--orphan", "rewritten"]);
    harness.git.git(["rm", "-rf", "."]);
    harness.git.write("src/rewritten.ts", "export const rewritten = true;\n");
    const newHead = harness.git.commit("rewrite: new root");
    harness.git.forceBranch("main", newHead);
    harness.git.checkout("main");

    const result = await harness.tick();
    expect(result.gaps).toBe(1);

    const events = harness.events();
    const gap = events.find((event) => event.kind === "history_gap");
    expect(gap?.gapReason).toBe("history_gap");
    expect(gap?.baseSha).toBe(oldHead);
    expect(gap?.headSha).toBe(newHead);
    expect(gap?.payload.comparison).toEqual({
      baseSha: oldHead,
      headSha: newHead,
    });

    const baseline = events.find(
      (event) => event.kind === "baseline" && event.headSha === newHead,
    );
    expect(baseline).toBeDefined();
    // No event pretends to recover the intermediate (rewritten) history.
    expect(events.filter((event) => event.kind === "commit")).toHaveLength(0);
    expect(harness.discoveryCursor()?.lastGapSha).toBe(oldHead);
    expect(harness.discoveryCursor()?.headSha).toBe(newHead);
  });
});
