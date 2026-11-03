import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupHarness,
  createUpdateHarness,
  type UpdateHarness,
} from "./harness.ts";

/**
 * AC-UPD-06: five first-parent nodes in one poll produce five events with no
 * loss, computed from local Git (never a single GitHub compare response).
 */
describe("multiple first-parent nodes", () => {
  let harness: UpdateHarness | undefined;

  afterEach(() => {
    cleanupHarness(harness);
    harness = undefined;
  });

  it("creates one event per node in a single tick", async () => {
    harness = await createUpdateHarness();
    await harness.tick();

    const expected: string[] = [];
    for (let index = 1; index <= 5; index += 1) {
      harness.git.write(`src/node-${index}.ts`, `export const n = ${index};\n`);
      expected.push(harness.git.commit(`feat: node ${index}`));
    }

    const result = await harness.tick();
    expect(result.discovered).toBe(5);
    expect(result.enqueued).toBe(5);

    const events = harness.events().filter((event) => event.kind === "commit");
    expect(events).toHaveLength(5);
    expect(events.map((event) => event.headSha).sort()).toEqual(
      [...expected].sort(),
    );
    expect(harness.discoveryCursor()?.headSha).toBe(expected[4]);
  });
});
