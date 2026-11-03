import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupHarness,
  createUpdateHarness,
  type UpdateHarness,
} from "./harness.ts";

/**
 * AC-UPD-01 / AC-PRJ-13 (watch half): enabling watch sets the flag, disabling
 * stops discovery without deleting records, and a local project is rejected
 * with `watch_requires_github` (so filesystem-only changes create no events).
 */
describe("watch toggle", () => {
  let harness: UpdateHarness | undefined;

  afterEach(() => {
    cleanupHarness(harness);
    harness = undefined;
  });

  it("rejects a local project with watch_requires_github", async () => {
    harness = await createUpdateHarness({ projectKind: "local" });
    await expect(harness.tick()).rejects.toMatchObject({
      code: "watch_requires_github",
    });
    expect(harness.events()).toHaveLength(0);
  });

  it("keeps records when watch is disabled", async () => {
    harness = await createUpdateHarness({ watchEnabled: true });
    const first = await harness.tick();
    expect(first.discovered).toBe(1);
    const stored = harness.events().length;

    harness.repos.projects.setWatch(harness.project.projectId, false, null);
    harness.git.write("src/app.ts", "export const value = 2;\n");
    harness.git.commit("feat: change while stopped");
    await expect(harness.tick()).rejects.toMatchObject({ code: "conflict" });

    expect(harness.events()).toHaveLength(stored);
    expect(
      harness.repos.projects.byId(harness.project.projectId)?.watchEnabled,
    ).toBe(false);
  });

  it("sets watch_enabled when enabled and discovers again", async () => {
    harness = await createUpdateHarness({ watchEnabled: false });
    harness.repos.projects.setWatch(harness.project.projectId, true, null);
    expect(
      harness.repos.projects.byId(harness.project.projectId)?.watchEnabled,
    ).toBe(true);
    const result = await harness.tick();
    expect(result.projectId).toBe(harness.project.projectId);
    expect(harness.events().length).toBeGreaterThan(0);
  });
});
