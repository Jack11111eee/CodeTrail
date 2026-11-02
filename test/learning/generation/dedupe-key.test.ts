import { createHash } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import {
  computeDedupeKey,
} from "../../../src/learning/contracts/index.ts";
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

/** Independent implementation of §3.7 — never imported from production. */
function recompute(input: {
  repoId: string;
  streamId: string | null;
  comparisonBaseSha: string | null;
  headSha: string;
  baseContextSha: string | null;
  scopeHash: string;
  analysisConfigHash: string;
}): string {
  const parts = [
    "dk1",
    input.repoId,
    input.streamId ?? "",
    input.comparisonBaseSha ?? "",
    input.headSha,
    input.baseContextSha ?? "",
    input.scopeHash,
    input.analysisConfigHash,
  ].join("\u0000");
  return `sha256:${createHash("sha256").update(parts).digest("hex")}`;
}

describe("dedupe key", () => {
  test("matches the §3.7 formula field for field", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const fields = {
      repoId: harness.repoId,
      streamId: "main",
      comparisonBaseSha: SHA_A,
      headSha: "d".repeat(40),
      baseContextSha: "e".repeat(40),
      scopeHash: harness.scope.hash,
      analysisConfigHash: "cf-test",
    };
    expect(computeDedupeKey(fields)).toBe(recompute(fields));

    const variants = [
      { ...fields, streamId: null },
      { ...fields, comparisonBaseSha: null },
      { ...fields, baseContextSha: null },
      { ...fields, scopeHash: "other-scope" },
      { ...fields, analysisConfigHash: "other-config" },
    ];
    for (const variant of variants) {
      expect(computeDedupeKey(variant)).not.toBe(computeDedupeKey(fields));
    }
  });

  test("identical input maps to one job row and the same job id", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const input = generationInput(harness, { sha: SHA_A });

    const first = await harness.runner.enqueue(input);
    await harness.runner.drain();
    const second = await harness.runner.enqueue(input);

    expect(second.jobId).toBe(first.jobId);
    expect(
      harness.repos.jobs.listByState(["completed", "failed", "cancelled"]),
    ).toHaveLength(1);
  });

  test("a scope or config change produces a new job", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const base = await harness.runner.enqueue(
      generationInput(harness, { sha: SHA_A }),
    );
    const scoped = await harness.runner.enqueue(
      generationInput(harness, {
        sha: SHA_A,
        scope: { ...harness.scope, maxFiles: harness.scope.maxFiles - 1, hash: "scoped" },
      }),
    );
    const configured = await harness.runner.enqueue(
      generationInput(harness, {
        sha: SHA_A,
        config: {
          ...harness.config,
          model: { ...harness.config.model, temperature: 0.5 },
        },
      }),
    );

    expect(new Set([base.jobId, scoped.jobId, configured.jobId]).size).toBe(3);
    await harness.runner.drain();
  });
});
