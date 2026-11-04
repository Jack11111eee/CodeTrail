/**
 * AC-R10-02: an incompatible baseline falls back to a full, budgeted run. The
 * job completes with a non-empty persisted `fallback_reason` (which the reader
 * surfaces), does not claim the old generation as its baseline, and still
 * registers and validates every source against the new commit.
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { GenerationId } from "../../../src/learning/contracts/index.ts";
import {
  createGitRepositoryAt,
  createHarness,
  generationInput,
  runToCompletion,
  seedPublishedGeneration,
  type Harness,
} from "../generation/harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

describe("AC-R10-02 — baseline fallback", () => {
  it("falls back to a full run with a reason and validated sources", async () => {
    const dataDir = process.env.CODETRAIL_DATA_DIR!;
    const repoRoot = mkdtempSync(path.join(dataDir, "r10-fallback-repo-"));
    const shas = await createGitRepositoryAt(repoRoot, ["base", "head"]);
    const harness = await createHarness({
      mirrorPath: repoRoot,
      commits: shas,
      // The full regeneration is exactly three model calls; the budget is set
      // to the same number so "within budget" is a real boundary.
      callsFor: () => 3,
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

    const stale = await seedPublishedGeneration(harness, {
      generationId: "g_r10_stale000000" as GenerationId,
      commitSha: shas[0],
      upstreamVersion: "0.0.0-stale",
    });

    const job = await runToCompletion(
      harness,
      generationInput(harness, {
        sha: shas[1],
        mode: "update",
        baselineFromGenerationId: stale.generationId,
      }),
    );
    expect(job.state).toBe("completed");
    const record = harness.repos.generations.byId(job.outputGenerationId!)!;

    // The incompatible baseline is rejected with an explicit reason, and the
    // run is a full one (not a seeded copy).
    expect(record.fallbackReason).toBe("upstream_version");
    expect(record.fallbackReason).toBeTruthy();
    expect(record.baselineFromGenerationId).toBeNull();
    expect(harness.calls.count).toBe(3);
    // Every source is still validated and bound to the new commit.
    const sources = harness.repos.sources.all(job.outputGenerationId!);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source.commitSha).toBe(shas[1]);
      expect(source.contentHash).not.toBe("");
    }
  }, 120_000);

  it("reports a corrupted baseline with its own fallback reason", async () => {
    const dataDir = process.env.CODETRAIL_DATA_DIR!;
    const repoRoot = mkdtempSync(path.join(dataDir, "r10-fallback-seal-"));
    const shas = await createGitRepositoryAt(repoRoot, ["base", "head"]);
    const harness = await createHarness({
      mirrorPath: repoRoot,
      commits: shas,
    });
    harnesses.push(harness);

    const corrupt = await seedPublishedGeneration(harness, {
      generationId: "g_r10_corrupt00000" as GenerationId,
      commitSha: shas[0],
    });
    const page = path.join(corrupt.knowledgeDir, "openwiki", "quickstart.md");
    chmodSync(page, 0o644);
    writeFileSync(page, "# changed after sealing\n", "utf8");

    const job = await runToCompletion(
      harness,
      generationInput(harness, {
        sha: shas[1],
        mode: "update",
        baselineFromGenerationId: corrupt.generationId,
      }),
    );
    expect(job.state).toBe("completed");
    const record = harness.repos.generations.byId(job.outputGenerationId!)!;
    expect(record.fallbackReason).toBe("seal_mismatch");
    expect(record.baselineFromGenerationId).toBeNull();
    expect(
      harness.repos.sources.all(job.outputGenerationId!).length,
    ).toBeGreaterThan(0);
  }, 120_000);
});
