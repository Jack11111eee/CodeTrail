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

describe("cache hit", () => {
  test("a second job with the same cache key makes zero model calls", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const first = await harness.runner.enqueue(
      generationInput(harness, { sha: SHA_A, streamId: "cache-1" }),
    );
    await harness.runner.drain();
    const firstJob = await harness.runner.get(first.jobId);
    if (firstJob?.state !== "completed") {
      console.error("JOB FAILED", firstJob?.errorCode, firstJob?.errorDetail);
    }
    expect(firstJob?.state).toBe("completed");
    const firstCalls = harness.calls.count;
    expect(firstCalls).toBeGreaterThan(0);

    const generationId = firstJob?.outputGenerationId;
    expect(generationId).toBeTruthy();
    const record = harness.repos.generations.byId(generationId!);
    expect(record?.status).toBe("published");
    const sealedTreeHash = record?.sealedTreeHash;
    const directoriesBefore = (await readdir(harness.paths.knowledge)).sort();

    // Different stream id ⇒ different dedupe_key, identical cache_key.
    const second = await harness.runner.enqueue(
      generationInput(harness, { sha: SHA_A, streamId: "cache-2" }),
    );
    expect(second.jobId).not.toBe(first.jobId);
    expect(second.state).toBe("completed");
    expect(second.outputGenerationId).toBe(generationId);
    expect(harness.calls.count).toBe(firstCalls);

    const directoriesAfter = (await readdir(harness.paths.knowledge)).sort();
    expect(directoriesAfter).toEqual(directoriesBefore);
    expect(harness.repos.generations.byId(generationId!)?.sealedTreeHash).toBe(
      sealedTreeHash,
    );
  });

  test("an identical enqueue is idempotent on dedupe_key", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const input = generationInput(harness, { sha: SHA_A });
    const first = await harness.runner.enqueue(input);
    await harness.runner.drain();
    const callsAfterFirst = harness.calls.count;

    const second = await harness.runner.enqueue(input);
    expect(second.jobId).toBe(first.jobId);
    expect(second.state).toBe("completed");
    expect(harness.calls.count).toBe(callsAfterFirst);
    expect(harness.repos.jobs.listByState(["queued", "running"])).toHaveLength(0);
  });
});
