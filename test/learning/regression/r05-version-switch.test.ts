/**
 * AC-R05-01: a conversation is pinned to one commit. Answers in an old
 * version cite only that version, switching creates a new conversation, and a
 * source id from the other version can never appear in a citation list.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type {
  ConversationView,
  RetrievalHit,
} from "../../../src/learning/contracts/index.ts";
import { repoSourceId } from "../../../src/learning/evidence/registry.ts";
import { startHarness } from "../helpers/http-client.ts";
import type { Harness } from "../helpers/http-client.ts";
import {
  fixturePath,
  fixturesDir,
  requireFixtures,
} from "../helpers/git-fixture.ts";
import {
  answerEntry,
  cleanupTempDirs,
  publishGeneration,
  scriptDir,
  sourceHit,
  COMMIT_A,
  COMMIT_B,
} from "../qa/qa-helpers.ts";
import {
  parseSseFrames,
  startConversationServer,
  type ConversationServer,
} from "../qa/conversation-server.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const FIXTURE = "last-mile-mini";
const CACHE = "src/lmp/state/snapshot_cache.py";

const LINES = { start: 9, end: 9 };
const V1_SOURCE = repoSourceId(CACHE, COMMIT_A, LINES);
const V2_SOURCE = repoSourceId(CACHE, COMMIT_B, LINES);

let files: Record<string, string> = {};

beforeAll(() => {
  if (!existsSync(path.join(fixturesDir(), "manifest.json"))) {
    execFileSync(
      process.execPath,
      [path.join(REPO_ROOT, "scripts", "make-fixtures.mjs")],
      { cwd: REPO_ROOT, stdio: "ignore" },
    );
  }
  requireFixtures();
  files = {
    [CACHE]: readFileSync(path.join(fixturePath(FIXTURE), CACHE), "utf8"),
  };
}, 180_000);

const openServers: ConversationServer[] = [];

afterEach(async () => {
  await openServers.splice(0)[0]?.close();
  cleanupTempDirs();
});

function hitFor(generationId: string, commitSha: string): RetrievalHit {
  return sourceHit(
    generationId,
    "r_0123456789abcdef",
    commitSha,
    CACHE,
    "class SnapshotCache:",
    LINES,
  );
}

async function boot(): Promise<{
  server: ConversationServer;
  harness: Harness;
  searchBindings: string[];
}> {
  const searchBindings: string[] = [];
  const server = await startConversationServer({
    scriptDir: scriptDir([
      answerEntry(
        {
          answer: "v1：命名快照缓存在此刻如何淘汰。",
          conclusion: "code_fact",
          citations: [{ sourceId: V1_SOURCE }],
        },
        1,
      ),
      answerEntry(
        {
          answer: "v2：命名快照缓存在这一刻如何淘汰。",
          conclusion: "code_fact",
          citations: [{ sourceId: V2_SOURCE }],
        },
        2,
      ),
    ]),
    hits: {
      g_version_v1: [hitFor("g_version_v1", COMMIT_A)],
      g_version_v2: [hitFor("g_version_v2", COMMIT_B)],
    },
    onSearch: (binding) => {
      searchBindings.push(binding.generationId);
    },
    filesByGeneration: {
      g_version_v1: files,
      g_version_v2: files,
    },
    generationOfCommit: {
      [COMMIT_A]: "g_version_v1",
      [COMMIT_B]: "g_version_v2",
    },
  });
  openServers.push(server);
  const harness = await startHarness({ baseUrl: server.url });
  return { server, harness, searchBindings };
}

async function createConversation(
  harness: Harness,
  generationId: string,
): Promise<ConversationView> {
  const response = await harness.request("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ generationIds: [generationId] }),
  });
  expect(response.status).toBe(201);
  return response.json as ConversationView;
}

async function ask(
  harness: Harness,
  conversationId: string,
  text: string,
): Promise<void> {
  const response = await harness.request(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    },
  );
  expect(response.status).toBe(200);
  expect(
    parseSseFrames(response.text).some((frame) => frame.event === "done"),
  ).toBe(true);
}

async function read(
  harness: Harness,
  conversationId: string,
): Promise<ConversationView> {
  const response = await harness.request(
    `/api/conversations/${encodeURIComponent(conversationId)}`,
  );
  expect(response.status).toBe(200);
  return response.json as ConversationView;
}

describe("AC-R05-01 — version-pinned conversation", () => {
  it("keeps old answers on the old commit and opens a new conversation on switch", async () => {
    const { server, harness, searchBindings } = await boot();
    publishGeneration(
      { repos: server.repos },
      {
        generationId: "g_version_v1",
        commitSha: COMMIT_A,
        sources: [{ path: CACHE, lines: LINES }],
        lessons: [{ lessonId: "l_v1", moduleIds: ["src"] }],
        files,
      },
    );
    publishGeneration(
      { repos: server.repos },
      {
        generationId: "g_version_v2",
        commitSha: COMMIT_B,
        sources: [{ path: CACHE, lines: LINES }],
        lessons: [{ lessonId: "l_v2", moduleIds: ["src"] }],
        files,
      },
    );

    const oldConversation = await createConversation(harness, "g_version_v1");
    await ask(harness, oldConversation.conversationId, "旧快照丢了怎么办？");

    const oldRead = await read(harness, oldConversation.conversationId);
    expect(oldRead.generationIds).toEqual(["g_version_v1"]);
    const oldAnswer = oldRead.messages.find(
      (message) => message.role === "assistant",
    )!;
    expect(oldAnswer.citations.map((citation) => citation.sourceId)).toEqual([
      V1_SOURCE,
    ]);
    expect(oldAnswer.citations.map((citation) => citation.commitSha)).toEqual([
      COMMIT_A,
    ]);
    expect(
      oldAnswer.citations.map((citation) => citation.generationId),
    ).toEqual(["g_version_v1"]);
    expect(
      oldAnswer.citations.some((citation) => citation.sourceId === V2_SOURCE),
    ).toBe(false);

    // A version switch opens a new conversation; it never rebinds the old one.
    const newConversation = await createConversation(harness, "g_version_v2");
    expect(newConversation.conversationId).not.toBe(
      oldConversation.conversationId,
    );
    expect(newConversation.generationIds).toEqual(["g_version_v2"]);
    await ask(harness, newConversation.conversationId, "快照怎么淘汰？");

    const newRead = await read(harness, newConversation.conversationId);
    const newAnswer = newRead.messages.find(
      (message) => message.role === "assistant",
    )!;
    expect(newAnswer.citations.map((citation) => citation.sourceId)).toEqual([
      V2_SOURCE,
    ]);
    expect(newAnswer.citations.map((citation) => citation.commitSha)).toEqual([
      COMMIT_B,
    ]);
    expect(
      newAnswer.citations.some((citation) => citation.sourceId === V1_SOURCE),
    ).toBe(false);

    // The old conversation still reads exactly as before the switch.
    const oldAgain = await read(harness, oldConversation.conversationId);
    expect(oldAgain.generationIds).toEqual(["g_version_v1"]);
    expect(
      oldAgain.messages
        .find((message) => message.role === "assistant")!
        .citations.map((citation) => citation.commitSha),
    ).toEqual([COMMIT_A]);

    // Retrieval was always bound to the conversation's own generation.
    expect(searchBindings).toEqual(["g_version_v1", "g_version_v2"]);
  }, 120_000);
});
