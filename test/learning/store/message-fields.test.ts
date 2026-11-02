import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ConversationId,
  GenerationId,
  LessonId,
  MessageId,
  Repositories,
} from "../../../src/learning/contracts/index.ts";
import { createRepositories } from "../../../src/learning/store/index.ts";
import {
  AT,
  closeTempDb,
  createTempDb,
  makeCitation,
  makeMessage,
  type TempDb,
} from "./helpers.ts";

const STORE_DIR = fileURLToPath(
  new URL("../../../src/learning/store", import.meta.url),
);

describe("store message fields", () => {
  let ctx: TempDb;
  let repos: Repositories;

  beforeEach(() => {
    ctx = createTempDb();
    repos = createRepositories(ctx.db);
    repos.conversations.insert({
      conversationId: "c_1" as ConversationId,
      generationIds: ["g_1" as GenerationId],
      at: AT,
    });
  });

  afterEach(() => {
    closeTempDb(ctx);
  });

  it("round-trips answer_phase, unknown_reason and incomplete verbatim", () => {
    const message = makeMessage({
      messageId: "m_1" as MessageId,
      status: "streaming",
      answerPhase: "checking",
      unknownReason: "insufficient_context",
      incomplete: true,
      citations: [makeCitation()],
      selection: {
        lessonId: "l_1" as LessonId,
        moduleId: "module-1",
        codeLocation: { path: "src/index.ts", lines: { start: 1, end: 3 } },
      },
      checks: { structural: "pass", evidence: "pass", semantic: "skipped" },
    });

    repos.conversations.insertMessage(message);

    const [restored] = repos.conversations.messages("c_1" as ConversationId);
    expect(restored).toEqual(message);

    // The values live in columns; they are never derived from `status`.
    const row = ctx.db.raw
      .prepare(
        `SELECT answer_phase, unknown_reason, incomplete FROM messages
         WHERE message_id = ?`,
      )
      .get("m_1") as {
      answer_phase: string;
      unknown_reason: string | null;
      incomplete: number;
    };
    expect(row).toEqual({
      answer_phase: "checking",
      unknown_reason: "insufficient_context",
      incomplete: 1,
    });
  });

  it("keeps NULL citations as an empty array and incomplete false as 0", () => {
    repos.conversations.insertMessage(
      makeMessage({
        messageId: "m_2" as MessageId,
        citations: [],
        incomplete: false,
        unknownReason: null,
      }),
    );
    const row = ctx.db.raw
      .prepare(
        "SELECT citations_json, incomplete, unknown_reason FROM messages WHERE message_id = ?",
      )
      .get("m_2") as {
      citations_json: string;
      incomplete: number;
      unknown_reason: string | null;
    };
    expect(row.citations_json).toBe("[]");
    expect(row.incomplete).toBe(0);
    expect(row.unknown_reason).toBeNull();
    expect(
      repos.conversations.messages("c_1" as ConversationId)[0]?.citations,
    ).toEqual([]);
  });

  it("cancelStreaming rewrites every streaming row and returns the count", () => {
    repos.conversations.insertMessage(
      makeMessage({
        messageId: "m_streaming_check" as MessageId,
        status: "streaming",
        answerPhase: "checking",
      }),
    );
    repos.conversations.insertMessage(
      makeMessage({
        messageId: "m_streaming_gen" as MessageId,
        status: "streaming",
        answerPhase: "generating",
      }),
    );
    repos.conversations.insertMessage(
      makeMessage({
        messageId: "m_complete" as MessageId,
        status: "complete",
        answerPhase: "complete",
      }),
    );

    expect(repos.conversations.cancelStreaming()).toBe(2);
    expect(repos.conversations.cancelStreaming()).toBe(0);

    const messages = repos.conversations.messages("c_1" as ConversationId);
    const byId = new Map(messages.map((m) => [m.messageId, m]));
    expect(byId.get("m_streaming_check" as MessageId)).toMatchObject({
      status: "cancelled",
      answerPhase: "cancelled",
    });
    expect(byId.get("m_streaming_gen" as MessageId)).toMatchObject({
      status: "cancelled",
      answerPhase: "cancelled",
    });
    expect(byId.get("m_complete" as MessageId)).toMatchObject({
      status: "complete",
      answerPhase: "complete",
    });
  });

  it("has a partial index on status = 'streaming'", () => {
    const indexes = ctx.db.raw
      .prepare("PRAGMA index_list('messages')")
      .all() as {
      name: string;
      partial: number;
    }[];
    const streaming = indexes.find(
      (index) => index.name === "idx_messages_streaming",
    );
    expect(streaming?.partial).toBe(1);

    const row = ctx.db.raw
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_streaming'",
      )
      .get() as { sql: string };
    expect(row.sql).toMatch(/WHERE\s+status\s*=\s*'streaming'/);
  });

  it("has no update path for conversations.generation_ids_json", () => {
    const files = fs
      .readdirSync(STORE_DIR)
      .filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);

    for (const name of files) {
      const source = fs.readFileSync(path.join(STORE_DIR, name), "utf8");
      expect(source, name).not.toMatch(
        /UPDATE\s+conversations\s+SET[^`]*generation_ids_json/i,
      );
      expect(source, name).not.toMatch(/generation_ids_json\s*=/i);
    }

    const conversations = fs.readFileSync(
      path.join(STORE_DIR, "conversations.repo.ts"),
      "utf8",
    );
    expect(conversations).toMatch(
      /UPDATE\s+conversations\s+SET\s+last_active_at/,
    );
  });
});
