/* eslint-disable @typescript-eslint/require-await -- test doubles implement async ports */
import { afterEach, describe, expect, test } from "vitest";

import type { UpstreamGenerationPort } from "../../../src/learning/contracts/index.ts";
import {
  createHarness,
  generationInput,
  SHA_A,
  waitForState,
  type Harness,
} from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

describe("cancel running", () => {
  test("running → cancelling → cancelled, usage kept, nothing published", async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let modelCalls = 0;

    const upstream: UpstreamGenerationPort = {
      async run(request) {
        await (request.model as unknown as {
          invoke: (input: string) => Promise<unknown>;
        }).invoke("first call");
        modelCalls += 1;
        await blocked;
        return { skipped: false, sourceChanged: true };
      },
      sourceFingerprint: async () => "fp",
      treeHashOfWorktree: async () => "tree",
      changedPaths: async () => [],
      lastUpdate: async () => null,
      pageManifest: async () => null,
    };

    const harness = await createHarness({ upstream });
    harnesses.push(harness);

    const job = await harness.runner.enqueue(
      generationInput(harness, { sha: SHA_A }),
    );
    await waitForState(harness, job.jobId, "running");
    // Wait until the first model call has actually completed, so the
    // "consumed usage is kept" assertion is about a real call.
    const deadline = Date.now() + 2_000;
    while (modelCalls === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(modelCalls).toBe(1);

    const cancelling = await harness.runner.cancel(job.jobId);
    expect(cancelling.state).toBe("cancelling");

    release();
    await harness.runner.drain();

    const finished = await harness.runner.get(job.jobId);
    expect(finished?.state).toBe("cancelled");
    expect(finished?.errorCode).toBe("cancelled");
    expect(modelCalls).toBe(1);
    // The call that completed before cancellation is still recorded.
    expect(harness.usage.totals("initial").calls).toBeGreaterThanOrEqual(1);
    expect(harness.repos.generations.latestPublished(harness.repoId)).toBeNull();
    expect(harness.repos.jobs.listByState(["completed"])).toHaveLength(0);
  });
});
