/**
 * AC-F05-01 — three consecutive turns stay on one generation and survive a
 * restart; the refreshed conversation returns the same messages and selections.
 */

import { afterEach, describe, expect, test } from "vitest";

import {
  analyzeToCompletion,
  generationScripts,
  importLocal,
  jsonOf,
  postJson,
  postMessage,
  qaScripts,
  sourceIdOf,
  startAcceptance,
  type AcceptanceServer,
} from "./support.ts";

const SOURCE_PATH = "src/lmp/state/snapshot_cache.py";
const LINES = { start: 6, end: 20 };
const DESIGN_PATH = "docs/decisions/decision-log.md";

let server: AcceptanceServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
}, 240_000);

interface ConversationView {
  conversationId: string;
  generationIds: string[];
  messages: {
    messageId: string;
    role: string;
    content: string;
    citations: { generationId: string; commitSha: string }[];
    status: string;
  }[];
  selections: { moduleId: string | null }[];
}

describe("AC-F05-01: continuous Q&A survives refresh and restart", () => {
  test("three turns keep one generation and the conversation restores", async () => {
    server = await startAcceptance();
    server.writeScripts(
      generationScripts({
        sourcePath: SOURCE_PATH,
        lines: LINES,
        designPath: DESIGN_PATH,
        commitSha: server.commitSha,
      }),
    );
    const project = await importLocal(server);
    const { analysis, job } = await analyzeToCompletion(
      server,
      project.projectId,
    );
    expect(job.state).toBe("completed");

    const lessonList = jsonOf<{ lessons: { lessonId: string }[] }>(
      await server.request(`/api/generations/${analysis.generationId}/lessons`),
      200,
    );
    const detail = jsonOf<{ lesson: { context: { moduleIds: string[] } } }>(
      await server.request(
        `/api/generations/${analysis.generationId}/lessons/${lessonList.lessons[0].lessonId}`,
      ),
      200,
    );
    const moduleId = detail.lesson.context.moduleIds[0];

    const codeId = sourceIdOf(SOURCE_PATH, server.commitSha, LINES);
    server.writeScripts(qaScripts({ citations: [{ sourceId: codeId }] }));

    const conversation = jsonOf<{ conversationId: string }>(
      await postJson(server, "/api/conversations", {
        generationIds: [analysis.generationId],
      }),
      201,
    );
    const cid = conversation.conversationId;

    const questions = [
      "旧快照丢了为什么会这样",
      "淘汰之后如何重建",
      "这个机制还有哪些边界",
    ];
    for (const [index, question] of questions.entries()) {
      const events = await postMessage(server, cid, {
        text: question,
        ...(index === 0 ? { selection: { moduleId } } : {}),
      });
      const done = events.find(
        (event) => event.type === "done" && event.status,
      );
      expect(done).toMatchObject({ type: "done", status: "complete" });
    }

    const before = jsonOf<ConversationView>(
      await server.request(`/api/conversations/${cid}`),
      200,
    );
    expect(before.generationIds).toEqual([analysis.generationId]);
    expect(before.messages).toHaveLength(6);
    expect(before.selections).toHaveLength(1);
    expect(before.selections[0].moduleId).toBe(moduleId);
    for (const message of before.messages.filter(
      (entry) => entry.role === "assistant",
    )) {
      expect(message.status).toBe("complete");
      expect(message.citations[0].generationId).toBe(analysis.generationId);
      expect(message.citations[0].commitSha).toBe(server.commitSha);
    }

    // A real process restart on the same data directory.
    await server.restart();

    const after = jsonOf<ConversationView>(
      await server.request(`/api/conversations/${cid}`),
      200,
    );
    expect(after.generationIds).toEqual([analysis.generationId]);
    expect(after.messages.map((message) => message.messageId)).toEqual(
      before.messages.map((message) => message.messageId),
    );
    expect(after.messages.map((message) => message.content)).toEqual(
      before.messages.map((message) => message.content),
    );
    expect(after.selections).toEqual(before.selections);

    // The fourth turn still lands on the same pinned generation.
    await postMessage(server, cid, { text: "重启后继续追问" });
    const continued = jsonOf<ConversationView>(
      await server.request(`/api/conversations/${cid}`),
      200,
    );
    expect(continued.generationIds).toEqual([analysis.generationId]);
    expect(continued.messages).toHaveLength(8);
    const lastAnswer = [...continued.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    expect(lastAnswer?.citations[0].generationId).toBe(analysis.generationId);
  }, 240_000);
});
