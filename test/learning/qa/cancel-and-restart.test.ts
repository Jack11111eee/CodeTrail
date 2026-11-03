import { afterEach, describe, expect, it } from "vitest";

import type { AnswerEvent } from "../../../src/learning/contracts/index.ts";
import { summarizeMessages } from "../../../src/learning/qa/summarize.ts";
import { createRepositories, openDatabase } from "../../../src/learning/store/index.ts";
import {
  answerEntry,
  cleanupTempDirs,
  collect,
  createHarness,
  publishGeneration,
  scriptDir,
  sourceHit,
  COMMIT_A,
  REPO_ID,
} from "./qa-helpers.ts";

/**
 * AC-QA-15: a client disconnect leaves the message `cancelled`; after a restart
 * the conversation and its messages stay readable, and the cancelled content
 * enters neither the summary nor the fact statistics.
 */

afterEach(() => {
  cleanupTempDirs();
});

const FILES = { "src/index.ts": "export const ledger = 1;\n" };

describe("cancel and restart", () => {
  it("marks a disconnected turn cancelled and keeps it out of summaries", async () => {
    const hit = sourceHit(
      "g_cancel",
      REPO_ID,
      COMMIT_A,
      "src/index.ts",
      "the ledger records invoices",
      { start: 1, end: 1 },
    );
    const dir = scriptDir([
      answerEntry({
        answer: "这是一段很长的回答。".repeat(20),
        conclusion: "engineering_analysis",
        citations: [],
      }),
    ]);
    const harness = createHarness({
      modelDir: dir,
      hits: { g_cancel: [hit] },
      filesByGeneration: { g_cancel: FILES },
      generationOfCommit: { [COMMIT_A]: "g_cancel" },
    });
    const fixture = publishGeneration(harness.db, {
      generationId: "g_cancel",
      sources: [{ path: "src/index.ts" }],
      files: FILES,
    });
    const conversation = await harness.conversations.create({
      generationIds: [fixture.generationId],
    });
    const controller = new AbortController();
    const events: AnswerEvent[] = [];

    try {
      for await (const event of harness.answers.answer({
        conversationId: conversation.conversationId,
        text: "解释一下",
        selection: null,
        signal: controller.signal,
      })) {
        events.push(event);
        if (event.type === "delta") controller.abort();
      }

      expect(events.at(-1)).toMatchObject({
        type: "done",
        status: "cancelled",
      });
      const snapshot = (await harness.conversations.get(
        conversation.conversationId,
      ))!;
      const assistant = snapshot.messages.find(
        (message) => message.role === "assistant",
      )!;
      expect(assistant.status).toBe("cancelled");
      expect(assistant.answerPhase).toBe("cancelled");
      expect(assistant.citations).toEqual([]);

      // Restart: a fresh repository set over the same file.
      const reopened = openDatabase({ file: harness.db.file });
      const repos = createRepositories(reopened);
      expect(repos.conversations.cancelStreaming()).toBe(0);
      const reread = repos.conversations.messages(conversation.conversationId);
      const storedAssistant = reread.find(
        (message) => message.messageId === assistant.messageId,
      )!;
      expect(storedAssistant.status).toBe("cancelled");
      expect(
        repos.conversations.byId(conversation.conversationId)?.generationIds,
      ).toEqual([fixture.generationId]);

      const summary = summarizeMessages(reread);
      expect(summary.text).not.toContain("这是一段很长的回答");
      reopened.close();
    } finally {
      harness.db.close();
    }
  });

  it("cancels a turn whose signal is already aborted, before any retrieval", async () => {
    const dir = scriptDir([
      answerEntry({ answer: "不会被生成。", conclusion: "unknown", citations: [] }),
    ]);
    const harness = createHarness({
      modelDir: dir,
      hits: { g_abort: [] },
      filesByGeneration: { g_abort: FILES },
      generationOfCommit: { [COMMIT_A]: "g_abort" },
    });
    const fixture = publishGeneration(harness.db, {
      generationId: "g_abort",
      files: FILES,
    });
    const conversation = await harness.conversations.create({
      generationIds: [fixture.generationId],
    });
    const controller = new AbortController();
    controller.abort();

    try {
      const events = await collect(
        harness.answers.answer({
          conversationId: conversation.conversationId,
          text: "解释一下",
          selection: null,
          signal: controller.signal,
        }),
      );

      expect(events.at(-1)).toMatchObject({
        type: "done",
        status: "cancelled",
        unknownReason: "cancelled",
      });
      expect(harness.retriever.calls).toHaveLength(0);
      const assistant = (
        await harness.conversations.get(conversation.conversationId)
      )!.messages.find((message) => message.role === "assistant")!;
      expect(assistant.status).toBe("cancelled");
      expect(assistant.answerPhase).toBe("cancelled");
      expect(assistant.content).toBe("");
    } finally {
      harness.db.close();
    }
  });
});
