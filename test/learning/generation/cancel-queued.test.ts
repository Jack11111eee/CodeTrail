import { readdir } from "node:fs/promises";

import { afterEach, describe, expect, test } from "vitest";

import {
  createHarness,
  generationInput,
  SHA_A,
  type Harness,
} from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

describe("cancel queued", () => {
  test("a queued job goes straight to cancelled with zero model calls", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const job = await harness.runner.enqueue(
      generationInput(harness, { sha: SHA_A }),
    );
    expect(job.state).toBe("queued");

    const cancelled = await harness.runner.cancel(job.jobId);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.errorCode).toBe("cancelled");

    await harness.runner.drain();

    expect(harness.calls.count).toBe(0);
    expect(harness.repos.jobs.listByState(["completed"])).toHaveLength(0);
    // Nothing was published: the knowledge root stays empty.
    expect(await readdir(harness.paths.knowledge)).toEqual([]);
    // No staging directory survived either.
    expect(await readdir(harness.paths.staging)).toEqual([]);
  });
});
