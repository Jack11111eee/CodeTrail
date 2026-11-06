/* eslint-disable @typescript-eslint/require-await -- async port doubles */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  LessonBuilderPort,
  UpstreamGenerationPort,
} from "../../../src/learning/contracts/index.ts";
import {
  createHarness,
  generationInput,
  SHA_A,
  type Harness,
} from "./harness.ts";

const harnesses = new Set<Harness>();
afterEach(() => {
  for (const h of harnesses) h.close();
  harnesses.clear();
});
const port = (run: UpstreamGenerationPort["run"]): UpstreamGenerationPort => ({
  run,
  sourceFingerprint: async () => "source",
  treeHashOfWorktree: async () => "tree",
  changedPaths: async () => [],
  lastUpdate: async () => null,
  pageManifest: async () => null,
});

describe("generation stage checkpoints", () => {
  it("preserves a partial plan and page on disk and resumes in the same build tree", async () => {
    let calls = 0;
    const upstream = port(async ({ worktreePath }) => {
      const wiki = path.join(worktreePath, "openwiki");
      const page = path.join(wiki, "completed.md");
      if (++calls === 1) {
        await mkdir(wiki, { recursive: true });
        await writeFile(page, "# Accepted module\n");
        await writeFile(
          path.join(wiki, ".run.json"),
          '{"phase":"generating","plan":{"pages":[]}}',
        );
        throw new Error("second module interrupted");
      }
      expect(await readFile(page, "utf8")).toBe("# Accepted module\n");
      expect(
        JSON.parse(await readFile(path.join(wiki, ".run.json"), "utf8")),
      ).toHaveProperty("plan");
      return { skipped: false, sourceChanged: false };
    });
    const h = await createHarness({ upstream });
    harnesses.add(h);
    const job = await h.runner.enqueue(generationInput(h, { sha: SHA_A }));
    await h.runner.drain();
    expect((await h.runner.get(job.jobId))?.state).toBe("failed");
    await h.runner.retry(job.jobId);
    await h.runner.drain();
    const result = (await h.runner.get(job.jobId))!;
    expect(result.state, result.errorDetail ?? "").toBe("completed");
    expect(calls).toBe(2);
  });

  it("reuses completed documents after a lesson failure and process restart", async () => {
    const first = await createHarness({ failForSha: SHA_A });
    harnesses.add(first);
    const job = await first.runner.enqueue(
      generationInput(first, { sha: SHA_A }),
    );
    await first.runner.drain();
    expect((await first.runner.get(job.jobId))?.progress?.phase).toBe(
      "lessons",
    );
    const dataDir = first.dataDir;
    first.close();
    harnesses.delete(first);
    const restarted = await createHarness({
      dataDir,
      upstream: port(async () => {
        throw new Error("must not replan or regenerate documents");
      }),
    });
    harnesses.add(restarted);
    await restarted.runner.retry(job.jobId);
    await restarted.runner.drain();
    const result = (await restarted.runner.get(job.jobId))!;
    expect(result.state, result.errorDetail ?? "").toBe("completed");
  });

  it("reuses validated lessons and their source registry after a seal failure and restart", async () => {
    const first = await createHarness();
    harnesses.add(first);
    first.publisher.seal = async () => {
      throw new Error("seal interrupted");
    };
    const job = await first.runner.enqueue(
      generationInput(first, { sha: SHA_A }),
    );
    await first.runner.drain();
    expect((await first.runner.get(job.jobId))?.progress?.phase).toBe(
      "sealing",
    );
    const dataDir = first.dataDir;
    first.close();
    harnesses.delete(first);
    const fail = async () => {
      throw new Error("completed model stages must not run again");
    };
    const lessonBuilder: LessonBuilderPort = {
      buildResearchLessons: fail,
      buildChangeLesson: fail,
      buildComparisonLesson: fail,
    };
    const restarted = await createHarness({
      dataDir,
      lessonBuilder,
      upstream: port(fail),
    });
    harnesses.add(restarted);
    await restarted.runner.retry(job.jobId);
    await restarted.runner.drain();
    const result = (await restarted.runner.get(job.jobId))!;
    expect(result.state, result.errorDetail ?? "").toBe("completed");
    expect(
      restarted.repos.lessons.listByGeneration(result.outputGenerationId!),
    ).not.toHaveLength(0);
    expect(
      restarted.repos.sources.all(result.outputGenerationId!),
    ).not.toHaveLength(0);
  });

  it("refuses changed completed documents without deleting or silently regenerating them", async () => {
    const h = await createHarness({ failForSha: SHA_A });
    harnesses.add(h);
    const job = await h.runner.enqueue(generationInput(h, { sha: SHA_A }));
    await h.runner.drain();
    const page = path.join(
      h.publisher.buildWorkspace(job.jobId).treeDir,
      "openwiki/quickstart.md",
    );
    await writeFile(page, "changed after checkpoint\n");
    await h.runner.retry(job.jobId);
    await h.runner.drain();
    expect((await h.runner.get(job.jobId))?.errorCode).toBe("source_drift");
    expect(await readFile(page, "utf8")).toBe("changed after checkpoint\n");
  });
});
