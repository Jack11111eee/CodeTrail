import { afterEach, expect, it } from "vitest";
import {
  answerEntry,
  cleanupTempDirs,
  collect,
  createHarness,
  publishGeneration,
  scriptDir,
} from "./qa-helpers.ts";
afterEach(cleanupTempDirs);
it("gets an optional topic title from the same answer call without changing ordinary Q&A", async () => {
  let count = 0;
  const harness = createHarness({
    modelDir: scriptDir([
      answerEntry({
        answer: "现有证据不足，请指定入口文件。",
        conclusion: "unknown",
        citations: [],
        topicTitle: "风险评分的调用过程",
      }),
    ]),
    onCall: () => {
      count++;
    },
  });
  try {
    const generation = publishGeneration(harness.db, {
      generationId: "g_topic_title",
      sources: [],
    });
    const conversation = await harness.conversations.create({
      generationIds: [generation.generationId],
    });
    const events = await collect(
      harness.answers.answer({
        conversationId: conversation.conversationId,
        text: "风险评分如何调用？",
        selection: null,
        signal: new AbortController().signal,
        topic: { title: null, suggestTitle: true, initial: true },
      }),
    );
    expect(events).toContainEqual({
      type: "topic_title",
      title: "风险评分的调用过程",
    });
    expect(events.at(-1)).toMatchObject({ type: "done", status: "complete" });
    expect(count).toBe(1);
    expect(
      (
        await harness.conversations.get(conversation.conversationId)
      )?.messages.at(-1)?.content,
    ).toContain("现有证据不足，请指定入口文件。");
  } finally {
    harness.db.close();
  }
});
