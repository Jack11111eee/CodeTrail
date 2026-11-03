/**
 * AC-F08-01 — preferences and background persist independently and affect the
 * answer context; term links point at the owning generation's source; a
 * two-repository comparison attributes each side to its own `repo_id`.
 *
 * The glossary has no HTTP write route (it is operator data), so the flow
 * seeds the term and its link through the data directory's own SQLite file and
 * then asserts the *read* contract the UI depends on.
 */

import { afterEach, describe, expect, test } from "vitest";

import { fixturePath, fixtureSha } from "../helpers/git-fixture.ts";

import {
  analyzeToCompletion,
  generationScripts,
  importLocal,
  jsonOf,
  postJson,
  postMessage,
  putJson,
  qaScripts,
  sourceIdOf,
  startAcceptance,
  withDatabase,
  type AcceptanceServer,
} from "./support.ts";

const SOURCE_PATH = "src/lmp/state/snapshot_cache.py";
const LINES = { start: 6, end: 20 };
const DESIGN_PATH = "docs/decisions/decision-log.md";
const SECOND_SOURCE = "schemas/ids.py";

let server: AcceptanceServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

interface PreferencesView {
  preferences: {
    explainLevel: string;
    background: string | null;
    language: string;
    version: number;
  };
  readingPositions: {
    generationId: string;
    lessonId: string;
    offset: number;
  }[];
}

interface TermListView {
  terms: {
    termId: string;
    zh: string;
    en: string;
    symbols: string[];
    links: {
      generationId: string;
      repoId: string;
      projectId: string;
      sourceId: string;
    }[];
  }[];
}

interface LessonDetail {
  lesson: {
    lessonId: string;
    context: { repoId: string; commitSha: string; generationId: string };
    evidence: string[];
  };
}

async function lessonOf(
  target: AcceptanceServer,
  generationId: string,
): Promise<LessonDetail> {
  const list = jsonOf<{ lessons: { lessonId: string }[] }>(
    await target.request(`/api/generations/${generationId}/lessons`),
    200,
  );
  return jsonOf<LessonDetail>(
    await target.request(
      `/api/generations/${generationId}/lessons/${list.lessons[0].lessonId}`,
    ),
    200,
  );
}

describe("AC-F08-01: preferences, term links and two-repository attribution", () => {
  test("preferences stay independent, term links are generation-owned and both repos are attributed", async () => {
    server = await startAcceptance();
    const first = await importLocal(server);
    server.writeScripts(
      generationScripts({
        sourcePath: SOURCE_PATH,
        lines: LINES,
        designPath: DESIGN_PATH,
        commitSha: server.commitSha,
      }),
    );
    const firstRun = await analyzeToCompletion(server, first.projectId);
    expect(firstRun.job.state).toBe("completed");

    // ── preferences and reading positions are separate stores ───────────────
    const written = jsonOf<PreferencesView>(
      await putJson(server, "/api/preferences", {
        explainLevel: "technical_first",
        background: "我有 Python 后端经验，希望看到数据结构层面的解释。",
      }),
      200,
    );
    expect(written.preferences.explainLevel).toBe("technical_first");
    expect(written.preferences.background).toContain("Python");
    expect(written.preferences.language).toBe("zh");
    expect(written.readingPositions).toEqual([]);
    const preferencesVersion = written.preferences.version;

    const firstLessonId = (
      await lessonOf(server, firstRun.analysis.generationId)
    ).lesson.lessonId;
    const positioned = jsonOf<PreferencesView>(
      await putJson(server, "/api/preferences", {
        readingPosition: {
          generationId: firstRun.analysis.generationId,
          lessonId: firstLessonId,
          offset: 42,
        },
      }),
      200,
    );
    expect(positioned.readingPositions).toHaveLength(1);
    expect(positioned.readingPositions[0]).toMatchObject({
      generationId: firstRun.analysis.generationId,
      lessonId: firstLessonId,
      offset: 42,
    });
    // A reading-position write never touches the preference row.
    expect(positioned.preferences.explainLevel).toBe("technical_first");
    expect(positioned.preferences.background).toBe(
      written.preferences.background,
    );
    expect(positioned.preferences.version).toBe(preferencesVersion);

    // The background survives a conversation turn and is not overwritten.
    const codeId = sourceIdOf(SOURCE_PATH, server.commitSha, LINES);
    server.writeScripts(qaScripts({ citations: [{ sourceId: codeId }] }));
    const conversation = jsonOf<{ conversationId: string }>(
      await postJson(server, "/api/conversations", {
        generationIds: [firstRun.analysis.generationId],
      }),
      201,
    );
    const events = await postMessage(server, conversation.conversationId, {
      text: "旧快照丢了为什么会这样",
    });
    expect(events.find((event) => event.type === "done")).toBeDefined();

    const afterChat = jsonOf<PreferencesView>(
      await server.request("/api/preferences"),
      200,
    );
    expect(afterChat.preferences.background).toBe(
      written.preferences.background,
    );
    expect(afterChat.preferences.explainLevel).toBe("technical_first");
    expect(afterChat.readingPositions).toHaveLength(1);

    // ── a term link points at the owning generation's source ───────────────
    const generation = firstRun.analysis.generationId;
    withDatabase(server.dataDir, (db) => {
      db.prepare(
        "INSERT INTO terms (term_id, zh, en, symbols_json) VALUES (?, ?, ?, ?)",
      ).run("t_snapshot", "淘汰", "evict", JSON.stringify(["evict"]));
      db.prepare(
        `INSERT INTO term_links (term_id, generation_id, source_id)
         VALUES (?, ?, ?)`,
      ).run("t_snapshot", generation, codeId);
    });

    const glossary = jsonOf<TermListView>(
      await server.request(`/api/terms?q=${encodeURIComponent("淘汰")}`),
      200,
    );
    expect(glossary.terms).toHaveLength(1);
    const term = glossary.terms[0];
    expect(term.zh).toBe("淘汰");
    expect(term.en).toBe("evict");
    expect(term.links).toHaveLength(1);
    expect(term.links[0].generationId).toBe(generation);
    expect(term.links[0].repoId).toBe(first.repoId);
    expect(term.links[0].projectId).toBe(first.projectId);
    expect(term.links[0].sourceId).toBe(codeId);
    // The link resolves through the generation that owns it, not a lookalike.
    const linkedSource = jsonOf<{ sourceId: string; commitSha: string }>(
      await server.request(
        `/api/generations/${term.links[0].generationId}/sources/${term.links[0].sourceId}`,
      ),
      200,
    );
    expect(linkedSource.sourceId).toBe(codeId);
    expect(linkedSource.commitSha).toBe(server.commitSha);

    // ── a two-repository comparison keeps each side on its own repo ────────
    const secondCommit = fixtureSha("numbering-schema");
    const second = await importLocal(server, fixturePath("numbering-schema"));
    server.writeScripts(
      generationScripts({
        sourcePath: SECOND_SOURCE,
        lines: null,
        commitSha: secondCommit,
      }),
    );
    const secondRun = await analyzeToCompletion(server, second.projectId);
    expect(secondRun.job.state).toBe("completed");
    expect(secondRun.analysis.generationId).not.toBe(generation);

    const firstLesson = await lessonOf(server, generation);
    const secondLesson = await lessonOf(
      server,
      secondRun.analysis.generationId,
    );
    expect(firstLesson.lesson.context.repoId).toBe(first.repoId);
    expect(secondLesson.lesson.context.repoId).toBe(second.repoId);
    expect(firstLesson.lesson.context.repoId).not.toBe(
      secondLesson.lesson.context.repoId,
    );

    // One two-generation conversation cites each side from its own generation.
    const secondSourceId = sourceIdOf(SECOND_SOURCE, secondCommit, null);
    server.writeScripts(
      qaScripts({
        citations: [
          { sourceId: codeId, generationId: generation },
          {
            sourceId: secondSourceId,
            generationId: secondRun.analysis.generationId,
          },
        ],
        answer:
          "项目如何使用：左侧仓库在淘汰时删除条目；右侧仓库在 schema 中校验编号格式。" +
          " 技术如何工作：两者都是通用机制。 外部背景：source_missing。",
      }),
    );
    const crossConversation = jsonOf<{ conversationId: string }>(
      await postJson(server, "/api/conversations", {
        generationIds: [generation, secondRun.analysis.generationId],
      }),
      201,
    );
    const crossEvents = await postMessage(
      server,
      crossConversation.conversationId,
      { text: "两个仓库在编号与快照处理上有什么不同" },
    );
    const citations = crossEvents.filter((event) => event.type === "citation");
    expect(citations).toHaveLength(2);
    const bySource = new Map(
      citations.map((citation) => [
        String(citation.sourceId),
        String(citation.commitSha),
      ]),
    );
    expect(bySource.get(codeId)).toBe(server.commitSha);
    expect(bySource.get(secondSourceId)).toBe(secondCommit);

    const stored = jsonOf<{
      messages: {
        role: string;
        citations: { sourceId: string; generationId: string }[];
      }[];
    }>(
      await server.request(
        `/api/conversations/${crossConversation.conversationId}`,
      ),
      200,
    );
    const answer = stored.messages.find(
      (message) => message.role === "assistant",
    );
    const owners = new Map(
      answer!.citations.map((citation) => [
        citation.sourceId,
        citation.generationId,
      ]),
    );
    expect(owners.get(codeId)).toBe(generation);
    expect(owners.get(secondSourceId)).toBe(secondRun.analysis.generationId);
  }, 240_000);
});
