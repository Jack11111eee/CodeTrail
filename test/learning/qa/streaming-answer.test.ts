import { afterEach, describe, expect, it } from "vitest";

import type {
  ConversationView,
  RetrievalHit,
  Retriever,
} from "../../../src/learning/contracts/index.ts";
import { repoSourceId } from "../../../src/learning/evidence/registry.ts";
import { hitSourceId } from "../../../src/learning/qa/multi-context.ts";
import { QA_TOOL_NAMES } from "../../../src/learning/qa/tools.ts";
import { startHarness } from "../helpers/http-client.ts";
import {
  answerEntry,
  cleanupTempDirs,
  collect,
  createHarness,
  eventsOfType,
  publishGeneration,
  sourceHit,
  scriptDir,
  toolEntry,
  COMMIT_A,
  REPO_ID,
} from "./qa-helpers.ts";
import {
  parseSseFrames,
  startConversationServer,
  type ConversationServer,
} from "./conversation-server.ts";

/**
 * AC-QA-03 / AC-QA-10 (stream half): a turn emits deltas and a terminal `done`,
 * `answerPhase` is `generating` while the text streams, and `status` only moves
 * to `complete` after the checks pass. Citations are persisted.
 */

afterEach(() => {
  cleanupTempDirs();
});

function setup() {
  const hit = sourceHit(
    "g_stream",
    REPO_ID,
    COMMIT_A,
    "src/index.ts",
    "the snapshot cache evicts entries when the budget is exceeded",
    { start: 1, end: 2 },
  );
  const sourceId = hitSourceId(hit);
  const files = {
    "src/index.ts": "export class SnapshotCache {\n  evict(): void {}\n}\n",
  };
  const calls: {
    tools: string[];
    inputTokens: number;
    outputTokens: number;
  }[] = [];
  const dir = scriptDir([
    answerEntry({
      answer: "旧快照会被淘汰，因为缓存超过了预算上限。",
      conclusion: "code_fact",
      citations: [{ sourceId }],
    }),
  ]);
  const harness = createHarness({
    modelDir: dir,
    onCall: (info) => {
      calls.push({
        tools: info.tools,
        inputTokens: info.inputTokens,
        outputTokens: info.outputTokens,
      });
    },
    hits: { g_stream: [hit] },
    filesByGeneration: { g_stream: files },
    generationOfCommit: { [COMMIT_A]: "g_stream" },
  });
  const fixture = publishGeneration(harness.db, {
    generationId: "g_stream",
    sources: [{ path: "src/index.ts" }],
    files,
  });
  return { harness, fixture, hit, sourceId, calls };
}

describe("streaming answer", () => {
  it("emits deltas, a citation and a terminal done, then persists complete", async () => {
    const { harness, fixture, sourceId, calls } = setup();
    try {
      const conversation = await harness.conversations.create({
        generationIds: [fixture.generationId],
      });
      const events = await collect(
        harness.answers.answer({
          conversationId: conversation.conversationId,
          text: "旧快照为什么会被淘汰？",
          selection: null,
          signal: new AbortController().signal,
        }),
      );

      const start = eventsOfType(events, "start")[0];
      expect(start).toBeDefined();
      const deltas = eventsOfType(events, "delta");
      expect(deltas.length).toBeGreaterThan(0);
      expect(deltas.map((event) => event.text).join("")).toContain(
        "旧快照会被淘汰",
      );
      const citations = eventsOfType(events, "citation");
      expect(citations[0]).toMatchObject({
        sourceId,
        commitSha: COMMIT_A,
      });
      expect(events.at(-1)).toMatchObject({
        type: "done",
        status: "complete",
        incomplete: false,
      });

      const stored = (await harness.conversations.get(
        conversation.conversationId,
      ))!.messages.find((message) => message.role === "assistant")!;
      expect(stored.status).toBe("complete");
      expect(stored.answerPhase).toBe("complete");
      expect(stored.citations).toHaveLength(1);
      expect(stored.citations[0]).toMatchObject({
        sourceId,
        generationId: fixture.generationId,
        commitSha: COMMIT_A,
      });
      expect(stored.checks).toEqual({
        structural: "pass",
        evidence: "pass",
        semantic: "pass",
      });

      // Exactly one retrieval search for the one bound generation, and the
      // model saw exactly the five read-only tool names.
      expect(harness.retriever.calls).toHaveLength(1);
      expect(calls[0].tools).toEqual([...QA_TOOL_NAMES]);
    } finally {
      harness.db.close();
    }
  });

  it("reports answerPhase=generating while the text is still streaming", async () => {
    const { harness, fixture } = setup();
    try {
      const conversation = await harness.conversations.create({
        generationIds: [fixture.generationId],
      });
      const seen: { status: string; answerPhase: string }[] = [];
      const stream = harness.answers.answer({
        conversationId: conversation.conversationId,
        text: "为什么？",
        selection: null,
        signal: new AbortController().signal,
      });
      for await (const event of stream) {
        if (event.type === "start") {
          const record = harness.db.repos.conversations
            .messages(conversation.conversationId)
            .find((message) => message.messageId === event.messageId);
          if (record !== undefined) {
            seen.push({
              status: record.status,
              answerPhase: record.answerPhase,
            });
          }
        }
        if (event.type === "delta") {
          const record = harness.db.repos.conversations
            .messages(conversation.conversationId)
            .find((message) => message.role === "assistant");
          if (record !== undefined) {
            seen.push({
              status: record.status,
              answerPhase: record.answerPhase,
            });
          }
        }
      }

      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]).toEqual({
        status: "streaming",
        answerPhase: "generating",
      });
      expect(seen.every((entry) => entry.answerPhase !== "complete")).toBe(
        true,
      );
    } finally {
      harness.db.close();
    }
  });

  it("accepts a citation for a file the answer read through a tool", async () => {
    const files = { "src/unregistered.ts": "export const value = 42;\n" };
    const sourceId = repoSourceId("src/unregistered.ts", COMMIT_A, null);
    const dir = scriptDir([
      toolEntry([
        { name: "read_snapshot_file", args: { path: "src/unregistered.ts" } },
      ]),
      answerEntry(
        {
          answer: "该文件导出了 value。",
          conclusion: "code_fact",
          citations: [{ sourceId }],
        },
        2,
      ),
    ]);
    const harness = createHarness({
      modelDir: dir,
      filesByGeneration: { g_tool_source: files },
      generationOfCommit: { [COMMIT_A]: "g_tool_source" },
    });
    const fixture = publishGeneration(harness.db, {
      generationId: "g_tool_source",
      files,
    });
    try {
      const conversation = await harness.conversations.create({
        generationIds: [fixture.generationId],
      });
      const events = await collect(
        harness.answers.answer({
          conversationId: conversation.conversationId,
          text: "value 是什么？",
          selection: null,
          signal: new AbortController().signal,
        }),
      );

      expect(events.at(-1)).toMatchObject({
        type: "done",
        status: "complete",
      });
      const assistant = (await harness.conversations.get(
        conversation.conversationId,
      ))!.messages.find((message) => message.role === "assistant")!;
      expect(assistant.status).toBe("complete");
      expect(assistant.citations).toHaveLength(1);
      expect(assistant.citations[0]).toMatchObject({
        sourceId,
        generationId: fixture.generationId,
        commitSha: COMMIT_A,
      });
    } finally {
      harness.db.close();
    }
  });
});

/**
 * AC-QA-03 over HTTP: `POST /api/conversations/:id/messages` streams named
 * `start`/`delta`/`done` frames, and a client disconnect aborts the request
 * signal so the message is persisted as `cancelled` (AC-QA-15).
 */

const HTTP_FILES = {
  "src/index.ts": "export class SnapshotCache {\n  evict(): void {}\n}\n",
};

let streamingServer: ConversationServer | null = null;

afterEach(async () => {
  await streamingServer?.close();
  streamingServer = null;
});

/** A retriever that waits for the test, so the disconnect lands mid-turn. */
function gatedRetriever(hit: RetrievalHit): {
  retriever: Retriever;
  release(): void;
} {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    retriever: {
      async search(binding) {
        await gate;
        return [{ ...hit, binding: { ...binding } }];
      },
    },
    release,
  };
}

function httpSourceHit(): {
  hit: RetrievalHit;
  sourceId: ReturnType<typeof repoSourceId>;
} {
  const hit = sourceHit(
    "g_http",
    REPO_ID,
    COMMIT_A,
    "src/index.ts",
    "the snapshot cache evicts entries when the budget is exceeded",
    { start: 1, end: 2 },
  );
  return {
    hit,
    sourceId: repoSourceId("src/index.ts", COMMIT_A, { start: 1, end: 2 }),
  };
}

async function readUntilFrame(
  response: Response,
  wanted: string,
): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) return buffered;
    buffered += decoder.decode(next.value, { stream: true });
    if (buffered.includes(`event: ${wanted}`)) return buffered;
  }
}

async function pollAssistantStatus(
  server: ConversationServer,
  conversationId: string,
  wanted: string,
  timeoutMs = 5_000,
): Promise<ConversationView> {
  const harness = await startHarness({ baseUrl: server.url });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await harness.request(
      `/api/conversations/${conversationId}`,
    );
    expect(response.status).toBe(200);
    const view = response.json as ConversationView;
    const assistant = view.messages.find(
      (message) => message.role === "assistant",
    );
    if (assistant?.status === wanted) return view;
    if (Date.now() > deadline) {
      throw new Error(
        `assistant never became ${wanted}: ${JSON.stringify(view.messages)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("conversation streaming over HTTP", () => {
  afterEach(() => {
    cleanupTempDirs();
  });

  it("returns delta frames and a terminal done, then serves the completed turn", async () => {
    const { hit, sourceId } = httpSourceHit();
    const dir = scriptDir([
      answerEntry({
        answer: "旧快照会被淘汰，因为缓存超过了预算上限。",
        conclusion: "code_fact",
        citations: [{ sourceId }],
      }),
    ]);
    const server = await startConversationServer({
      scriptDir: dir,
      hits: { g_http: [hit] },
      filesByGeneration: { g_http: HTTP_FILES },
      generationOfCommit: { [COMMIT_A]: "g_http" },
    });
    streamingServer = server;
    publishGeneration(
      { repos: server.repos },
      {
        generationId: "g_http",
        sources: [{ path: "src/index.ts", lines: { start: 1, end: 2 } }],
        files: HTTP_FILES,
      },
    );
    const harness = await startHarness({ baseUrl: server.url });

    const created = await harness.request("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generationIds: ["g_http"] }),
    });
    expect(created.status).toBe(201);
    const conversation = created.json as ConversationView;

    const streamed = await harness.request(
      `/api/conversations/${conversation.conversationId}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "旧快照为什么会被淘汰？" }),
      },
    );
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");

    const frames = parseSseFrames(streamed.text);
    const names = frames.map((frame) => frame.event);
    expect(names[0]).toBe("start");
    expect(names).toContain("delta");
    expect(names).not.toContain("error");
    // The answer's own terminal event…
    const answerDone = frames.find(
      (frame) =>
        frame.event === "done" &&
        (frame.json as { status?: string } | null)?.status === "complete",
    );
    expect(answerDone).toBeDefined();
    // …followed by `sendSse`'s terminator for the socket.
    expect(frames.at(-1)).toMatchObject({ event: "done", data: "{}" });

    const reloaded = await harness.request(
      `/api/conversations/${conversation.conversationId}`,
    );
    const view = reloaded.json as ConversationView;
    expect(view.messages).toHaveLength(2);
    const assistant = view.messages[1];
    expect(assistant).toMatchObject({
      role: "assistant",
      status: "complete",
      answerPhase: "complete",
      incomplete: false,
    });
    expect(assistant.citations[0]).toMatchObject({
      sourceId,
      generationId: "g_http",
      commitSha: COMMIT_A,
      availability: "available",
    });
  });

  it("persists a disconnected turn as cancelled and restores it after a restart", async () => {
    const { hit } = httpSourceHit();
    const gate = gatedRetriever(hit);
    const dir = scriptDir([
      answerEntry({
        answer: "不会被完整生成。",
        conclusion: "unknown",
        citations: [],
      }),
    ]);
    const server = await startConversationServer({
      scriptDir: dir,
      retriever: gate.retriever,
      filesByGeneration: { g_cancel_http: HTTP_FILES },
      generationOfCommit: { [COMMIT_A]: "g_cancel_http" },
    });
    streamingServer = server;
    publishGeneration(
      { repos: server.repos },
      {
        generationId: "g_cancel_http",
        sources: [{ path: "src/index.ts" }],
        files: HTTP_FILES,
      },
    );
    const harness = await startHarness({ baseUrl: server.url });
    const created = await harness.request("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generationIds: ["g_cancel_http"] }),
    });
    const conversation = created.json as ConversationView;

    const controller = new AbortController();
    const response = await fetch(
      `${server.url}/api/conversations/${conversation.conversationId}/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: `codetrail_session=${harness.sessionToken ?? ""}`,
        },
        body: JSON.stringify({ text: "解释一下" }),
        signal: controller.signal,
      },
    );
    expect(response.status).toBe(200);

    // The assistant row exists once `start` arrives; then the client leaves.
    const startFrames = await readUntilFrame(response, "start");
    expect(startFrames).toContain("event: start");
    controller.abort();
    // Let the server observe the socket close before the pending retrieval
    // resolves, so the generator's next checkpoint sees the abort.
    await new Promise((resolve) => setTimeout(resolve, 100));
    gate.release();

    const cancelled = await pollAssistantStatus(
      server,
      conversation.conversationId,
      "cancelled",
    );
    const assistant = cancelled.messages.find(
      (message) => message.role === "assistant",
    )!;
    expect(assistant).toMatchObject({
      status: "cancelled",
      answerPhase: "cancelled",
    });

    // Restart: a new server over the same data dir returns the same persisted
    // state (the boot sweep normalises any stream the disconnect left open).
    const dataDir = server.paths.root;
    await server.close();
    streamingServer = null;
    const restarted = await startConversationServer({
      dataDir,
      filesByGeneration: { g_cancel_http: HTTP_FILES },
      generationOfCommit: { [COMMIT_A]: "g_cancel_http" },
    });
    streamingServer = restarted;
    const restartedHarness = await startHarness({ baseUrl: restarted.url });
    const restored = await restartedHarness.request(
      `/api/conversations/${conversation.conversationId}`,
    );
    expect(restored.status).toBe(200);
    const restoredView = restored.json as ConversationView;
    const restoredAssistant = restoredView.messages.find(
      (message) => message.role === "assistant",
    )!;
    expect(restoredAssistant).toMatchObject({
      status: "cancelled",
      answerPhase: "cancelled",
    });
  });
});
