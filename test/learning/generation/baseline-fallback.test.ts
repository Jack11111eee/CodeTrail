import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { GenerationId } from "../../../src/learning/contracts/index.ts";
import {
  createGitRepositoryAt,
  createHarness,
  generationInput,
  runToCompletion,
  seedPublishedGeneration,
  type Harness,
} from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

describe("baseline fallback", () => {
  test("an incompatible baseline falls back with a reason and full regeneration", async () => {
    const dataDir = process.env.CODETRAIL_DATA_DIR!;
    const repoRoot = mkdtempSync(path.join(dataDir, "fallback-repo-"));
    const shas = await createGitRepositoryAt(repoRoot, [
      "base",
      "head",
      "third",
    ]);
    const harness = await createHarness({ mirrorPath: repoRoot, commits: shas });
    harnesses.push(harness);

    const stale = await seedPublishedGeneration(harness, {
      generationId: "g_baseline_stale" as GenerationId,
      commitSha: shas[0],
      upstreamVersion: "0.0.0-stale",
    });
    const fallbackJob = await runToCompletion(
      harness,
      generationInput(harness, {
        sha: shas[1],
        mode: "update",
        baselineFromGenerationId: stale.generationId,
      }),
    );
    expect(fallbackJob.state).toBe("completed");
    const fallbackRecord = harness.repos.generations.byId(
      fallbackJob.outputGenerationId!,
    )!;
    expect(fallbackRecord.fallbackReason).toBe("upstream_version");
    expect(fallbackRecord.baselineFromGenerationId).toBeNull();
    expect(harness.calls.count).toBe(3);
    // Sources are still fully validated/registered even on fallback.
    expect(
      harness.repos.sources.all(fallbackJob.outputGenerationId!).length,
    ).toBeGreaterThan(0);

    // A seal mismatch is another incompatibility, reported with its own reason.
    const corrupt = await seedPublishedGeneration(harness, {
      generationId: "g_baseline_corrupt" as GenerationId,
      commitSha: shas[0],
    });
    const page = path.join(corrupt.knowledgeDir, "openwiki", "quickstart.md");
    chmodSync(page, 0o644);
    writeFileSync(page, "# changed after sealing\n", "utf8");

    harness.calls.count = 0;
    const sealJob = await runToCompletion(
      harness,
      generationInput(harness, {
        sha: shas[2],
        mode: "update",
        baselineFromGenerationId: corrupt.generationId,
      }),
    );
    expect(sealJob.state).toBe("completed");
    const sealRecord = harness.repos.generations.byId(sealJob.outputGenerationId!)!;
    expect(sealRecord.fallbackReason).toBe("seal_mismatch");
    expect(harness.calls.count).toBe(3);
    expect(
      harness.repos.sources.all(sealJob.outputGenerationId!).length,
    ).toBeGreaterThan(0);
  });
});
