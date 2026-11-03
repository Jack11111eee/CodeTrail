import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupHarness,
  createUpdateHarness,
  type UpdateHarness,
} from "./harness.ts";

/**
 * AC-UPD-02: the first enable baselines at the current default-branch head and
 * replays no history.
 */
describe("baseline without replay", () => {
  let harness: UpdateHarness | undefined;

  afterEach(() => {
    cleanupHarness(harness);
    harness = undefined;
  });

  it("creates one baseline event at head and nothing for earlier commits", async () => {
    harness = await createUpdateHarness();
    harness.git.write("src/older-1.ts", "export const one = 1;\n");
    harness.git.commit("feat: older 1");
    harness.git.write("src/older-2.ts", "export const two = 2;\n");
    harness.git.commit("feat: older 2");
    const head = harness.git.head("main");

    await harness.tick();

    const events = harness.events();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("baseline");
    expect(events[0]?.headSha).toBe(head);
    expect(events[0]?.baseSha).toBeNull();

    const cursor = harness.discoveryCursor();
    expect(cursor?.headSha).toBe(head);
    expect(cursor?.branch).toBe("main");
  });
});
