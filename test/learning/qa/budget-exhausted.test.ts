import { afterEach, describe, expect, it } from "vitest";

import { QA_LIMITS } from "../../../src/learning/config/defaults.ts";
import {
  cleanupTempDirs,
  collect,
  createHarness,
  publishGeneration,
  scriptDir,
  toolEntry,
  answerEntry,
  COMMIT_A,
} from "./qa-helpers.ts";

/**
 * AC-QA-11: at the tool-call cap retrieval stops, the answer is marked
 * `incomplete:true` and names what was not covered, and the model is never
 * asked for more calls than the configured budget allows.
 */

afterEach(() => {
  cleanupTempDirs();
});

describe("tool budget exhaustion", () => {
  it("stops at maxToolCalls, names the uncovered work and stays within the cap", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < QA_LIMITS.maxToolCalls + 1; index += 1) {
      files[`src/f${index}.ts`] = `export const value${index} = ${index};\n`;
    }

    const toolCalls = Object.keys(files).map((filePath) => ({
      name: "read_snapshot_file",
      args: { path: filePath },
    }));
    const calls: { tools: string[] }[] = [];
    const dir = scriptDir([
      toolEntry(toolCalls, 1),
      answerEntry(
        {
          answer: "只能读到预算允许的部分。",
          conclusion: "unknown",
          citations: [],
        },
        2,
      ),
    ]);
    const harness = createHarness({
      modelDir: dir,
      onCall: (info) => calls.push({ tools: info.tools }),
      hits: { g_budget: [] },
      filesByGeneration: { g_budget: files },
      generationOfCommit: { [COMMIT_A]: "g_budget" },
    });
    const fixture = publishGeneration(harness.db, {
      generationId: "g_budget",
      sources: [{ path: "src/f0.ts" }],
      files,
    });
    const conversation = await harness.conversations.create({
      generationIds: [fixture.generationId],
    });

    const events = await collect(
      harness.answers.answer({
        conversationId: conversation.conversationId,
        text: "把所有文件都读一遍",
        selection: null,
        signal: new AbortController().signal,
      }),
    );

    try {
      const assistant = (
        await harness.conversations.get(conversation.conversationId)
      )!.messages.find((message) => message.role === "assistant")!;

      // The last (ninth) tool call was never executed.
      expect(harness.snapshotService.reads).toBe(QA_LIMITS.maxToolCalls);
      expect(assistant.incomplete).toBe(true);
      expect(assistant.content).toContain("未覆盖");
      expect(assistant.content).toContain("read_snapshot_file");
      expect(assistant.content).toContain(`src/f${QA_LIMITS.maxToolCalls}.ts`);
      expect(events.at(-1)).toMatchObject({
        type: "done",
        incomplete: true,
      });

      // Two model calls (tools, then the answer) — well inside the cap.
      expect(calls.length).toBeLessThanOrEqual(QA_LIMITS.maxToolCalls + 2);
    } finally {
      harness.db.close();
    }
  });
});
