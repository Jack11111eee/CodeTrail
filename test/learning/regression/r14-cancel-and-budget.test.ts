/* eslint-disable @typescript-eslint/require-await -- test doubles implement async ports */
/**
 * AC-R14-01: cancellation and budget exhaustion are explicit, never success.
 * A cancelled job publishes nothing but keeps the usage it already consumed; a
 * budget-exhausted job fails with `budget_exhausted` before the offending model
 * call and never records a completed generation.
 */
import { afterEach, describe, expect, test } from "vitest";

import type { UpstreamGenerationPort } from "../../../src/learning/contracts/index.ts";
import {
  createHarness,
  generationInput,
  runToCompletion,
  SHA_A,
  waitForState,
  type Harness,
} from "../generation/harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

function upstreamCalling(times: number): UpstreamGenerationPort {
  return {
    async run(request) {
      for (let index = 0; index < times; index += 1) {
        await (
          request.model as unknown as {
            invoke: (input: string) => Promise<unknown>;
          }
        ).invoke(`call ${index}`);
      }
      return { skipped: false, sourceChanged: true };
    },
    sourceFingerprint: async () => "fp",
    treeHashOfWorktree: async () => "tree",
    changedPaths: async () => [],
    lastUpdate: async () => null,
    pageManifest: async () => null,
  };
}

describe("AC-R14-01 — cancellation publishes nothing and budget is explicit", () => {
  test("a cancelled running job keeps consumed usage and publishes nothing", async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let modelCalls = 0;

    const upstream: UpstreamGenerationPort = {
      async run(request) {
        await (
          request.model as unknown as {
            invoke: (input: string) => Promise<unknown>;
          }
        ).invoke("first call");
        modelCalls += 1;
        await blocked;
        return { skipped: false, sourceChanged: true };
      },
      sourceFingerprint: async () => "fp",
      treeHashOfWorktree: async () => "tree",
      changedPaths: async () => [],
      lastUpdate: async () => null,
      pageManifest: async () => null,
    };

    const harness = await createHarness({ upstream });
    harnesses.push(harness);

    const job = await harness.runner.enqueue(
      generationInput(harness, { sha: SHA_A }),
    );
    await waitForState(harness, job.jobId, "running");
    const deadline = Date.now() + 2_000;
    while (modelCalls === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(modelCalls).toBe(1);

    const cancelling = await harness.runner.cancel(job.jobId);
    expect(cancelling.state).toBe("cancelling");
    release();
    await harness.runner.drain();

    const finished = await harness.runner.get(job.jobId);
    expect(finished?.state).toBe("cancelled");
    expect(finished?.errorCode).toBe("cancelled");
    // Consumed usage is retained…
    expect(harness.usage.totals("initial").calls).toBeGreaterThanOrEqual(1);
    // …and nothing was published or recorded as a success.
    expect(
      harness.repos.generations.latestPublished(harness.repoId),
    ).toBeNull();
    expect(harness.repos.jobs.listByState(["completed"])).toHaveLength(0);
  });

  test("budget exhaustion fails before the extra request", async () => {
    const harness = await createHarness({
      upstream: upstreamCalling(2),
      settings: {
        provider: "scripted",
        model: "scripted",
        maxOutputTokens: 1024,
        temperature: 0,
        pricing: null,
        quota: {
          maxCalls: 1,
          maxInputTokens: 1_000_000,
          maxOutputTokens: 1_000_000,
        },
      },
    });
    harnesses.push(harness);

    const job = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_A }),
    );
    expect(job.state).toBe("failed");
    expect(job.errorCode).toBe("budget_exhausted");
    // The rejected request never reached the model, and the allowed one is
    // still recorded as usage.
    expect(harness.calls.count).toBe(1);
    expect(harness.usage.totals("initial").calls).toBe(1);
    expect(
      harness.repos.generations.latestPublished(harness.repoId),
    ).toBeNull();
    expect(harness.repos.jobs.listByState(["completed"])).toHaveLength(0);
  });

  test("exactly at the budget boundary still completes", async () => {
    const harness = await createHarness({
      upstream: upstreamCalling(3),
      settings: {
        provider: "scripted",
        model: "scripted",
        maxOutputTokens: 1024,
        temperature: 0,
        pricing: null,
        quota: {
          maxCalls: 3,
          maxInputTokens: 1_000_000,
          maxOutputTokens: 1_000_000,
        },
      },
    });
    harnesses.push(harness);

    const job = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_A }),
    );
    expect(job.state).toBe("completed");
    expect(job.errorCode).toBeNull();
    expect(harness.usage.totals("initial").calls).toBe(3);
    expect(
      harness.repos.generations.latestPublished(harness.repoId),
    ).not.toBeNull();
  });
});
