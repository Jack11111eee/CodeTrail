import { afterEach, describe, expect, test } from "vitest";

import {
  createHarness,
  generationInput,
  insertJob,
  isLearningError,
  runToCompletion,
  SHA_A,
  SHA_B,
  SHA_C,
  type Harness,
} from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

async function expectNotRetryable(
  harness: Harness,
  jobId: string,
): Promise<void> {
  await expect(harness.runner.retry(jobId as never)).rejects.toSatisfy(
    (error: unknown) => isLearningError(error, "job_not_retryable"),
  );
}

describe("retry policy", () => {
  test("completed, running and queued jobs are refused", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const completed = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_A }),
    );
    await expectNotRetryable(harness, completed.jobId);

    const running = insertJob(
      harness,
      generationInput(harness, { sha: SHA_B }),
      "running",
    );
    await expectNotRetryable(harness, running.jobId);

    const queued = await harness.runner.enqueue(
      generationInput(harness, { sha: SHA_C }),
    );
    await expectNotRetryable(harness, queued.jobId);
    await harness.runner.cancel(queued.jobId);
    await harness.runner.drain();
  });

  test.each(["failed", "cancelled", "interrupted"] as const)(
    "a %s job retries on the same id with attempt + 1",
    async (state) => {
      const harness = await createHarness();
      harnesses.push(harness);
      const input = generationInput(harness, { sha: SHA_A });
      const job = insertJob(harness, input, state, { attempt: 1 });

      const retried = await harness.runner.retry(job.jobId);
      expect(retried.jobId).toBe(job.jobId);
      expect(retried.attempt).toBe(2);
      expect(retried.state).toBe("queued");

      await harness.runner.drain();
      const done = await harness.runner.get(job.jobId);
      expect(done?.state).toBe("completed");
      expect(done?.attempt).toBe(2);
    },
  );
});
