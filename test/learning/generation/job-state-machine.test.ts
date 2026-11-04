import { afterEach, describe, expect, test } from "vitest";

import {
  ALLOWED_JOB_TRANSITIONS,
  RETRYABLE_JOB_STATES,
} from "../../../src/learning/contracts/index.ts";
import { isAllowedJobTransition } from "../../../src/learning/api/jobs/runner.ts";
import {
  createHarness,
  generationInput,
  insertJob,
  isLearningError,
  runToCompletion,
  SHA_A,
  type Harness,
} from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

describe("job state machine", () => {
  test("the transition table is the documented one", () => {
    expect(ALLOWED_JOB_TRANSITIONS).toEqual({
      queued: ["running", "cancelling", "cancelled"],
      running: ["completed", "failed", "cancelling", "interrupted"],
      cancelling: ["cancelled"],
      completed: [],
      failed: ["queued"],
      cancelled: ["queued"],
      interrupted: ["queued"],
    });
    expect(RETRYABLE_JOB_STATES).toEqual(["failed", "cancelled", "interrupted"]);
  });

  test("illegal transitions are rejected by the table", () => {
    expect(isAllowedJobTransition("queued", "completed")).toBe(false);
    expect(isAllowedJobTransition("queued", "failed")).toBe(false);
    expect(isAllowedJobTransition("completed", "running")).toBe(false);
    expect(isAllowedJobTransition("cancelling", "completed")).toBe(false);
    expect(isAllowedJobTransition("failed", "completed")).toBe(false);
    expect(isAllowedJobTransition("queued", "running")).toBe(true);
    expect(isAllowedJobTransition("running", "completed")).toBe(true);
  });

  test("an illegal retry leaves a completed job unchanged", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const job = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_A }),
    );
    expect(job.state).toBe("completed");

    await expect(harness.runner.retry(job.jobId)).rejects.toSatisfy(
      (error: unknown) => isLearningError(error, "job_not_retryable"),
    );
    expect(harness.repos.jobs.byId(job.jobId)?.state).toBe("completed");
    // Cancelling a terminal job is a no-op, not a state change.
    expect((await harness.runner.cancel(job.jobId)).state).toBe("completed");
  });

  test("the documented happy path is accepted", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const job = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_A }),
    );
    expect(job.state).toBe("completed");
    expect(job.outputGenerationId).toBeTruthy();

    const attempts = harness.repos.attempts.list(job.jobId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].state).toBe("completed");
  });

  test("running may be interrupted and then retried", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const job = insertJob(
      harness,
      generationInput(harness, { sha: SHA_A }),
      "running",
    );
    expect(await harness.runner.recoverInterrupted()).toBe(1);
    expect(harness.repos.jobs.byId(job.jobId)?.state).toBe("interrupted");
  });
});
