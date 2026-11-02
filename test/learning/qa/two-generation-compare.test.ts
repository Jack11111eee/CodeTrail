import { afterEach, describe, expect, it } from "vitest";

import type {
  GenerationId,
  RetrievalHit,
} from "../../../src/learning/contracts/index.ts";
import { assembleContext } from "../../../src/learning/qa/context.ts";
import {
  assembleMultiContext,
  bindingOf,
  hitSourceId,
} from "../../../src/learning/qa/multi-context.ts";
import {
  answerEntry,
  cleanupTempDirs,
  collect,
  createHarness,
  eventsOfType,
  publishGeneration,
  publishedRefOf,
  scriptDir,
  sourceHit,
  COMMIT_A,
  COMMIT_B,
  REPO_ID,
} from "./qa-helpers.ts";

/**
 * AC-QA-09: a two-generation conversation runs one search per generation,
 * interleaves the hits, attributes every citation to its own generation, and
 * refuses a foreign or unpublished binding.
 */

afterEach(() => {
  cleanupTempDirs();
});

const REPO_B = "r_second";
const FILES_A = { "src/a.ts": "export const a = 1;\n" };
const FILES_B = { "src/b.ts": "export const b = 2;\n" };

function hitA(): RetrievalHit {
  return sourceHit(
    "g_a",
    REPO_ID,
    COMMIT_A,
    "src/a.ts",
    "module a records invoices",
    { start: 1, end: 1 },
  );
}

function hitB(): RetrievalHit {
  return sourceHit(
    "g_b",
    REPO_B,
    COMMIT_B,
    "src/b.ts",
    "module b records receipts",
    { start: 1, end: 1 },
  );
}

function twoGenerationSetup(payloadFor: (ids: { a: string; b: string }) => unknown) {
  const a = hitA();
  const b = hitB();
  const ids = { a: hitSourceId(a), b: hitSourceId(b) };
  const dir = scriptDir([answerEntry(payloadFor(ids))]);
  const harness = createHarness({
    modelDir: dir,
    hits: { g_a: [a], g_b: [b] },
    filesByGeneration: { g_a: FILES_A, g_b: FILES_B },
    generationOfCommit: { [COMMIT_A]: "g_a", [COMMIT_B]: "g_b" },
  });
  const fixtureA = publishGeneration(harness.db, {
    generationId: "g_a",
    sources: [{ path: "src/a.ts" }],
    files: FILES_A,
  });
  const fixtureB = publishGeneration(harness.db, {
    generationId: "g_b",
    repoId: REPO_B,
    projectId: "p_second",
    commitSha: COMMIT_B,
    sources: [{ path: "src/b.ts" }],
    files: FILES_B,
  });
  return { harness, fixtureA, fixtureB, ids, hitA: a, hitB: b };
}

describe("two-generation conversations", () => {
  it("searches once per generation and attributes every citation", async () => {
    const { harness, fixtureA, fixtureB, ids } = twoGenerationSetup(
      ({ a, b }) => ({
        answer: "模块 a 记录发票，模块 b 记录收据。",
        conclusion: "code_fact",
        citations: [
          { sourceId: a, generationId: "g_a" },
          { sourceId: b, generationId: "g_b" },
        ],
      }),
    );
    try {
      const conversation = await harness.conversations.create({
        generationIds: [fixtureA.generationId, fixtureB.generationId],
      });
      const events = await collect(
        harness.answers.answer({
          conversationId: conversation.conversationId,
          text: "两个项目分别做什么？",
          selection: null,
          signal: new AbortController().signal,
        }),
      );

      expect(harness.retriever.calls.map((call) => call.generationId)).toEqual([
        "g_a",
        "g_b",
      ]);
      const citations = eventsOfType(events, "citation");
      expect(citations).toHaveLength(2);
      expect(citations[0]).toMatchObject({
        sourceId: ids.a,
        commitSha: COMMIT_A,
      });
      expect(citations[1]).toMatchObject({
        sourceId: ids.b,
        commitSha: COMMIT_B,
      });

      const assistant = (
        await harness.conversations.get(conversation.conversationId)
      )!.messages.find((message) => message.role === "assistant")!;
      expect(assistant.status).toBe("complete");
      expect(assistant.citations.map((citation) => citation.generationId)).toEqual([
        "g_a",
        "g_b",
      ]);
      expect(assistant.citations.map((citation) => citation.commitSha)).toEqual([
        COMMIT_A,
        COMMIT_B,
      ]);
    } finally {
      harness.db.close();
    }
  });

  it("rejects a citation whose generation is not in the binding", async () => {
    const { harness, fixtureA, fixtureB, ids } = twoGenerationSetup(
      ({ a }) => ({
        answer: "跨版本引用",
        conclusion: "code_fact",
        citations: [{ sourceId: a, generationId: "g_foreign" }],
      }),
    );
    try {
      // A third, published generation exists but is not part of the binding.
      publishGeneration(harness.db, {
        generationId: "g_foreign",
        repoId: "r_third",
        projectId: "p_third",
        commitSha: "c".repeat(40),
      });
      const conversation = await harness.conversations.create({
        generationIds: [fixtureA.generationId, fixtureB.generationId],
      });
      const events = await collect(
        harness.answers.answer({
          conversationId: conversation.conversationId,
          text: "比较一下",
          selection: null,
          signal: new AbortController().signal,
        }),
      );
      void ids;
      expect(eventsOfType(events, "check")[0].evidence).toBe("failed");
      expect(events.at(-1)).toMatchObject({ type: "done", status: "failed" });
      const assistant = (
        await harness.conversations.get(conversation.conversationId)
      )!.messages.find((message) => message.role === "assistant")!;
      expect(assistant.status).toBe("failed");
      expect(assistant.unknownReason).toBe("version_mismatch");
      expect(assistant.citations).toEqual([]);
    } finally {
      harness.db.close();
    }
  });

  it("rejects a source id mixed with another generation", async () => {
    const { harness, fixtureA, fixtureB, ids } = twoGenerationSetup(
      ({ a }) => ({
        answer: "错误归属",
        conclusion: "code_fact",
        citations: [{ sourceId: a, generationId: "g_b" }],
      }),
    );
    try {
      const conversation = await harness.conversations.create({
        generationIds: [fixtureA.generationId, fixtureB.generationId],
      });
      const events = await collect(
        harness.answers.answer({
          conversationId: conversation.conversationId,
          text: "比较一下",
          selection: null,
          signal: new AbortController().signal,
        }),
      );
      void ids;
      expect(eventsOfType(events, "check")[0].evidence).toBe("failed");
      expect(events.at(-1)).toMatchObject({ type: "done", status: "failed" });
    } finally {
      harness.db.close();
    }
  });

  it("refuses an unpublished generation id at creation", async () => {
    const harness = createHarness();
    try {
      publishGeneration(harness.db, {
        generationId: "g_staged",
        status: "staged",
        sealedTreeHash: null,
      });
      await expect(
        harness.conversations.create({
          generationIds: ["g_staged" as GenerationId],
        }),
      ).rejects.toMatchObject({ code: "unpublished_generation" });
    } finally {
      harness.db.close();
    }
  });
});

describe("assembleMultiContext", () => {
  it("interleaves round-robin and carries each generation on its section", () => {
    const ctx = createHarness();
    try {
      const fixtureA = publishGeneration(ctx.db, { generationId: "g_a" });
      const fixtureB = publishGeneration(ctx.db, {
        generationId: "g_b",
        repoId: REPO_B,
        projectId: "p_second",
        commitSha: COMMIT_B,
      });
      const a1: RetrievalHit = hitA();
      const a2: RetrievalHit = { ...hitA(), path: "src/a2.ts" };
      const b1 = hitB();
      const retrieved = new Map<GenerationId, RetrievalHit[]>([
        ["g_a" as GenerationId, [a1, a2]],
        ["g_b" as GenerationId, [b1]],
      ]);
      const binding = bindingOf([
        publishedRefOf(fixtureA),
        publishedRefOf(fixtureB),
      ]);
      const preferences = {
        explainLevel: "plain_first" as const,
        background: null,
        language: "zh" as const,
        version: 0,
      };
      const budget = { maxInputTokens: 10_000, reserveOutputTokens: 0 };

      const multi = assembleMultiContext({
        binding,
        selection: null,
        messages: [],
        retrieved,
        preferences,
        budget,
      });
      const retrievalSections = multi.sections.filter(
        (section) => section.role === "retrieval",
      );
      expect(retrievalSections.map((section) => section.generationId)).toEqual([
        "g_a",
        "g_b",
        "g_a",
      ]);

      const single = assembleContext({
        selection: null,
        messages: [],
        retrieved: retrieved.get("g_a" as GenerationId)!,
        preferences,
        budget,
      });
      const singleMulti = assembleMultiContext({
        binding: bindingOf([publishedRefOf(fixtureA)]),
        selection: null,
        messages: [],
        retrieved: new Map([
          ["g_a" as GenerationId, retrieved.get("g_a" as GenerationId)!],
        ]),
        preferences,
        budget,
      });
      expect(single.sections.map((section) => section.role)).toEqual(
        singleMulti.sections.map((section) => section.role),
      );
      expect(single.sections.map((section) => section.text)).toEqual(
        singleMulti.sections.map((section) => section.text),
      );
    } finally {
      ctx.db.close();
    }
  });
});
