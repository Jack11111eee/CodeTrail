import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  computeDedupeKey,
  jobIdFromDedupeKey,
} from "../../../src/learning/contracts/index.ts";
import { knowledgePath } from "../../../src/learning/config/paths.ts";
import { FAULT_POINT_NAMES } from "../../../src/learning/testing/faults.ts";
import {
  createHarness,
  generationInput,
  listRelativeFiles,
  readSealManifest,
  runToCompletion,
  SHA_A,
  SHA_B,
  type Harness,
} from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

function runChild(
  fault: string,
  dataDir: string,
): Promise<{ code: number | null; stderr: string }> {
  const childPath = path.join(import.meta.dirname, "crash-child.ts");
  const tsxPath = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxPath, childPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CODETRAIL_DATA_DIR: dataDir,
        CODETRAIL_FAULT_INJECT: fault,
        CODETRAIL_CRASH_SHA: SHA_B,
        CODETRAIL_CRASH_OLD_SHA: SHA_A,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

async function assertGenerationCoherent(
  harness: Harness,
  generationId: string,
): Promise<void> {
  const knowledgeDir = knowledgePath(harness.paths, generationId as never);
  const manifest = await readSealManifest(knowledgeDir);
  const record = harness.repos.generations.byId(generationId as never);
  expect(record?.status).toBe("published");
  expect(record?.sealedTreeHash).toBe(manifest.treeHash);

  const onDisk = (await listRelativeFiles(knowledgeDir)).filter(
    (file) => file !== "seal.json",
  );
  expect(manifest.files.map((file) => file.path)).toEqual(onDisk);
  for (const file of manifest.files) {
    const content = await readFile(path.join(knowledgeDir, file.path));
    expect(file.sha256).toBe(
      createHash("sha256").update(content).digest("hex"),
    );
  }
  for (const lesson of harness.repos.lessons.listByGeneration(
    generationId as never,
  )) {
    const content = await readFile(path.join(knowledgeDir, lesson.relPath));
    expect(lesson.jsonSha256).toBe(
      createHash("sha256").update(content).digest("hex"),
    );
  }
}

describe("crash consistency", () => {
  test.each([...FAULT_POINT_NAMES])(
    "a crash at %s exposes only a complete old or complete new version",
    async (fault) => {
      const dataDir = path.join(process.env.CODETRAIL_DATA_DIR!, fault);

      const setup = await createHarness({
        dataDir,
        commits: [SHA_A, SHA_B],
      });
      const oldJob = await runToCompletion(
        setup,
        generationInput(setup, { sha: SHA_A }),
      );
      const oldId = oldJob.outputGenerationId!;
      const oldHash = setup.repos.generations.byId(oldId)?.sealedTreeHash;
      setup.close();

      const child = await runChild(fault, dataDir);
      expect(child.code).not.toBe(0);
      expect(child.stderr).toContain(`injected fault at ${fault}`);

      const harness = await createHarness({
        dataDir,
        commits: [SHA_A, SHA_B],
      });
      harnesses.push(harness);

      const recovered = await harness.runner.recoverInterrupted();
      const input = generationInput(harness, { sha: SHA_B, mode: "update" });
      const jobId = jobIdFromDedupeKey(computeDedupeKey(input));
      const crashed = await harness.runner.get(jobId);
      expect(crashed).not.toBeNull();

      // The old generation is always complete and byte-identical.
      expect(harness.repos.generations.byId(oldId)?.sealedTreeHash).toBe(oldHash);
      await assertGenerationCoherent(harness, oldId);

      if (fault === "tx_after") {
        // The transaction committed before the process died.
        expect(recovered).toBe(0);
        expect(crashed?.state).toBe("completed");
        expect(crashed?.outputGenerationId).toBeTruthy();
      } else {
        expect(recovered).toBe(1);
        expect(crashed?.state).toBe("interrupted");
        expect(crashed?.errorCode).toBe("interrupted");
        expect(crashed?.outputGenerationId).toBeNull();

        const retried = await harness.runner.retry(jobId);
        expect(retried.attempt).toBe(2);
        await harness.runner.drain();
        expect((await harness.runner.get(jobId))?.state).toBe("completed");
      }

      const newId = (await harness.runner.get(jobId))?.outputGenerationId;
      expect(newId).toBeTruthy();
      await assertGenerationCoherent(harness, newId!);

      // Exactly two complete knowledge directories: the old and the new.
      const directories = await readdir(harness.paths.knowledge);
      expect(directories.sort()).toEqual([oldId, newId!].sort());

      // The new generation cites only sources at the new commit.
      for (const source of harness.repos.sources.all(newId!)) {
        expect(source.commitSha).toBe(SHA_B);
      }
    },
    120_000,
  );
});
