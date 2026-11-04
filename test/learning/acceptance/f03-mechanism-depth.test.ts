/**
 * AC-F03-01 — a follow-up returns concrete file-and-line evidence and external
 * background marked with a retrieval version or `source_missing`, and it
 * separates "how the project uses it" from "how the technology works".
 *
 * The follow-up is a normal conversation turn through `POST …/messages`; the
 * answer may only cite a source registered for the pinned generation.
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
  messages: {
    role: string;
    content: string;
    citations: {
      sourceId: string;
      generationId: string;
      commitSha: string;
      label: string;
    }[];
    status: string;
  }[];
}

describe("AC-F03-01: follow-up evidence and external background", () => {
  test("a follow-up cites file and lines and marks missing background", async () => {
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

    const codeId = sourceIdOf(SOURCE_PATH, server.commitSha, LINES);
    server.writeScripts(
      qaScripts({
        citations: [{ sourceId: codeId }],
        toolCalls: [
          {
            name: "read_snapshot_file",
            args: { path: SOURCE_PATH, lines: LINES },
          },
        ],
      }),
    );

    const conversation = jsonOf<{ conversationId: string }>(
      await postJson(server, "/api/conversations", {
        generationIds: [analysis.generationId],
      }),
      201,
    );
    const events = await postMessage(server, conversation.conversationId, {
      text: "旧快照丢了为什么会这样",
    });

    const citations = events.filter((event) => event.type === "citation");
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      sourceId: codeId,
      commitSha: server.commitSha,
    });
    expect(String(citations[0].label)).toContain(`${SOURCE_PATH}:6-20`);
    const done = events.find((event) => event.type === "done" && event.status);
    expect(done).toMatchObject({ type: "done", status: "complete" });

    // The exact slice is what the learner can open.
    const source = jsonOf<{
      content: string;
      lines: { start: number; end: number };
      kind: string;
    }>(
      await server.request(
        `/api/generations/${analysis.generationId}/sources/${codeId}`,
      ),
      200,
    );
    expect(source.kind).toBe("repo");
    expect(source.lines).toEqual(LINES);
    expect(source.content).toContain("SnapshotCache");
    expect(source.content).not.toContain('"""Snapshot cache for the last-mile');

    const stored = jsonOf<ConversationView>(
      await server.request(`/api/conversations/${conversation.conversationId}`),
      200,
    );
    const answer = stored.messages.find(
      (message) => message.role === "assistant",
    );
    expect(answer?.status).toBe("complete");
    expect(answer?.content).toContain("项目如何使用");
    expect(answer?.content).toContain("技术如何工作");
    expect(answer?.content).toContain("source_missing");
    expect(answer?.citations[0]).toMatchObject({
      sourceId: codeId,
      generationId: analysis.generationId,
      commitSha: server.commitSha,
    });
  }, 240_000);
});
