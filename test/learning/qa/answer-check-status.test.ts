import { afterEach, describe, expect, it } from "vitest";

import { hitSourceId } from "../../../src/learning/qa/multi-context.ts";
import { summarizeMessages } from "../../../src/learning/qa/summarize.ts";
import {
  answerEntry,
  cleanupTempDirs,
  collect,
  createHarness,
  eventsOfType,
  publishGeneration,
  rawAnswerEntry,
  scriptDir,
  sourceHit,
  COMMIT_A,
  REPO_ID,
} from "./qa-helpers.ts";

/**
 * AC-QA-10 / AC-QA-14: only a turn whose structural, evidence and semantic
 * checks all pass becomes `complete`. A failed check keeps `status:"failed"`
 * with a reason, and a failed message never counts as `code_fact` and never
 * enters a summary.
 */

afterEach(() => {
  cleanupTempDirs();
});

const FILES = { "src/index.ts": "export const ledger = 1;\n" };

function setup(
  makePayload: (sourceId: string) => unknown,
  raw = false,
) {
  const hit = sourceHit(
    "g_check",
    REPO_ID,
    COMMIT_A,
    "src/index.ts",
    "the ledger records invoices",
    { start: 1, end: 1 },
  );
  const sourceId = hitSourceId(hit);
  const payload = makePayload(sourceId);
  const dir = scriptDir([
    raw
      ? rawAnswerEntry(String(payload))
      : answerEntry(payload),
  ]);
  const harness = createHarness({
    modelDir: dir,
    hits: { g_check: [hit] },
    filesByGeneration: { g_check: FILES },
    generationOfCommit: { [COMMIT_A]: "g_check" },
  });
  const fixture = publishGeneration(harness.db, {
    generationId: "g_check",
    sources: [{ path: "src/index.ts" }],
    files: FILES,
  });
  return { harness, fixture, sourceId };
}

async function turn(
  makePayload: (sourceId: string) => unknown,
  raw = false,
) {
  const { harness, fixture, sourceId } = setup(makePayload, raw);
  const conversation = await harness.conversations.create({
    generationIds: [fixture.generationId],
  });
  const events = await collect(
    harness.answers.answer({
      conversationId: conversation.conversationId,
      text: "问题",
      selection: null,
      signal: new AbortController().signal,
    }),
  );
  const snapshot = (await harness.conversations.get(
    conversation.conversationId,
  ))!;
  const assistant = snapshot.messages.find(
    (message) => message.role === "assistant",
  )!;
  return { harness, fixture, sourceId, events, assistant, snapshot };
}

describe("answer check status", () => {
  it("marks complete only when every check passes", async () => {
    const { harness, events, assistant } = await turn((sourceId) => ({
      answer: "账本记录发票。",
      conclusion: "code_fact",
      citations: [{ sourceId }],
    }));
    try {
      expect(eventsOfType(events, "check")[0]).toMatchObject({
        structural: "pass",
        evidence: "pass",
        semantic: "pass",
      });
      expect(events.at(-1)).toMatchObject({ type: "done", status: "complete" });
      expect(assistant.status).toBe("complete");
      expect(assistant.checks?.evidence).toBe("pass");
    } finally {
      harness.db.close();
    }
  });

  it("keeps failed with a reason when the evidence check fails", async () => {
    const { harness, events, assistant } = await turn(() => ({
      answer: "账本记录发票。",
      conclusion: "code_fact",
      citations: [{ sourceId: "s_not_registered" }],
    }));
    try {
      const check = eventsOfType(events, "check")[0];
      expect(check.evidence).toBe("failed");
      expect(events.at(-1)).toMatchObject({
        type: "done",
        status: "failed",
      });
      expect(assistant.status).toBe("failed");
      expect(assistant.answerPhase).toBe("failed");
      expect(assistant.unknownReason).toBeTruthy();
      expect(assistant.checks?.evidence).toBe("failed");
    } finally {
      harness.db.close();
    }
  });

  it("keeps failed when the semantic check rejects the conclusion label", async () => {
    const { harness, events, assistant } = await turn((sourceId) => ({
      answer: "账本记录发票。",
      conclusion: "definitely_true",
      citations: [{ sourceId }],
    }));
    try {
      const check = eventsOfType(events, "check")[0];
      expect(check.semantic).toBe("failed");
      expect(events.at(-1)).toMatchObject({
        type: "done",
        status: "failed",
      });
      expect(assistant.unknownReason).toBe("semantic_check_failed");
    } finally {
      harness.db.close();
    }
  });

  it("keeps failed when the structural check cannot parse the answer", async () => {
    const { harness, events, assistant } = await turn(() => "这不是 JSON", true);
    try {
      const check = eventsOfType(events, "check")[0];
      expect(check.structural).toBe("failed");
      expect(events.at(-1)).toMatchObject({
        type: "done",
        status: "failed",
      });
      expect(assistant.status).toBe("failed");
      expect(assistant.unknownReason).toBe("structural_check_failed");
    } finally {
      harness.db.close();
    }
  });

  it("never lets a failed check produce complete, and never counts it as a fact", async () => {
    for (const makePayload of [
      () => ({
        answer: "a",
        conclusion: "code_fact",
        citations: [{ sourceId: "s_x" }],
      }),
      () => ({ answer: "a", conclusion: "guess", citations: [] }),
      () => ({ answer: "", conclusion: "code_fact", citations: [] }),
    ]) {
      const { harness, events, assistant, snapshot } = await turn(makePayload);
      try {
        const check = eventsOfType(events, "check")[0];
        const failed =
          check.structural === "failed" ||
          check.evidence === "failed" ||
          check.semantic === "failed";
        if (failed) {
          expect(events.at(-1)).toMatchObject({
            type: "done",
            status: "failed",
          });
          expect(assistant.status).not.toBe("complete");
          const summary = summarizeMessages(snapshot.messages);
          expect(summary.text).not.toContain(assistant.content);
        }
      } finally {
        harness.db.close();
      }
    }
  });
});
