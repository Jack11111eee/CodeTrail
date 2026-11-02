import { afterEach, describe, expect, it } from "vitest";

import { LearningError } from "../../../src/learning/contracts/index.ts";
import {
  assertSelectionOwned,
  createConversationService,
} from "../../../src/learning/qa/conversations.ts";
import { eventsOfType } from "./qa-helpers.ts";
import {
  cleanupTempDirs,
  collect,
  createHarness,
  createQaDb,
  publishGeneration,
} from "./qa-helpers.ts";

/**
 * AC-QA-02: every lesson/module/source/code-location id a selection names must
 * belong to a bound generation. The check is server-side and rejects foreign
 * ids with `version_mismatch` (409).
 */

afterEach(() => {
  cleanupTempDirs();
});

function fixture(ctx: ReturnType<typeof createQaDb>) {
  const generation = publishGeneration(ctx, {
    generationId: "g_owned",
    sources: [{ path: "src/index.ts" }],
    lessons: [{ lessonId: "l_1", moduleIds: ["m_snapshot"] }],
  });
  return { generation, sourceId: generation.sourceIds[0] };
}

function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

describe("selection ownership", () => {
  it("accepts lesson, module, source and code-location ids inside the binding", async () => {
    const ctx = createQaDb();
    try {
      const { generation, sourceId } = fixture(ctx);
      const conversations = createConversationService({
        db: ctx.db,
        repos: ctx.repos,
        clock: ctx.clock,
      });
      const conversation = await conversations.create({
        generationIds: [generation.generationId],
      });

      for (const selection of [
        { lessonId: "l_1" },
        { moduleId: "m_snapshot" },
        { sourceId },
        { codeLocation: { path: "src/index.ts", lines: { start: 1, end: 2 } } },
      ]) {
        await expect(
          conversations.appendUserMessage(
            conversation.conversationId,
            "问题",
            selection as never,
          ),
        ).resolves.toBeDefined();
      }
      expect(
        (await conversations.get(conversation.conversationId))?.selections,
      ).toHaveLength(4);
    } finally {
      ctx.close();
    }
  });

  it("rejects a foreign lesson, module, source or code location", async () => {
    const ctx = createQaDb();
    try {
      const { generation } = fixture(ctx);
      const conversations = createConversationService({
        db: ctx.db,
        repos: ctx.repos,
        clock: ctx.clock,
      });
      const conversation = await conversations.create({
        generationIds: [generation.generationId],
      });

      for (const selection of [
        { lessonId: "l_foreign" },
        { moduleId: "m_foreign" },
        { sourceId: "s_foreign" },
        { codeLocation: { path: ".env", lines: { start: 1, end: 1 } } },
        { codeLocation: { path: "../escape.ts", lines: { start: 1, end: 1 } } },
      ]) {
        await expect(
          conversations.appendUserMessage(
            conversation.conversationId,
            "问题",
            selection as never,
          ),
          JSON.stringify(selection),
        ).rejects.toMatchObject({ code: "version_mismatch" });
      }
    } finally {
      ctx.close();
    }
  });

  it("checks ownership in the assembler-facing helper too", () => {
    const ctx = createQaDb();
    try {
      const { generation, sourceId } = fixture(ctx);
      const error = capture(() =>
        assertSelectionOwned(
          ctx.repos,
          [generation.generationId],
          { lessonId: "l_foreign" as never },
        ),
      );
      expect(error).toBeInstanceOf(LearningError);
      expect((error as LearningError).code).toBe("version_mismatch");
      expect(() =>
        assertSelectionOwned(ctx.repos, [generation.generationId], {
          sourceId,
        }),
      ).not.toThrow();
    } finally {
      ctx.close();
    }
  });

  it("rejects a foreign selection on the answer path before any model call", async () => {
    const harness = createHarness();
    try {
      const published = publishGeneration(harness.db, {
        generationId: "g_owned",
        lessons: [{ lessonId: "l_1", moduleIds: ["m_snapshot"] }],
      });
      const conversation = await harness.conversations.create({
        generationIds: [published.generationId],
      });

      const events = await collect(
        harness.answers.answer({
          conversationId: conversation.conversationId,
          text: "问题",
          selection: { lessonId: "l_foreign" as never },
          signal: new AbortController().signal,
        }),
      );

      expect(eventsOfType(events, "error")[0]).toMatchObject({
        code: "version_mismatch",
      });
      expect(eventsOfType(events, "done")).toHaveLength(0);
      const messages = (
        await harness.conversations.get(conversation.conversationId)
      )?.messages;
      expect(messages).toHaveLength(0);
    } finally {
      harness.db.close();
    }
  });
});
