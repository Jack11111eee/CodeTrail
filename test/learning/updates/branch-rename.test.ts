import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupHarness,
  createUpdateHarness,
  type UpdateHarness,
} from "./harness.ts";

/**
 * AC-UPD-15: a default-branch rename records `branch_switch` before a new
 * baseline; events from the old stream are retained.
 */
describe("branch rename", () => {
  let harness: UpdateHarness | undefined;

  afterEach(() => {
    cleanupHarness(harness);
    harness = undefined;
  });

  it("records branch_switch first, then baselines on the new branch", async () => {
    harness = await createUpdateHarness();
    const oldHead = harness.git.head("main");
    await harness.tick();

    harness.git.write("src/next.ts", "export const next = 1;\n");
    const newHead = harness.git.commit("feat: next");
    harness.git.renameBranch("main", "trunk");
    harness.github.setBranch("trunk");

    const result = await harness.tick();
    expect(result.discovered).toBeGreaterThanOrEqual(2);

    const events = harness.events();
    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain("branch_switch");
    expect(kinds.filter((kind) => kind === "baseline")).toHaveLength(2);

    const switchEvent = events.find((event) => event.kind === "branch_switch");
    expect(switchEvent?.payload.fromBranch).toBe("main");
    expect(switchEvent?.payload.toBranch).toBe("trunk");
    expect(switchEvent?.baseSha).toBe(oldHead);

    const newBaseline = events.find(
      (event) => event.kind === "baseline" && event.headSha === newHead,
    );
    expect(newBaseline).toBeDefined();

    // Old events are retained, not deleted.
    expect(
      events.some(
        (event) => event.kind === "baseline" && event.headSha === oldHead,
      ),
    ).toBe(true);
    expect(harness.discoveryCursor()?.branch).toBe("trunk");
    expect(harness.discoveryCursor()?.headSha).toBe(newHead);
  });

  it("does not duplicate the baseline when a branch is renamed without a commit", async () => {
    harness = await createUpdateHarness();
    const head = harness.git.head("main");
    await harness.tick();
    expect(
      harness.events().filter((event) => event.kind === "baseline"),
    ).toHaveLength(1);

    // The default branch changes name but its head already has a baseline.
    harness.git.renameBranch("main", "trunk");
    harness.github.setBranch("trunk");

    // Discovery must not throw on the second baseline's `UNIQUE(event_key)`.
    const result = await harness.tick();
    expect(result.discovered).toBeGreaterThanOrEqual(1);

    const events = harness.events();
    expect(events.some((event) => event.kind === "branch_switch")).toBe(true);
    expect(events.filter((event) => event.kind === "baseline")).toHaveLength(1);
    expect(harness.discoveryCursor()?.branch).toBe("trunk");
    expect(harness.discoveryCursor()?.headSha).toBe(head);

    // The cursor advanced, so a follow-up tick is a quiet no-op.
    const next = await harness.tick();
    expect(next.discovered).toBe(0);
    expect(harness.discoveryCursor()?.branch).toBe("trunk");
  });
});
