import { afterEach, describe, expect, test } from "vitest";

import {
  createHarness,
  generationInput,
  isLearningError,
  SHA_A,
  SHA_B,
  type Harness,
} from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

describe("single writer per stream", () => {
  test("two concurrent retries on one stream yield one busy_stream", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const first = await harness.runner.enqueue(
      generationInput(harness, { sha: SHA_A, streamId: "main" }),
    );
    const second = await harness.runner.enqueue(
      generationInput(harness, { sha: SHA_B, streamId: "main" }),
    );
    await harness.runner.cancel(first.jobId);
    await harness.runner.cancel(second.jobId);

    const results = await Promise.allSettled([
      harness.runner.retry(first.jobId),
      harness.runner.retry(second.jobId),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(isLearningError(rejected[0].reason, "busy_stream")).toBe(true);

    await harness.runner.drain();

    // Exactly one writer ever held the stream; the loser stayed cancelled.
    expect(harness.repos.jobs.listByState(["running", "cancelling"])).toHaveLength(
      0,
    );
    const states = [first.jobId, second.jobId]
      .map((id) => harness.repos.jobs.byId(id)?.state)
      .sort();
    expect(states).toEqual(["cancelled", "completed"]);
  });
});
