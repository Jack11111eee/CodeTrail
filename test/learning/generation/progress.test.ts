/* eslint-disable @typescript-eslint/require-await -- async port doubles */
import { afterEach, describe, expect, it } from "vitest";
import {
  createHarness,
  generationInput,
  insertJob,
  SHA_A,
  type Harness,
} from "./harness.ts";
import {
  recordJobEvent,
  upstreamProgress,
} from "../../../src/learning/api/jobs/progress.ts";
import {
  createRepositories,
  openDatabase,
} from "../../../src/learning/store/index.ts";
import { createUpstreamGenerationPort } from "../../../src/learning/upstream/generation.ts";
import type {
  JobEvent,
  UpstreamGenerationPort,
  UpstreamRunEvent,
} from "../../../src/learning/contracts/index.ts";

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.close();
});
const port = (run: UpstreamGenerationPort["run"]): UpstreamGenerationPort => ({
  run,
  sourceFingerprint: async () => "fingerprint",
  treeHashOfWorktree: async () => "tree",
  changedPaths: async () => [],
  lastUpdate: async () => null,
  pageManifest: async () => null,
});

describe("durable analysis progress", () => {
  it("persists real stages, sequential page counts and actions before notifying subscribers", async () => {
    let release!: () => void, entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const h = await createHarness({
      upstream: port(async (request) => {
        request.onEvent?.({ type: "repository_progress", stage: "planning" });
        request.onEvent?.({
          type: "repository_progress",
          stage: "generating",
          page: "openwiki/auth.md",
          pageIndex: 2,
          pageCount: 4,
        });
        request.onEvent?.({
          type: "text",
          message: "raw-model-text-must-not-be-recorded",
        });
        request.onEvent?.({
          type: "tool_start",
          name: "read_file",
          path: "src/auth.ts",
          page: "openwiki/auth.md",
        });
        entered();
        await paused;
        request.onEvent?.({
          type: "repository_progress",
          stage: "finalizing",
          pageCount: 4,
        });
        return { skipped: false, sourceChanged: false };
      }),
    });
    harnesses.push(h);
    const job = await h.runner.enqueue(generationInput(h, { sha: SHA_A }));
    const events: JobEvent[] = [];
    const unsubscribe = h.runner.subscribe(job.jobId, (event) => {
      expect(h.repos.jobs.byId(job.jobId)?.progress?.seq).toBe(event.seq);
      events.push(event);
    });
    try {
      await ready;
      const running = (await h.runner.get(job.jobId))!;
      expect(running.progress).toMatchObject({
        phase: "pages",
        commitSha: SHA_A,
        pages: { done: 1, total: 4, current: "openwiki/auth.md" },
        message: "读取文件：src/auth.ts",
      });
      const reopened = openDatabase({ file: h.paths.db });
      try {
        expect(
          createRepositories(reopened).jobs.byId(job.jobId)?.progress,
        ).toEqual(running.progress);
      } finally {
        reopened.close();
      }
      expect(JSON.stringify(running.progress)).not.toContain("raw-model-text");
    } finally {
      release();
      await h.runner.drain();
      unsubscribe();
    }
    const completed = (await h.runner.get(job.jobId))!;
    expect(completed.state).toBe("completed");
    expect(completed.progress?.pages).toMatchObject({ done: 4, total: 4 });
    expect(
      new Set(
        completed.progress?.activities?.map((activity) => activity.phase),
      ),
    ).toEqual(
      new Set([
        "queued",
        "resolving",
        "snapshot",
        "planning",
        "pages",
        "lessons",
        "checking",
        "sealing",
        "publishing",
      ]),
    );
    expect(completed.progress?.activities?.at(-1)?.message).toContain(
      "分析完成",
    );
    expect(events.some((event) => event.type === "progress")).toBe(true);
  });

  it("preserves failure history and completed page counts on a new attempt", async () => {
    const h = await createHarness({ failForSha: SHA_A });
    harnesses.push(h);
    const job = await h.runner.enqueue(generationInput(h, { sha: SHA_A }));
    await h.runner.drain();
    const failed = (await h.runner.get(job.jobId))!;
    expect(failed.state).toBe("failed");
    expect(failed.progress?.phase).toBe("lessons");
    h.repos.jobs.updateProgress(job.jobId, {
      ...failed.progress!,
      pages: { done: 5, total: 5 },
    });
    const retried = await h.runner.retry(job.jobId);
    expect(retried.progress?.phase).toBe("lessons");
    expect(retried.progress?.pages).toEqual({ done: 5, total: 5 });
    expect(
      retried.progress?.activities?.some(
        (activity) =>
          activity.attempt === 1 && activity.message.includes("分析失败"),
      ),
    ).toBe(true);
    expect(retried.progress?.activities?.at(-1)?.attempt).toBe(2);
    await h.runner.drain();
  });

  it("bounds repetitive activity history and retains it across interruption recovery", async () => {
    const h = await createHarness();
    harnesses.push(h);
    const job = insertJob(h, generationInput(h, { sha: SHA_A }), "running");
    const at = h.clock.now().toISOString();
    for (let index = 0; index < 130; index++)
      recordJobEvent(
        h.repos,
        job.jobId,
        {
          type: "progress",
          progress: {
            phase: "pages",
            done: index,
            total: 200,
            message: `生成第 ${index} 篇文档`,
          },
        },
        at,
      );
    expect(h.repos.jobs.byId(job.jobId)?.progress?.activities).toHaveLength(
      100,
    );
    const previousSeq = h.repos.jobs.byId(job.jobId)!.progress!.seq!;
    await h.runner.recoverInterrupted();
    const recovered = h.repos.jobs.byId(job.jobId)!;
    expect(recovered.state).toBe("interrupted");
    expect(recovered.progress?.phase).toBe("pages");
    expect(recovered.progress?.activities).toHaveLength(100);
    expect(recovered.progress?.seq).toBeGreaterThan(previousSeq);
    expect(recovered.progress?.activities?.at(-1)?.message).toContain("中断");
    const fresh = openDatabase({ file: h.paths.db });
    try {
      const repos = createRepositories(fresh);
      const event = recordJobEvent(
        repos,
        job.jobId,
        { type: "log", message: "恢复后读取记录" },
        at,
      );
      expect(event!.seq).toBe(recovered.progress!.seq! + 1);
    } finally {
      fresh.close();
    }
  });

  it("counts deferred pages separately from successful pages", () => {
    const progress = upstreamProgress(
      {
        type: "repository_progress",
        stage: "generating",
        pageCount: 22,
        successfulCount: 6,
        skippedCount: 1,
      },
      { phase: "pages", done: 0, total: null },
    );
    expect(progress).toMatchObject({
      done: 6,
      total: 22,
      pages: { done: 6, processed: 7, skipped: 1, total: 22 },
    });
  });

  it("persists safe page failure reasons and clears them after complete finalization", () => {
    const failed = upstreamProgress(
      {
        type: "repository_progress",
        stage: "generating",
        page: "openwiki/quickstart.md",
        failure: { code: "provider_timeout", message: "模型请求超时" },
      },
      { phase: "pages", done: 21, total: 22 },
    );
    expect(failed?.pageFailures).toEqual([
      {
        page: "openwiki/quickstart.md",
        code: "provider_timeout",
        message: "模型请求超时",
      },
    ]);
    const finished = upstreamProgress(
      {
        type: "repository_progress",
        stage: "finalizing",
        pageCount: 22,
        successfulCount: 22,
        skippedCount: 0,
      },
      failed!,
    );
    expect(finished?.pageFailures).toEqual([]);
  });

  it("preserves upstream counters and extracts only safe tool path fields", async () => {
    const h = await createHarness();
    harnesses.push(h);
    const observed: UpstreamRunEvent[] = [];
    const upstream = createUpstreamGenerationPort({
      run: async (options) => {
        options.onEvent?.({
          type: "repository_progress",
          stage: "generating",
          page: "/openwiki/auth.md",
          pageIndex: 3,
          pageCount: 8,
          completedCount: 2,
        });
        options.onEvent?.({
          type: "tool_start",
          id: "tool_1",
          call: "read_file",
          name: "read_file",
          input: {
            path: "/src/index.ts",
            apiKey: "not-for-display",
            content: "not-for-display",
          },
        });
        return { skipped: true };
      },
    });
    await upstream.run({
      worktreePath: h.sourceDir(SHA_A),
      mode: "init",
      language: "zh",
      modelId: "test",
      model: {} as never,
      writeRepoFiles: false,
      onEvent: (event) => observed.push(event),
    });
    expect(observed[0]).toMatchObject({
      pageIndex: 3,
      pageCount: 8,
      completedCount: 2,
      page: "openwiki/auth.md",
    });
    expect(observed[1]).toEqual({
      type: "tool_start",
      name: "read_file",
      path: "src/index.ts",
    });
    expect(JSON.stringify(observed)).not.toContain("not-for-display");
  });
});
