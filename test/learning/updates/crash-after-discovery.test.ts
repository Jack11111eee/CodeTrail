import { afterEach, describe, expect, it } from "vitest";

import { createDiscoveryService } from "../../../src/learning/updates/discovery.ts";
import { runWatchTick } from "../../../src/learning/updates/watch.ts";
import {
  cleanupHarness,
  createUpdateHarness,
  type UpdateHarness,
} from "./harness.ts";

/**
 * AC-UPD-18: kill after discovery advanced the cursor. Events survive, the
 * same job can resume, there is no second writer, and the published cursor
 * still lags discovery.
 */
describe("crash after discovery", () => {
  let harness: UpdateHarness | undefined;

  afterEach(() => {
    cleanupHarness(harness);
    harness = undefined;
  });

  it("reuses the same event and job after a restart", async () => {
    harness = await createUpdateHarness();
    await harness.tick();
    harness.git.write("src/after.ts", "export const after = 1;\n");
    const head = harness.git.commit("feat: after");
    await harness.tick();

    const eventsBefore = harness.events();
    const jobsBefore = harness.jobs();
    expect(eventsBefore.filter((event) => event.headSha === head)).toHaveLength(
      1,
    );
    expect(jobsBefore).toHaveLength(1);

    // Simulate a new process: fresh service objects over the same database.
    const discovery = createDiscoveryService({
      db: harness.db,
      repos: harness.repos,
      clock: harness.clock,
      github: harness.github,
      paths: harness.paths,
    });
    const deps = { ...harness.deps, discovery };
    const result = await runWatchTick(deps, harness.project.projectId);

    expect(result.discovered).toBe(0);
    expect(harness.events()).toHaveLength(eventsBefore.length);
    expect(harness.jobs()).toHaveLength(jobsBefore.length);
    expect(harness.jobs()[0]?.jobId).toBe(jobsBefore[0]?.jobId);
    expect(harness.jobs()[0]?.state).toBe("queued");
    expect(
      harness.repos.cursors.get(
        harness.repo.repoId,
        "default_branch",
        "discovery",
      )?.headSha,
    ).toBe(head);
    expect(
      harness.repos.cursors.get(
        harness.repo.repoId,
        "default_branch",
        "published",
      ),
    ).toBeNull();
  });
});
