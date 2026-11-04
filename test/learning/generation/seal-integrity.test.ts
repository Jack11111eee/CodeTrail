import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { computeSealTreeHash } from "../../../src/learning/contracts/index.ts";
import { knowledgePath } from "../../../src/learning/config/paths.ts";
import {
  createHarness,
  generationInput,
  listRelativeFiles,
  readSealManifest,
  runToCompletion,
  SHA_A,
  type Harness,
} from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

describe("seal integrity", () => {
  test("seal.json enumerates every file except itself, with recomputable hashes", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const job = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_A }),
    );
    const generationId = job.outputGenerationId!;
    const knowledgeDir = knowledgePath(harness.paths, generationId);
    const manifest = await readSealManifest(knowledgeDir);

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.generationId).toBe(generationId);

    const onDisk = (await listRelativeFiles(knowledgeDir)).filter(
      (file) => file !== "seal.json",
    );
    expect(manifest.files.map((file) => file.path)).toEqual(onDisk);
    expect(manifest.files.some((file) => file.path === "seal.json")).toBe(false);

    for (const file of manifest.files) {
      const content = await readFile(path.join(knowledgeDir, file.path));
      expect(file.sha256).toBe(
        createHash("sha256").update(content).digest("hex"),
      );
      expect(file.bytes).toBe(content.byteLength);
      const mode = (await stat(path.join(knowledgeDir, file.path))).mode;
      expect(mode & 0o222).toBe(0);
    }

    expect(computeSealTreeHash(manifest.files)).toBe(manifest.treeHash);
    expect((await stat(path.join(knowledgeDir, "seal.json"))).mode & 0o222).toBe(
      0,
    );
  });

  test("a tampered file changes the recomputed tree hash", async () => {
    const harness = await createHarness();
    harnesses.push(harness);
    const job = await runToCompletion(
      harness,
      generationInput(harness, { sha: SHA_A }),
    );
    const knowledgeDir = knowledgePath(harness.paths, job.outputGenerationId!);
    const manifest = await readSealManifest(knowledgeDir);

    const tampered = manifest.files.map((file, index) =>
      index === 0 ? { ...file, sha256: "0".repeat(64) } : file,
    );
    expect(computeSealTreeHash(tampered)).not.toBe(manifest.treeHash);
  });
});
