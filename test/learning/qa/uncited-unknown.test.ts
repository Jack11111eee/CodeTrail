import { afterEach, describe, expect, it } from "vitest";

import {
  answerEntry,
  cleanupTempDirs,
  collect,
  createHarness,
  eventsOfType,
  publishGeneration,
  scriptDir,
  sourceHit,
  COMMIT_A,
  REPO_ID,
} from "./qa-helpers.ts";

/**
 * AC-QA-14: a conclusion without citations is marked `unknown` with a reason
 * and never counted as `code_fact`. A model that honestly says "unknown" may
 * complete, but its `unknownReason` survives the restart columns.
 */

afterEach(() => {
  cleanupTempDirs();
});

const FILES = { "src/index.ts": "export const ledger = 1;\n" };

async function run(payload: unknown) {
  const dir = scriptDir([answerEntry(payload)]);
  const hit = sourceHit(
    "g_uncited",
    REPO_ID,
    COMMIT_A,
    "src/index.ts",
    "the ledger records invoices",
  );
  const harness = createHarness({
    modelDir: dir,
    hits: { g_uncited: [hit] },
    filesByGeneration: { g_uncited: FILES },
    generationOfCommit: { [COMMIT_A]: "g_uncited" },
  });
  const fixture = publishGeneration(harness.db, {
    generationId: "g_uncited",
    sources: [{ path: "src/index.ts" }],
    files: FILES,
  });
  const conversation = await harness.conversations.create({
    generationIds: [fixture.generationId],
  });
  const events = await collect(
    harness.answers.answer({
      conversationId: conversation.conversationId,
      text: "这是真的吗？",
      selection: null,
      signal: new AbortController().signal,
    }),
  );
  const assistant = (
    await harness.conversations.get(conversation.conversationId)
  )!.messages.find((message) => message.role === "assistant")!;
  return { harness, events, assistant };
}

describe("uncited conclusions", () => {
  it("downgrades an uncited code_fact to unknown with a reason", async () => {
    const { harness, events, assistant } = await run({
      answer: "账本一定记录发票。",
      conclusion: "code_fact",
      citations: [],
    });
    try {
      expect(assistant.citations).toEqual([]);
      expect(assistant.unknownReason).toBe("uncited_conclusion");
      expect(assistant.checks?.evidence).toBe("failed");
      expect(assistant.status).toBe("failed");
      expect(assistant.content).toContain("unknown");
      expect(assistant.content).toContain("uncited_conclusion");
      expect(assistant.content).not.toMatch(/label["：:]\s*code_fact/u);
      expect(events.at(-1)).toMatchObject({
        type: "done",
        status: "failed",
        unknownReason: "uncited_conclusion",
      });
    } finally {
      harness.db.close();
    }
  });

  it("completes an honest unknown but keeps the reason", async () => {
    const { harness, events, assistant } = await run({
      answer: "资料不足以回答这个问题。",
      conclusion: "unknown",
      citations: [],
    });
    try {
      expect(assistant.status).toBe("complete");
      expect(assistant.answerPhase).toBe("complete");
      expect(assistant.unknownReason).toBe("insufficient_evidence");
      expect(assistant.citations).toEqual([]);
      expect(eventsOfType(events, "check")[0]).toMatchObject({
        structural: "pass",
        evidence: "pass",
        semantic: "pass",
      });
      expect(assistant.content).toContain("insufficient_evidence");
    } finally {
      harness.db.close();
    }
  });
});
