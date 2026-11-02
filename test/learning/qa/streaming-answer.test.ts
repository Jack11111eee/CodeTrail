import { afterEach, describe, expect, it } from "vitest";

import { hitSourceId } from "../../../src/learning/qa/multi-context.ts";
import { QA_TOOL_NAMES } from "../../../src/learning/qa/tools.ts";
import {
  answerEntry,
  cleanupTempDirs,
  collect,
  createHarness,
  eventsOfType,
  publishGeneration,
  sourceHit,
  scriptDir,
  COMMIT_A,
  REPO_ID,
} from "./qa-helpers.ts";

/**
 * AC-QA-03 / AC-QA-10 (stream half): a turn emits deltas and a terminal `done`,
 * `answerPhase` is `generating` while the text streams, and `status` only moves
 * to `complete` after the checks pass. Citations are persisted.
 */

afterEach(() => {
  cleanupTempDirs();
});

function setup() {
  const hit = sourceHit(
    "g_stream",
    REPO_ID,
    COMMIT_A,
    "src/index.ts",
    "the snapshot cache evicts entries when the budget is exceeded",
    { start: 1, end: 2 },
  );
  const sourceId = hitSourceId(hit);
  const files = {
    "src/index.ts": "export class SnapshotCache {\n  evict(): void {}\n}\n",
  };
  const calls: { tools: string[]; inputTokens: number; outputTokens: number }[] =
    [];
  const dir = scriptDir([
    answerEntry({
      answer: "旧快照会被淘汰，因为缓存超过了预算上限。",
      conclusion: "code_fact",
      citations: [{ sourceId }],
    }),
  ]);
  const harness = createHarness({
    modelDir: dir,
    onCall: (info) => {
      calls.push({
        tools: info.tools,
        inputTokens: info.inputTokens,
        outputTokens: info.outputTokens,
      });
    },
    hits: { g_stream: [hit] },
    filesByGeneration: { g_stream: files },
    generationOfCommit: { [COMMIT_A]: "g_stream" },
  });
  const fixture = publishGeneration(harness.db, {
    generationId: "g_stream",
    sources: [{ path: "src/index.ts" }],
    files,
  });
  return { harness, fixture, hit, sourceId, calls };
}

describe("streaming answer", () => {
  it("emits deltas, a citation and a terminal done, then persists complete", async () => {
    const { harness, fixture, sourceId, calls } = setup();
    try {
      const conversation = await harness.conversations.create({
        generationIds: [fixture.generationId],
      });
      const events = await collect(
        harness.answers.answer({
          conversationId: conversation.conversationId,
          text: "旧快照为什么会被淘汰？",
          selection: null,
          signal: new AbortController().signal,
        }),
      );

      const start = eventsOfType(events, "start")[0];
      expect(start).toBeDefined();
      const deltas = eventsOfType(events, "delta");
      expect(deltas.length).toBeGreaterThan(0);
      expect(deltas.map((event) => event.text).join("")).toContain(
        "旧快照会被淘汰",
      );
      const citations = eventsOfType(events, "citation");
      expect(citations[0]).toMatchObject({
        sourceId,
        commitSha: COMMIT_A,
      });
      expect(events.at(-1)).toMatchObject({
        type: "done",
        status: "complete",
        incomplete: false,
      });

      const stored = (
        await harness.conversations.get(conversation.conversationId)
      )!.messages.find((message) => message.role === "assistant")!;
      expect(stored.status).toBe("complete");
      expect(stored.answerPhase).toBe("complete");
      expect(stored.citations).toHaveLength(1);
      expect(stored.citations[0]).toMatchObject({
        sourceId,
        generationId: fixture.generationId,
        commitSha: COMMIT_A,
      });
      expect(stored.checks).toEqual({
        structural: "pass",
        evidence: "pass",
        semantic: "pass",
      });

      // Exactly one retrieval search for the one bound generation, and the
      // model saw exactly the five read-only tool names.
      expect(harness.retriever.calls).toHaveLength(1);
      expect(calls[0].tools).toEqual([...QA_TOOL_NAMES]);
    } finally {
      harness.db.close();
    }
  });

  it("reports answerPhase=generating while the text is still streaming", async () => {
    const { harness, fixture } = setup();
    try {
      const conversation = await harness.conversations.create({
        generationIds: [fixture.generationId],
      });
      const seen: { status: string; answerPhase: string }[] = [];
      const stream = harness.answers.answer({
        conversationId: conversation.conversationId,
        text: "为什么？",
        selection: null,
        signal: new AbortController().signal,
      });
      for await (const event of stream) {
        if (event.type === "start") {
          const record = harness.db.repos.conversations
            .messages(conversation.conversationId)
            .find((message) => message.messageId === event.messageId);
          if (record !== undefined) {
            seen.push({
              status: record.status,
              answerPhase: record.answerPhase,
            });
          }
        }
        if (event.type === "delta") {
          const record = harness.db.repos.conversations
            .messages(conversation.conversationId)
            .find((message) => message.role === "assistant");
          if (record !== undefined) {
            seen.push({
              status: record.status,
              answerPhase: record.answerPhase,
            });
          }
        }
      }

      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]).toEqual({ status: "streaming", answerPhase: "generating" });
      expect(seen.every((entry) => entry.answerPhase !== "complete")).toBe(true);
    } finally {
      harness.db.close();
    }
  });
});
