import { afterEach, describe, expect, it } from "vitest";

import { repoSourceId } from "../../../src/learning/evidence/registry.ts";
import { hitSourceId } from "../../../src/learning/qa/multi-context.ts";
import type {
  ConversationView,
  MessageListView,
  RetrievalHit,
} from "../../../src/learning/contracts/index.ts";
import type { ScriptEntry } from "../../../src/learning/testing/scripted-model.ts";
import { startHarness } from "../helpers/http-client.ts";
import type { Harness } from "../helpers/http-client.ts";
import {
  answerEntry,
  cleanupTempDirs,
  publishGeneration,
  scriptDir,
  sourceHit,
  COMMIT_A,
  COMMIT_B,
  REPO_ID,
} from "./qa-helpers.ts";
import {
  collectKeys,
  parseSseFrames,
  startConversationServer,
  type ConversationServer,
} from "./conversation-server.ts";

/**
 * AC-QA-05 (HTTP half) and the removed-project matrix (§5.8):
 *
 * - switching module keeps the generation and appends a `SelectionView`;
 * - switching version creates a new conversation, the old one keeps its binding;
 * - 0 or 3 generation ids → 400; an unpublished id → 409;
 * - a removed project's conversation stays readable (200) with citations
 *   `"source_removed"`, while a new turn is 409 `project_removed_read_only` and
 *   a new conversation binding it is 410 `source_removed`;
 * - a selection outside the binding is 409 `version_mismatch`;
 * - no row field name ever reaches a body (the single mapping site).
 */

const FILES = {
  "src/index.ts": "export class SnapshotCache {\n  evict(): void {}\n}\n",
};

let open: ConversationServer | null = null;

afterEach(async () => {
  await open?.close();
  open = null;
  cleanupTempDirs();
});

async function boot(
  scripts: ScriptEntry[],
  hits?: Record<string, RetrievalHit[]>,
): Promise<{ server: ConversationServer; harness: Harness }> {
  const dir = scriptDir(scripts);
  const server = await startConversationServer({
    scriptDir: dir,
    hits: hits ?? {},
    filesByGeneration: { g_v1: FILES, g_v2: FILES, g_removed: FILES },
    generationOfCommit: { [COMMIT_A]: "g_v1", [COMMIT_B]: "g_v2" },
  });
  open = server;
  const harness = await startHarness({ baseUrl: server.url });
  return { server, harness };
}

async function postJson(
  harness: Harness,
  path: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await harness.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: response.json };
}

async function getConversation(
  harness: Harness,
  conversationId: string,
): Promise<ConversationView> {
  const response = await harness.request(
    `/api/conversations/${encodeURIComponent(conversationId)}`,
  );
  expect(response.status).toBe(200);
  return response.json as ConversationView;
}

describe("module and version switches", () => {
  it("appends a selection for a module switch without changing the conversation", async () => {
    const { server, harness } = await boot([
      answerEntry({
        answer: "旧快照会被淘汰。",
        conclusion: "unknown",
        citations: [],
      }),
    ]);
    const fixture = publishV1(server);

    const created = await postJson(harness, "/api/conversations", {
      generationIds: [fixture.generationId],
      moduleId: "m_snapshot",
    });
    expect(created.status).toBe(201);
    const conversation = created.json as ConversationView;
    expect(conversation.generationIds).toEqual(["g_v1"]);
    expect(conversation.selections).toHaveLength(1);

    const streamed = await harness.request(
      `/api/conversations/${encodeURIComponent(conversation.conversationId)}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "旧快照为什么会被淘汰？",
          selection: { moduleId: "m_snapshot" },
        }),
      },
    );
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");

    const after = await getConversation(harness, conversation.conversationId);
    expect(after.conversationId).toBe(conversation.conversationId);
    expect(after.generationIds).toEqual(["g_v1"]);
    expect(after.selections).toHaveLength(2);
    expect(after.selections.map((selection) => selection.moduleId)).toEqual([
      "m_snapshot",
      "m_snapshot",
    ]);
    // The turn appended a user and an assistant message to the same conversation.
    expect(after.messages).toHaveLength(2);
    expect(after.messages[0]).toMatchObject({
      role: "user",
      selection: { moduleId: "m_snapshot" },
    });
  });

  it("creates a new conversation for a version switch and keeps the old binding", async () => {
    const { server, harness } = await boot([]);
    const v1 = publishV1(server);
    const v2 = publishV2(server);

    const first = await postJson(harness, "/api/conversations", {
      generationIds: [v1.generationId],
    });
    expect(first.status).toBe(201);
    const oldConversation = first.json as ConversationView;

    const second = await postJson(harness, "/api/conversations", {
      generationIds: [v2.generationId],
    });
    expect(second.status).toBe(201);
    const newConversation = second.json as ConversationView;

    expect(newConversation.conversationId).not.toBe(
      oldConversation.conversationId,
    );
    expect(newConversation.generationIds).toEqual(["g_v2"]);

    const reread = await getConversation(
      harness,
      oldConversation.conversationId,
    );
    expect(reread.generationIds).toEqual(["g_v1"]);

    // A selection from the other version is refused before a stream opens.
    const mismatch = await postJson(
      harness,
      `/api/conversations/${encodeURIComponent(oldConversation.conversationId)}/messages`,
      { text: "解释一下", selection: { lessonId: "l_v2" } },
    );
    expect(mismatch.status).toBe(409);
    expect(mismatch.json).toMatchObject({
      error: { code: "version_mismatch" },
    });
  });

  it("refuses to rebind an existing conversation", async () => {
    const { server, harness } = await boot([]);
    const v1 = publishV1(server);
    const v2 = publishV2(server);
    const created = await postJson(harness, "/api/conversations", {
      generationIds: [v1.generationId],
    });
    const conversation = created.json as ConversationView;

    // `PostMessageRequest` has no generation field; the strict request schema
    // rejects the attempt, and the stored binding is untouched.
    const rebind = await postJson(
      harness,
      `/api/conversations/${encodeURIComponent(conversation.conversationId)}/messages`,
      { text: "换个版本", generationIds: [v2.generationId] },
    );
    expect(rebind.status).toBe(400);
    expect(rebind.json).toMatchObject({ error: { code: "invalid_input" } });

    const reread = await getConversation(harness, conversation.conversationId);
    expect(reread.generationIds).toEqual(["g_v1"]);
  });
});

describe("conversation creation and read errors", () => {
  it("rejects zero or three generation ids with 400", async () => {
    const { server, harness } = await boot([]);
    const v1 = publishV1(server);
    const v2 = publishV2(server);

    for (const generationIds of [
      [],
      [v1.generationId, v2.generationId, "g_extra"],
    ]) {
      const response = await postJson(harness, "/api/conversations", {
        generationIds,
      });
      expect(response.status).toBe(400);
      expect(response.json).toMatchObject({ error: { code: "invalid_input" } });
    }
  });

  it("rejects an unpublished generation with 409 and an unknown conversation with 404", async () => {
    const { server, harness } = await boot([]);
    // A staged generation has no seal, so it cannot be bound.
    const staged = publishGenerationStaged(server);

    const unpublished = await postJson(harness, "/api/conversations", {
      generationIds: [staged],
    });
    expect(unpublished.status).toBe(409);
    expect(unpublished.json).toMatchObject({
      error: { code: "unpublished_generation" },
    });

    const missing = await harness.request("/api/conversations/c_unknown");
    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("a removed project's conversation", () => {
  it("stays readable with source_removed citations, refuses new turns and new bindings", async () => {
    const hit = sourceHit(
      "g_removed",
      REPO_ID,
      COMMIT_A,
      "src/index.ts",
      "the snapshot cache evicts entries",
      { start: 1, end: 2 },
    );
    const citationSource = repoSourceId("src/index.ts", COMMIT_A, {
      start: 1,
      end: 2,
    });
    expect(hitSourceId(hit)).toBe(citationSource);

    const { server, harness } = await boot(
      [
        answerEntry(
          {
            answer: "旧快照会被淘汰。",
            conclusion: "code_fact",
            citations: [{ sourceId: citationSource }],
          },
          1,
        ),
      ],
      { g_removed: [hit] },
    );
    const removed = publishRemoved(server);

    const created = await postJson(harness, "/api/conversations", {
      generationIds: [removed.generationId],
    });
    expect(created.status).toBe(201);
    const conversation = created.json as ConversationView;

    const streamed = await harness.request(
      `/api/conversations/${encodeURIComponent(conversation.conversationId)}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "旧快照为什么会被淘汰？" }),
      },
    );
    expect(streamed.status).toBe(200);
    const frames = parseSseFrames(streamed.text);
    expect(frames.some((frame) => frame.event === "delta")).toBe(true);

    const beforeRemoval = await getConversation(
      harness,
      conversation.conversationId,
    );
    expect(beforeRemoval.messages.at(-1)?.citations[0]).toMatchObject({
      availability: "available",
    });

    await server.removal.remove(removed.projectId, true);

    // History survives; only availability degrades at read time.
    const afterRemoval = await getConversation(
      harness,
      conversation.conversationId,
    );
    expect(afterRemoval.messages.map((message) => message.messageId)).toEqual(
      beforeRemoval.messages.map((message) => message.messageId),
    );
    expect(afterRemoval.messages.map((message) => message.status)).toEqual(
      beforeRemoval.messages.map((message) => message.status),
    );
    expect(afterRemoval.messages.at(-1)?.citations[0]).toMatchObject({
      sourceId: citationSource,
      availability: "source_removed",
    });

    // A new turn is refused honestly, and a new conversation cannot bind it.
    const newTurn = await postJson(
      harness,
      `/api/conversations/${encodeURIComponent(conversation.conversationId)}/messages`,
      { text: "继续解释" },
    );
    expect(newTurn.status).toBe(409);
    expect(newTurn.json).toMatchObject({
      error: {
        code: "conflict",
        details: { reason: "project_removed_read_only" },
      },
    });

    const newConversation = await postJson(harness, "/api/conversations", {
      generationIds: [removed.generationId],
    });
    expect(newConversation.status).toBe(410);
    expect(newConversation.json).toMatchObject({
      error: {
        code: "source_removed",
        details: { reason: "project_removed" },
      },
    });
  });
});

describe("the record → view boundary", () => {
  it("emits only DTO field names and resolves availability per citation", async () => {
    const { server, harness } = await boot([
      answerEntry(
        {
          answer: "旧快照会被淘汰。",
          conclusion: "unknown",
          citations: [],
        },
        1,
      ),
    ]);
    const v1 = publishV1(server);
    const created = await postJson(harness, "/api/conversations", {
      generationIds: [v1.generationId],
      moduleId: "m_snapshot",
    });
    const conversation = created.json as ConversationView;

    const body = (
      await harness.request(
        `/api/conversations/${encodeURIComponent(conversation.conversationId)}`,
      )
    ).json;

    expect(Object.keys(body as object).sort()).toEqual([
      "conversationId",
      "createdAt",
      "generationIds",
      "lastActiveAt",
      "messages",
      "readingPosition",
      "selections",
    ]);

    const keys = collectKeys(body);
    for (const banned of [
      "answer_phase",
      "citations_json",
      "generation_ids_json",
      "selection_json",
      "check_json",
      "unknown_reason",
      "created_at",
      "message_id",
      "conversation_id",
      "id",
    ]) {
      expect(keys, `row field leaked: ${banned}`).not.toContain(banned);
    }

    const messageList = await harness.request(
      `/api/conversations/${encodeURIComponent(conversation.conversationId)}/messages`,
    );
    expect(messageList.status).toBe(200);
    const list = messageList.json as MessageListView;
    expect(Object.keys(list).sort()).toEqual(["messages", "nextBefore"]);
    expect(list.messages).toEqual((body as ConversationView).messages);
    expect(list.nextBefore).toBeNull();
  });
});

// ── fixtures ────────────────────────────────────────────────────────────────

function publishV1(server: ConversationServer) {
  return publishGeneration(
    { repos: server.repos },
    {
      generationId: "g_v1",
      sources: [{ path: "src/index.ts" }],
      lessons: [{ lessonId: "l_v1", moduleIds: ["m_snapshot"] }],
      files: FILES,
    },
  );
}

function publishV2(server: ConversationServer) {
  return publishGeneration(
    { repos: server.repos },
    {
      generationId: "g_v2",
      commitSha: COMMIT_B,
      lessons: [{ lessonId: "l_v2", moduleIds: ["m_snapshot"] }],
      files: FILES,
    },
  );
}

function publishRemoved(server: ConversationServer) {
  return publishGeneration(
    { repos: server.repos },
    {
      generationId: "g_removed",
      repoId: "r_removed",
      projectId: "p_removed",
      sources: [{ path: "src/index.ts", lines: { start: 1, end: 2 } }],
      lessons: [{ lessonId: "l_removed", moduleIds: ["m_snapshot"] }],
      files: FILES,
    },
  );
}

function publishGenerationStaged(server: ConversationServer): string {
  const fixture = publishGeneration(
    { repos: server.repos },
    {
      generationId: "g_staged",
      repoId: "r_staged",
      projectId: "p_staged",
      status: "staged",
      sealedTreeHash: null,
    },
  );
  return fixture.generationId;
}
