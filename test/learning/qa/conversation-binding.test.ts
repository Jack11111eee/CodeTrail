import { afterEach, describe, expect, it } from "vitest";

import { LearningError } from "../../../src/learning/contracts/index.ts";
import type { GenerationId, MessageRecord } from "../../../src/learning/contracts/index.ts";
import {
  assertGenerationSet,
  assertVersionPinned,
  createConversationService,
  toConversationView,
  toMessageView,
} from "../../../src/learning/qa/conversations.ts";
import { createRepositories, openDatabase } from "../../../src/learning/store/index.ts";
import { makeMessage } from "../store/helpers.ts";
import {
  AT,
  cleanupTempDirs,
  createQaDb,
  publishGeneration,
} from "./qa-helpers.ts";

/**
 * AC-QA-01: a conversation binds exactly one or two published generations,
 * `generation_ids_json` is immutable afterwards, and the record → DTO mapping
 * is the single mapping site (availability resolved at read time).
 */

afterEach(() => {
  cleanupTempDirs();
});

function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

describe("assertGenerationSet", () => {
  it("accepts exactly one or two ids", () => {
    expect(() => assertGenerationSet(["g_1"] as GenerationId[])).not.toThrow();
    expect(() =>
      assertGenerationSet(["g_1", "g_2"] as GenerationId[]),
    ).not.toThrow();
  });

  it("rejects zero, three, duplicates and blanks with invalid_input", () => {
    for (const ids of [
      [],
      ["g_1", "g_2", "g_3"],
      ["g_1", "g_1"],
      [""],
    ]) {
      const error = capture(() => assertGenerationSet(ids as GenerationId[]));
      expect(error, JSON.stringify(ids)).toBeInstanceOf(LearningError);
      expect((error as LearningError).code).toBe("invalid_input");
    }
  });
});

describe("conversation binding", () => {
  it("creates a conversation for one or two published generations", async () => {
    const ctx = createQaDb();
    try {
      const first = publishGeneration(ctx, { generationId: "g_1" });
      const second = publishGeneration(ctx, {
        generationId: "g_2",
        repoId: "r_second",
        projectId: "p_second",
        commitSha: "b".repeat(40),
      });
      const conversations = createConversationService({
        db: ctx.db,
        repos: ctx.repos,
        clock: ctx.clock,
      });

      const one = await conversations.create({
        generationIds: [first.generationId],
      });
      expect(one.generationIds).toEqual([first.generationId]);
      expect(one.messages).toEqual([]);

      const two = await conversations.create({
        generationIds: [first.generationId, second.generationId],
      });
      expect(two.generationIds).toEqual([
        first.generationId,
        second.generationId,
      ]);
    } finally {
      ctx.close();
    }
  });

  it("rejects zero or three ids and an unpublished id", async () => {
    const ctx = createQaDb();
    try {
      const published = publishGeneration(ctx, { generationId: "g_1" });
      const unpublished = publishGeneration(ctx, {
        generationId: "g_staged",
        status: "staged",
        sealedTreeHash: null,
      });
      const conversations = createConversationService({
        db: ctx.db,
        repos: ctx.repos,
        clock: ctx.clock,
      });

      await expect(conversations.create({ generationIds: [] })).rejects.toMatchObject({
        code: "invalid_input",
      });
      await expect(
        conversations.create({
          generationIds: [
            published.generationId,
            "g_missing" as GenerationId,
            "g_more" as GenerationId,
          ],
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(
        conversations.create({ generationIds: [unpublished.generationId] }),
      ).rejects.toMatchObject({ code: "unpublished_generation" });
      await expect(
        conversations.create({ generationIds: ["g_unknown" as GenerationId] }),
      ).rejects.toMatchObject({ code: "unpublished_generation" });
    } finally {
      ctx.close();
    }
  });

  it("keeps generation_ids_json immutable", async () => {
    const ctx = createQaDb();
    try {
      const first = publishGeneration(ctx, { generationId: "g_1" });
      const second = publishGeneration(ctx, {
        generationId: "g_2",
        repoId: "r_second",
        projectId: "p_second",
        commitSha: "b".repeat(40),
      });
      const conversations = createConversationService({
        db: ctx.db,
        repos: ctx.repos,
        clock: ctx.clock,
      });

      const conversation = await conversations.create({
        generationIds: [first.generationId],
      });
      await conversations.create({ generationIds: [second.generationId] });

      const reread = await conversations.get(conversation.conversationId);
      expect(reread?.generationIds).toEqual([first.generationId]);
      expect(ctx.repos.conversations.byId(conversation.conversationId)?.generationIds).toEqual([
        first.generationId,
      ]);

      expect(() =>
        assertVersionPinned(conversation, second.generationId),
      ).toThrowError(LearningError);
      const error = capture(() =>
        assertVersionPinned(conversation, second.generationId),
      ) as LearningError;
      expect(error.code).toBe("conflict");
      expect(error.details?.reason).toBe("generation_immutable");
      expect(() =>
        assertVersionPinned(conversation, first.generationId),
      ).not.toThrow();
    } finally {
      ctx.close();
    }
  });

  it("never dedupes two identical creations", async () => {
    const ctx = createQaDb();
    try {
      const fixture = publishGeneration(ctx, { generationId: "g_1" });
      const conversations = createConversationService({
        db: ctx.db,
        repos: ctx.repos,
        clock: ctx.clock,
      });
      const first = await conversations.create({
        generationIds: [fixture.generationId],
      });
      const second = await conversations.create({
        generationIds: [fixture.generationId],
      });
      expect(first.conversationId).not.toBe(second.conversationId);
    } finally {
      ctx.close();
    }
  });
});

describe("message persistence and views", () => {
  it("persists answerPhase, unknownReason and incomplete for a restart", async () => {
    const ctx = createQaDb();
    try {
      const fixture = publishGeneration(ctx, {
        generationId: "g_1",
        lessons: [{ lessonId: "l_1", moduleIds: ["m_snapshot"] }],
      });
      const conversations = createConversationService({
        db: ctx.db,
        repos: ctx.repos,
        clock: ctx.clock,
      });
      const conversation = await conversations.create({
        generationIds: [fixture.generationId],
      });

      const user = await conversations.appendUserMessage(
        conversation.conversationId,
        "为什么会这样？",
        { moduleId: "m_snapshot" },
      );
      expect(user.role).toBe("user");

      const assistant: MessageRecord = makeMessage({
        messageId: "m_assistant" as never,
        conversationId: conversation.conversationId,
        role: "assistant",
        content: "",
        status: "streaming",
        answerPhase: "generating",
      });
      ctx.repos.conversations.insertMessage(assistant);
      await conversations.setAnswerPhase(
        conversation.conversationId,
        assistant.messageId,
        "checking",
      );
      await conversations.finalizeMessage(
        conversation.conversationId,
        assistant.messageId,
        {
          status: "failed",
          answerPhase: "failed",
          citations: [],
          checks: { structural: "pass", evidence: "failed", semantic: "pass" },
          unknownReason: "uncited_conclusion",
          incomplete: true,
        },
      );

      // Simulate a restart: a fresh repository set over the same database file.
      const reopened = openDatabase({ file: ctx.file });
      const repos = createRepositories(reopened);
      const stored = repos.conversations
        .messages(conversation.conversationId)
        .find((message) => message.messageId === "m_assistant");
      const selections = repos.conversations.selections(
        conversation.conversationId,
      );
      reopened.close();

      expect(stored).toMatchObject({
        status: "failed",
        answerPhase: "failed",
        unknownReason: "uncited_conclusion",
        incomplete: true,
        checks: { evidence: "failed" },
      });
      expect(selections).toHaveLength(1);
    } finally {
      ctx.close();
    }
  });

  it("applies the boot cancelStreaming rule to a streaming message", async () => {
    const ctx = createQaDb();
    try {
      const fixture = publishGeneration(ctx, { generationId: "g_1" });
      const conversations = createConversationService({
        db: ctx.db,
        repos: ctx.repos,
        clock: ctx.clock,
      });
      const conversation = await conversations.create({
        generationIds: [fixture.generationId],
      });
      ctx.repos.conversations.insertMessage(
        makeMessage({
          messageId: "m_streaming" as never,
          conversationId: conversation.conversationId,
          status: "streaming",
          answerPhase: "generating",
        }),
      );

      expect(ctx.repos.conversations.cancelStreaming()).toBe(1);
      const stored = (await conversations.get(conversation.conversationId))?.messages.find(
        (message) => message.messageId === "m_streaming",
      );
      expect(stored?.status).toBe("cancelled");
      expect(stored?.answerPhase).toBe("cancelled");
    } finally {
      ctx.close();
    }
  });

  it("maps a snapshot to the DTO with citation availability", async () => {
    const ctx = createQaDb();
    try {
      const fixture = publishGeneration(ctx, { generationId: "g_1" });
      const conversations = createConversationService({
        db: ctx.db,
        repos: ctx.repos,
        clock: ctx.clock,
      });
      const conversation = await conversations.create({
        generationIds: [fixture.generationId],
      });
      ctx.repos.conversations.insertMessage(
        makeMessage({
          messageId: "m_1" as never,
          conversationId: conversation.conversationId,
          citations: [
            {
              sourceId: "s_1" as never,
              generationId: fixture.generationId,
              commitSha: fixture.commitSha,
              label: "src/index.ts:1-2",
            },
          ],
        }),
      );

      const snapshot = (await conversations.get(conversation.conversationId))!;
      const view = toConversationView(snapshot, () => "source_removed");
      expect(view.messages[0].citations[0].availability).toBe("source_removed");

      const messageView = toMessageView(snapshot.messages[0], () => "available");
      expect(messageView.answerPhase).toBe("complete");
      expect(messageView.citations[0].availability).toBe("available");
      expect(messageView.createdAt).toBe(AT);
    } finally {
      ctx.close();
    }
  });
});
