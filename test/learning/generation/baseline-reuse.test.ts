import { existsSync, mkdtempSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { GenerationId } from "../../../src/learning/contracts/index.ts";
import { knowledgePath } from "../../../src/learning/config/paths.ts";
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

describe("baseline reuse", () => {
  test("a compatible baseline is reused with fewer calls and no .run.json", async () => {
    // `planBaseline` resolves the data root from CODETRAIL_DATA_DIR, so the
    // harness must use the same root the process was given.
    const dataDir = process.env.CODETRAIL_DATA_DIR!;
    const repoRoot = mkdtempSync(path.join(dataDir, "baseline-repo-"));
    const shas = await createGitRepositoryAt(repoRoot, [
      "base",
      "head",
      "third",
    ]);
    const harness = await createHarness({ mirrorPath: repoRoot, commits: shas });
    harnesses.push(harness);

    const seeded = await seedPublishedGeneration(harness, {
      generationId: "g_baseline_reuse" as GenerationId,
      commitSha: shas[0],
      withRunJson: true,
    });

    const reused = await runToCompletion(
      harness,
      generationInput(harness, {
        sha: shas[1],
        mode: "update",
        baselineFromGenerationId: seeded.generationId,
      }),
    );
    expect(reused.state).toBe("completed");
    const record = harness.repos.generations.byId(reused.outputGenerationId!)!;
    expect(record.baselineFromGenerationId).toBe(seeded.generationId);
    expect(record.fallbackReason).toBeNull();
    expect(harness.calls.count).toBe(1);

    const reusedDir = knowledgePath(harness.paths, reused.outputGenerationId!);
    expect(existsSync(path.join(reusedDir, "openwiki", ".run.json"))).toBe(
      false,
    );
    expect(existsSync(path.join(reusedDir, "openwiki", "quickstart.md"))).toBe(
      true,
    );

    // A full run (no baseline) makes more model calls on the same data root.
    harness.calls.count = 0;
    const fullJob = await runToCompletion(
      harness,
      generationInput(harness, { sha: shas[2], mode: "init" }),
    );
    expect(fullJob.state).toBe("completed");
    expect(harness.calls.count).toBe(3);
  });
});
