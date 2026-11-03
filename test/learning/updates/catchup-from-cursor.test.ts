import { afterEach, describe, expect, it } from "vitest";

import { createDiscoveryService } from "../../../src/learning/updates/discovery.ts";
import {
  cleanupHarness,
  createUpdateHarness,
  type UpdateHarness,
} from "./harness.ts";

/**
 * AC-UPD-04: after a restart, ticks resume from the discovery cursor. Two
 * commits created while stopped produce exactly two events; nothing before
 * the cursor is reprocessed.
 */
describe("catch-up from cursor", () => {
  let harness: UpdateHarness | undefined;

  afterEach(() => {
    cleanupHarness(harness);
    harness = undefined;
  });

  it("processes only commits after the persisted cursor", async () => {
    harness = await createUpdateHarness();
    await harness.tick();
    const baseline = harness.discoveryCursor();
    expect(baseline?.headSha).toBe(harness.git.head("main"));

    harness.git.write("src/a.ts", "export const a = 1;\n");
    harness.git.commit("feat: a");
    harness.git.write("src/b.ts", "export const b = 1;\n");
    harness.git.commit("feat: b");
    const head = harness.git.head("main");

    // A new process builds a new service over the same database and cursor.
    const restarted = createDiscoveryService({
      db: harness.db,
      repos: harness.repos,
      clock: harness.clock,
      github: harness.github,
      paths: harness.paths,
    });
    const result = await restarted.tickDefaultBranch(
      harness.project.projectId,
      {
        now: harness.clock.now(),
        overlapMs: 120_000,
        perPage: 100,
        maxPages: 20,
      },
    );

    const commits = harness.events().filter((event) => event.kind === "commit");
    expect(commits).toHaveLength(2);
    expect(result.discovered).toBe(2);
    expect(harness.discoveryCursor()?.headSha).toBe(head);
    // The baseline for the pre-cursor head is not repeated.
    expect(
      harness.events().filter((event) => event.kind === "baseline"),
    ).toHaveLength(1);
  });
});
