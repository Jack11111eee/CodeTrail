import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_WATCH_INTERVAL_MS } from "../../../src/learning/config/defaults.ts";
import { createWatchScheduler } from "../../../src/learning/updates/watch.ts";
import {
  cleanupHarness,
  createUpdateHarness,
  type UpdateHarness,
} from "./harness.ts";

/**
 * AC-UPD-03: the default interval is 300000 ms, the scheduler registers that
 * interval, and a manual refresh runs exactly one tick and updates
 * `lastPollAt`.
 */
describe("poll interval", () => {
  let harness: UpdateHarness | undefined;

  afterEach(() => {
    cleanupHarness(harness);
    harness = undefined;
  });

  it("defaults to five minutes and registers that interval", () => {
    expect(DEFAULT_WATCH_INTERVAL_MS).toBe(300_000);
  });

  it("registers the configured interval and stops cleanly", async () => {
    harness = await createUpdateHarness();
    const spy = vi.spyOn(globalThis, "setInterval");
    const scheduler = createWatchScheduler(harness.deps);
    scheduler.start();
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 300_000);
    scheduler.stop();
    spy.mockRestore();
  });

  it("runs a single manual tick and updates lastPollAt", async () => {
    harness = await createUpdateHarness();
    const scheduler = createWatchScheduler(harness.deps);
    harness.clock.set("2024-06-01T02:00:00.000Z");
    const results = await scheduler.runTick(harness.project.projectId);
    expect(results).toHaveLength(1);
    expect(scheduler.lastPollAt(harness.project.projectId)).toBe(
      "2024-06-01T02:00:00.000Z",
    );
    expect(harness.discoveryCursor()?.lastPollAt).toBe(
      "2024-06-01T02:00:00.000Z",
    );
  });
});
