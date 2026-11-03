import { afterEach, describe, expect, test } from "vitest";

import {
  createHarness,
  generationInput,
  insertJob,
  SHA_A,
  type Harness,
} from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

describe("restart interrupted", () => {
  test("recovery marks a killed job interrupted and retry uses attempt 2 on the same id", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const input = generationInput(harness, { sha: SHA_A });

    const running = insertJob(harness, input, "running");
    const recovered = await harness.runner.recoverInterrupted();
    expect(recovered).toBe(1);

    const interrupted = await harness.runner.get(running.jobId);
    expect(interrupted?.state).toBe("interrupted");
    expect(interrupted?.errorCode).toBe("interrupted");
    expect(harness.repos.attempts.list(running.jobId)[0].state).toBe(
      "interrupted",
    );

    const retried = await harness.runner.retry(running.jobId);
    expect(retried.jobId).toBe(running.jobId);
    expect(retried.state).toBe("queued");
    expect(retried.attempt).toBe(2);

    await harness.runner.drain();
    const completed = await harness.runner.get(running.jobId);
    expect(completed?.state).toBe("completed");
    expect(completed?.attempt).toBe(2);
    expect(completed?.outputGenerationId).toBeTruthy();

    const attempts = harness.repos.attempts.list(running.jobId);
    expect(attempts.map((entry) => entry.attempt)).toEqual([1, 2]);
    expect(attempts[1].state).toBe("completed");
  });

  test("recovery is a no-op when nothing is running", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    await expect(harness.runner.recoverInterrupted()).resolves.toBe(0);
  });
});
