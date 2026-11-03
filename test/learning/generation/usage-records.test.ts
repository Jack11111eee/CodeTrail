/* eslint-disable @typescript-eslint/require-await -- test doubles implement async ports */
import { afterEach, describe, expect, test } from "vitest";

import type { UpstreamGenerationPort } from "../../../src/learning/contracts/index.ts";
import {
  createHarness,
  generationInput,
  runToCompletion,
  SHA_A,
  SHA_B,
  type Harness,
} from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

describe("usage records", () => {
  test("records calls and tokens per kind with null cost when unpriced", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const initial = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_A }),
    );
    expect(initial.state).toBe("completed");
    const initialGroup = harness.repos.usage.groupByKind("initial");
    expect(initialGroup).toHaveLength(1);
    expect(initialGroup[0].calls).toBe(3);
    expect(initialGroup[0].inputTokens).toBeGreaterThan(0);
    expect(initialGroup[0].outputTokens).toBeGreaterThan(0);
    expect(initialGroup[0].costCents).toBeNull();

    const update = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_B, mode: "update" }),
    );
    expect(update.state).toBe("completed");
    expect(harness.repos.usage.groupByKind("update")[0].calls).toBe(3);
    expect(harness.usage.totals("initial").calls).toBe(3);
    expect(harness.usage.totals().calls).toBe(6);
    expect(harness.usage.totals().costCents).toBeNull();
  });

  test("computes cost_cents when pricing is configured", async () => {
    const harness = await createHarness({
      settings: {
        provider: "scripted",
        model: "scripted",
        maxOutputTokens: 1024,
        temperature: 0,
        pricing: { inputCentsPerMTok: 100, outputCentsPerMTok: 100 },
        quota: { maxCalls: 1000, maxInputTokens: 1_000_000, maxOutputTokens: 1_000_000 },
      },
    });
    harnesses.push(harness);
    await runToCompletion(harness, generationInput(harness, { sha: SHA_A }));

    const group = harness.repos.usage.groupByKind("initial")[0];
    expect(group.calls).toBe(3);
    expect(group.costCents).not.toBeNull();
    expect(group.costCents ?? 0).toBeGreaterThanOrEqual(0);
  });

  test("a failed job keeps the usage it already consumed", async () => {
    let calls = 0;
    const upstream: UpstreamGenerationPort = {
      async run(request) {
        await (request.model as unknown as {
          invoke: (input: string) => Promise<unknown>;
        }).invoke("first");
        calls += 1;
        await (request.model as unknown as {
          invoke: (input: string) => Promise<unknown>;
        }).invoke("second");
        calls += 1;
        throw new Error("upstream failed");
      },
      sourceFingerprint: async () => "fp",
      treeHashOfWorktree: async () => "tree",
      changedPaths: async () => [],
      lastUpdate: async () => null,
      pageManifest: async () => null,
    };
    const harness = await createHarness({ upstream });
    harnesses.push(harness);

    const job = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_A }),
    );
    expect(job.state).toBe("failed");
    expect(calls).toBe(2);
    expect(harness.usage.totals("initial").calls).toBe(2);
  });
});
