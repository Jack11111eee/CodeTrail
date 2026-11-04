import { afterEach, describe, expect, it } from "vitest";

import { hitSourceId } from "../../../src/learning/qa/multi-context.ts";
import {
  answerEntry,
  cleanupTempDirs,
  collect,
  createHarness,
  publishGeneration,
  scriptDir,
  sourceHit,
  type Harness,
  COMMIT_A,
  COMMIT_B,
  REPO_ID,
} from "./qa-helpers.ts";

/**
 * AC-QA-12: a generation published mid-turn cannot change the binding. The turn
 * pins the generation ids it read at the start, so every citation keeps the
 * original commit, and the next turn uses the same generation.
 */

afterEach(() => {
  cleanupTempDirs();
});

const FILES = { "src/index.ts": "export const ledger = 1;\n" };

describe("the binding is frozen for the turn", () => {
  it("ignores a newer commit published while the answer is running", async () => {
    const hit = sourceHit(
      "g_old",
      REPO_ID,
      COMMIT_A,
      "src/index.ts",
      "the ledger records invoices",
      { start: 1, end: 1 },
    );
    const sourceId = hitSourceId(hit);
    const dir = scriptDir([
      answerEntry({
        answer: "账本记录发票。",
        conclusion: "code_fact",
        citations: [{ sourceId }],
      }),
      answerEntry(
        {
          answer: "仍然基于同一版本。",
          conclusion: "code_fact",
          citations: [{ sourceId }],
        },
        2,
      ),
    ]);

    let harnessRef: Harness | null = null;
    let publishedNew = false;
    const harness = createHarness({
      modelDir: dir,
      hits: { g_old: [hit] },
      filesByGeneration: { g_old: FILES },
      generationOfCommit: { [COMMIT_A]: "g_old" },
      onSearch: () => {
        if (publishedNew || harnessRef === null) return;
        publishedNew = true;
        publishGeneration(harnessRef.db, {
          generationId: "g_new",
          commitSha: COMMIT_B,
          files: FILES,
        });
      },
    });
    harnessRef = harness;
    const fixture = publishGeneration(harness.db, {
      generationId: "g_old",
      sources: [{ path: "src/index.ts" }],
      files: FILES,
    });
    const conversation = await harness.conversations.create({
      generationIds: [fixture.generationId],
    });

    try {
      await collect(
        harness.answers.answer({
          conversationId: conversation.conversationId,
          text: "旧快照为什么会被淘汰？",
          selection: null,
          signal: new AbortController().signal,
        }),
      );
      expect(publishedNew).toBe(true);
      const first = (
        await harness.conversations.get(conversation.conversationId)
      )!.messages.find((message) => message.role === "assistant")!;
      expect(first.citations).toHaveLength(1);
      expect(first.citations[0].commitSha).toBe(COMMIT_A);
      expect(first.citations[0].generationId).toBe("g_old");

      const newer = harness.db.repos.generations.byId("g_new" as never);
      expect(newer?.status).toBe("published");
      expect(newer?.commitSha).toBe(COMMIT_B);

      await collect(
        harness.answers.answer({
          conversationId: conversation.conversationId,
          text: "再解释一次",
          selection: null,
          signal: new AbortController().signal,
        }),
      );
      const snapshot = await harness.conversations.get(
        conversation.conversationId,
      );
      expect(snapshot?.generationIds).toEqual(["g_old"]);
      const second = snapshot!.messages.filter(
        (message) => message.role === "assistant",
      )[1];
      expect(second.citations[0].commitSha).toBe(COMMIT_A);
      expect(second.citations[0].generationId).toBe("g_old");
    } finally {
      harness.db.close();
    }
  });
});
