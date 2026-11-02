import { describe, expect, it } from "vitest";

import type { MessageRecord, RetrievalHit } from "../../../src/learning/contracts/index.ts";
import { assembleContext } from "../../../src/learning/qa/context.ts";
import { estimateTokens } from "../../../src/learning/qa/multi-context.ts";
import { summarizeMessages } from "../../../src/learning/qa/summarize.ts";
import { AT, makeMessage } from "../store/helpers.ts";

/**
 * AC-QA-06 / AC-QA-11 (context half): the section order is fixed, the oldest
 * dialogue is dropped first and replaced by a source-tagged summary plus the
 * unresolved questions, `cancelled`/`failed` messages never enter either, and
 * an exhausted budget reports what it could not cover.
 */

const LONG = "长".repeat(200);
const LONG_ANSWER = "答".repeat(200);

function hit(preview: string): RetrievalHit {
  return {
    kind: "wiki",
    binding: {
      generationId: "g_1" as never,
      repoId: "r_1" as never,
      commitSha: "a".repeat(40),
    },
    page: "guide/intro",
    anchor: "",
    preview,
  };
}

function message(overrides: Partial<MessageRecord>): MessageRecord {
  return makeMessage(overrides);
}

describe("assembleContext section order", () => {
  it("emits selection → history → retrieval → preferences", () => {
    const messages = [
      message({ messageId: "m_1", role: "user", content: "问题一" }),
      message({
        messageId: "m_2",
        role: "assistant",
        content: "回答一",
        citations: [
          {
            sourceId: "s_1" as never,
            generationId: "g_1" as never,
            commitSha: "a".repeat(40),
            label: "src/index.ts:1-2",
          },
        ],
      }),
    ];
    const context = assembleContext({
      selection: { moduleId: "m_snapshot", sourceId: "s_1" as never },
      messages,
      retrieved: [hit("snapshot cache eviction")],
      preferences: {
        explainLevel: "plain_first",
        background: "熟悉 Python",
        language: "zh",
        version: 0,
      },
      budget: { maxInputTokens: 10_000, reserveOutputTokens: 0 },
    });

    expect(context.sections.map((section) => section.role)).toEqual([
      "selection",
      "history",
      "history",
      "retrieval",
      "preferences",
    ]);
    expect(context.sections[0].sources).toEqual(["s_1"]);
    expect(context.sections[2].sources).toEqual(["s_1"]);
    expect(context.sections[3].text).toContain("untrusted_content");
    expect(context.sections[3].generationId).toBe("g_1");
    expect(context.truncated).toBe(false);
    expect(context.totalTokens).toBe(
      context.sections.reduce((sum, section) => sum + section.tokens, 0),
    );
    for (const section of context.sections) {
      expect(section.tokens).toBe(estimateTokens(section.text));
    }
  });
});

describe("assembleContext under a tight budget", () => {
  const messages = [
    message({ messageId: "m_0", role: "user", content: "旧未解问题" }),
    message({ messageId: "m_1", role: "user", content: LONG }),
    message({
      messageId: "m_2",
      role: "assistant",
      content: LONG_ANSWER,
      citations: [
        {
          sourceId: "s_1" as never,
          generationId: "g_1" as never,
          commitSha: "a".repeat(40),
          label: "src/index.ts:1-2",
        },
      ],
    }),
    message({
      messageId: "m_cancelled",
      role: "assistant",
      content: "CANCELLED_SECRET",
      status: "cancelled",
      answerPhase: "cancelled",
    }),
    message({
      messageId: "m_failed",
      role: "assistant",
      content: "FAILED_SECRET",
      status: "failed",
      answerPhase: "failed",
    }),
    message({ messageId: "m_3", role: "user", content: "第二个问题" }),
  ];

  it("keeps a source-tagged summary and the unresolved questions", () => {
    const context = assembleContext({
      selection: { moduleId: "m_snapshot" },
      messages,
      retrieved: [],
      preferences: {
        explainLevel: "plain_first",
        background: null,
        language: "zh",
        version: 0,
      },
      budget: { maxInputTokens: 110, reserveOutputTokens: 0 },
    });

    expect(context.sections.map((section) => section.role)).toEqual([
      "selection",
      "history_summary",
      "history",
      "preferences",
    ]);
    const summary = context.sections[1];
    expect(summary.sources).toEqual(["s_1"]);
    expect(summary.text).toContain("[来源: s_1]");
    expect(summary.text).toContain("未解问题");
    expect(summary.text).toContain("旧未解问题");
    expect(context.truncated).toBe(true);

    const allText = context.sections.map((section) => section.text).join("\n");
    expect(allText).not.toContain("CANCELLED_SECRET");
    expect(allText).not.toContain("FAILED_SECRET");
  });

  it("names what the budget could not cover", () => {
    const context = assembleContext({
      selection: { moduleId: "m_snapshot" },
      messages,
      retrieved: [hit("X".repeat(4000))],
      preferences: {
        explainLevel: "plain_first",
        background: null,
        language: "zh",
        version: 0,
      },
      budget: { maxInputTokens: 60, reserveOutputTokens: 0 },
    });

    expect(context.truncated).toBe(true);
    expect(context.uncovered).toContain("retrieval: guide/intro");
  });
});

describe("summarizeMessages", () => {
  it("never includes cancelled or failed messages", () => {
    const summary = summarizeMessages([
      message({ messageId: "m_1", role: "user", content: "问题" }),
      message({
        messageId: "m_2",
        role: "assistant",
        content: "可靠回答",
        citations: [
          {
            sourceId: "s_1" as never,
            generationId: "g_1" as never,
            commitSha: "a".repeat(40),
            label: "src/index.ts:1-2",
          },
        ],
      }),
      message({
        messageId: "m_3",
        role: "assistant",
        content: "取消的回答",
        status: "cancelled",
      }),
      message({
        messageId: "m_4",
        role: "assistant",
        content: "失败的检查",
        status: "failed",
      }),
    ]);

    expect(summary.text).toContain("可靠回答");
    expect(summary.text).not.toContain("取消的回答");
    expect(summary.text).not.toContain("失败的检查");
    expect(summary.sources).toEqual(["s_1"]);
    expect(summary.unresolved).toEqual([]);
  });

  it("reports a question with no satisfactory answer as unresolved", () => {
    const summary = summarizeMessages([
      message({ messageId: "m_1", role: "user", content: "未解的问题" }),
      message({
        messageId: "m_2",
        role: "assistant",
        content: "不确定",
        unknownReason: "insufficient_evidence",
      }),
    ]);
    expect(summary.unresolved).toEqual(["未解的问题"]);
  });

  it("is empty for no messages", () => {
    expect(summarizeMessages([])).toEqual({
      text: "",
      sources: [],
      unresolved: [],
    });
    expect(AT).toBe("2026-01-01T00:00:00.000Z");
  });
});
