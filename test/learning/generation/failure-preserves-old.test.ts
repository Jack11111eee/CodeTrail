import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { knowledgePath } from "../../../src/learning/config/paths.ts";
import {
  createHarness,
  generationInput,
  listRelativeFiles,
  runToCompletion,
  SHA_A,
  SHA_B,
  type Harness,
} from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

async function fileHashes(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const file of await listRelativeFiles(root)) {
    const content = await readFile(path.join(root, file));
    hashes[file] = createHash("sha256").update(content).digest("hex");
  }
  return hashes;
}

describe("failure preserves the old generation", () => {
  test("a failed job leaves the previous generation byte-identical", async () => {
    const harness = await createHarness({ failForSha: SHA_B });
    harnesses.push(harness);

    const first = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_A }),
    );
    const oldId = first.outputGenerationId!;
    const oldDir = knowledgePath(harness.paths, oldId);
    const oldRecord = harness.repos.generations.byId(oldId)!;
    const oldHashes = await fileHashes(oldDir);
    const oldLessons = harness.repos.lessons.listByGeneration(oldId);

    const failed = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_B }),
    );
    expect(failed.state).toBe("failed");
    expect(failed.errorCode).toBe("internal_error");
    expect(failed.outputGenerationId).toBeNull();

    const stillOld = harness.repos.generations.byId(oldId)!;
    expect(stillOld.status).toBe("published");
    expect(stillOld.sealedTreeHash).toBe(oldRecord.sealedTreeHash);
    expect(await fileHashes(oldDir)).toEqual(oldHashes);
    expect(harness.repos.lessons.listByGeneration(oldId)).toEqual(oldLessons);

    const published = harness.repos.generations.latestPublished(harness.repoId);
    expect(published?.generationId).toBe(oldId);
    // No new published row appeared.
    expect(
      harness.db.raw
        .prepare("SELECT COUNT(*) AS total FROM generations WHERE status = 'published'")
        .get(),
    ).toEqual({ total: 1 });
  });
});
