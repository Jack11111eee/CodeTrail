/* eslint-disable @typescript-eslint/require-await -- test doubles implement async ports */
import { afterEach, describe, expect, test } from "vitest";

import type { UpstreamGenerationPort } from "../../../src/learning/contracts/index.ts";
import {
  createHarness,
  generationInput,
  runToCompletion,
  SHA_A,
  type Harness,
} from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

function upstreamCalling(times: number): UpstreamGenerationPort {
  return {
    async run(request) {
      for (let index = 0; index < times; index += 1) {
        await (request.model as unknown as {
          invoke: (input: string) => Promise<unknown>;
        }).invoke(`call ${index}`);
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

describe("quota", () => {
  test("exhausting the call quota fails with budget_exhausted before the request", async () => {
    const harness = await createHarness({
      upstream: upstreamCalling(2),
      settings: {
        provider: "scripted",
        model: "scripted",
        maxOutputTokens: 1024,
        temperature: 0,
        pricing: null,
        quota: { maxCalls: 1, maxInputTokens: 1_000_000, maxOutputTokens: 1_000_000 },
      },
    });
    harnesses.push(harness);

    const job = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_A }),
    );
    expect(job.state).toBe("failed");
    expect(job.errorCode).toBe("budget_exhausted");
    // The rejected request never reached the model.
    expect(harness.calls.count).toBe(1);
    expect(harness.usage.totals("initial").calls).toBe(1);
  });

  test("token quota is checked before the request too", async () => {
    const harness = await createHarness({
      upstream: upstreamCalling(1),
      settings: {
        provider: "scripted",
        model: "scripted",
        maxOutputTokens: 1024,
        temperature: 0,
        pricing: null,
        quota: { maxCalls: 1000, maxInputTokens: 50, maxOutputTokens: 1_000_000 },
      },
    });
    harnesses.push(harness);

    const job = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_A }),
    );
    expect(job.state).toBe("failed");
    expect(job.errorCode).toBe("budget_exhausted");
    expect(harness.calls.count).toBe(0);
    expect(harness.usage.totals("initial").calls).toBe(0);
  });

  test("exactly at the boundary is allowed, and canSpend is pure", async () => {
    const harness = await createHarness({
      upstream: upstreamCalling(1),
      settings: {
        provider: "scripted",
        model: "scripted",
        maxOutputTokens: 1024,
        temperature: 0,
        pricing: null,
        quota: { maxCalls: 1, maxInputTokens: 1_000_000, maxOutputTokens: 1_000_000 },
      },
    });
    harnesses.push(harness);

    const before = harness.usage.totals("initial");
    const allowed = harness.usage.canSpend({
      kind: "initial",
      estimatedCalls: 1,
      estimatedInputTokens: 100,
      estimatedOutputTokens: 100,
    });
    expect(allowed).toBe(true);
    expect(harness.usage.totals("initial")).toEqual(before);

    const job = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_A }),
    );
    expect(job.state).toBe("completed");
    expect(harness.usage.totals("initial").calls).toBe(1);
  });
});
