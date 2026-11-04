/* eslint-disable @typescript-eslint/require-await -- task bodies are intentionally async */
import { describe, expect, test } from "vitest";

import { MODEL_CONCURRENCY } from "../../../src/learning/config/defaults.ts";
import { createModelGate } from "../../../src/learning/api/jobs/runner.ts";
import { sleep } from "./harness.ts";

describe("model concurrency", () => {
  test("global limit is 2 with one permit per role", async () => {
    expect(MODEL_CONCURRENCY).toBe(2);
    const gate = createModelGate();

    const task = async (role: "repo_job" | "page_worker" | "qa" | "lesson") =>
      gate.run(role, async () => {
        await sleep(15);
      });

    await Promise.all([
      task("repo_job"),
      task("repo_job"),
      task("repo_job"),
      task("page_worker"),
      task("page_worker"),
      task("qa"),
      task("lesson"),
    ]);

    expect(gate.maxActive()).toBe(2);
    expect(gate.maxActiveFor("repo_job")).toBe(1);
    expect(gate.maxActiveFor("page_worker")).toBe(1);
    expect(gate.maxActiveFor("qa")).toBe(1);
    expect(gate.maxActiveFor("lesson")).toBe(1);
    expect(gate.active()).toBe(0);
  });

  test("a permit is released even when the task rejects", async () => {
    const gate = createModelGate();
    await expect(
      gate.run("repo_job", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(gate.active()).toBe(0);
    await expect(gate.run("repo_job", async () => "ok")).resolves.toBe("ok");
  });
});
