/**
 * AC-R16-02: a version switch opens a new conversation, a removed project's
 * old links answer `410 source_removed` without redirecting, and the history
 * of the old conversation stays readable with citations marked unavailable.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type {
  ConversationView,
  CreateAnalysisResponse,
  CreateProjectResponse,
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
import {
  startRoutesHarness,
  type RoutesHarness,
} from "../projects/routes-harness.ts";
import { errorCode, httpRequest, jsonBody } from "../helpers/stub-server.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const FIXTURE = "last-mile-mini";
const CACHE = "src/lmp/state/snapshot_cache.py";
const LINES = { start: 9, end: 9 };

const conversations: ConversationServer[] = [];
const routes: RoutesHarness[] = [];

beforeAll(() => {
  if (!existsSync(path.join(fixturesDir(), "manifest.json"))) {
    execFileSync(
      process.execPath,
      [path.join(REPO_ROOT, "scripts", "make-fixtures.mjs")],
      { cwd: REPO_ROOT, stdio: "ignore" },
    );
  }
  requireFixtures();
}, 180_000);

afterEach(async () => {
  for (const server of conversations.splice(0)) await server.close();
  for (const server of routes.splice(0)) await server.close();
  cleanupTempDirs();
});

function filesOf(): Record<string, string> {
  return {
    [CACHE]: readFileSync(path.join(fixturePath(FIXTURE), CACHE), "utf8"),
  };
}

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

describe("AC-R16-02 — switch and removed source", () => {
  it("switches to a new conversation and degrades the old citations after removal", async () => {
    const files = filesOf();
    const v1Source = repoSourceId(CACHE, COMMIT_A, LINES);
    const v2Source = repoSourceId(CACHE, COMMIT_B, LINES);
    const server = await startConversationServer({
      scriptDir: scriptDir([
        answerEntry(
          {
            answer: "v1 的快照会在重建时失效。",
            conclusion: "code_fact",
            citations: [{ sourceId: v1Source }],
          },
          1,
        ),
        answerEntry(
          {
            answer: "v2 的快照同样会在重建时失效。",
            conclusion: "code_fact",
            citations: [{ sourceId: v2Source }],
          },
          2,
        ),
      ]),
      hits: {
        g16_v1: [hitFor("g16_v1", COMMIT_A)],
        g16_v2: [hitFor("g16_v2", COMMIT_B)],
      },
      filesByGeneration: { g16_v1: files, g16_v2: files },
      generationOfCommit: { [COMMIT_A]: "g16_v1", [COMMIT_B]: "g16_v2" },
    });
    conversations.push(server);
    const harness = await startHarness({ baseUrl: server.url });

    publishGeneration(
      { repos: server.repos },
      {
        generationId: "g16_v1",
        repoId: "r_16_v1",
        projectId: "p_16_v1",
        commitSha: COMMIT_A,
        sources: [{ path: CACHE, lines: LINES }],
        lessons: [{ lessonId: "l16_v1", moduleIds: ["src"] }],
        files,
      },
    );
    publishGeneration(
      { repos: server.repos },
      {
        generationId: "g16_v2",
        repoId: "r_16_v2",
        projectId: "p_16_v2",
        commitSha: COMMIT_B,
        sources: [{ path: CACHE, lines: LINES }],
        lessons: [{ lessonId: "l16_v2", moduleIds: ["src"] }],
        files,
      },
    );

    const oldConversation = await create(harness, "g16_v1");
    await ask(harness, oldConversation.conversationId, "旧快照为什么会失效？");
    const before = await read(harness, oldConversation.conversationId);
    expect(
      before.messages.find((message) => message.role === "assistant")!
        .citations[0],
    ).toMatchObject({ sourceId: v1Source, availability: "available" });

    // Version switch: a new conversation, not a rebind of the old one.
    const newConversation = await create(harness, "g16_v2");
    expect(newConversation.conversationId).not.toBe(
      oldConversation.conversationId,
    );
    expect(newConversation.generationIds).toEqual(["g16_v2"]);
    await ask(harness, newConversation.conversationId, "v2 里呢？");

    // Remove the old project: history survives, availability degrades at read.
    await server.removal.remove("p_16_v1", true);
    const after = await read(harness, oldConversation.conversationId);
    expect(after.messages.map((message) => message.messageId)).toEqual(
      before.messages.map((message) => message.messageId),
    );
    expect(after.messages.map((message) => message.status)).toEqual(
      before.messages.map((message) => message.status),
    );
    expect(
      after.messages.find((message) => message.role === "assistant")!
        .citations[0],
    ).toMatchObject({
      sourceId: v1Source,
      availability: "source_removed",
    });

    // The other version is untouched and a new turn on the removed one is
    // refused rather than answered without evidence.
    const newRead = await read(harness, newConversation.conversationId);
    expect(
      newRead.messages.find((message) => message.role === "assistant")!
        .citations[0],
    ).toMatchObject({ sourceId: v2Source, availability: "available" });
    const refused = await harness.request(
      `/api/conversations/${encodeURIComponent(oldConversation.conversationId)}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "继续解释" }),
      },
    );
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({
      error: { details: { reason: "project_removed_read_only" } },
    });
  }, 120_000);

  it("returns 410 source_removed for every old generation link with no redirect", async () => {
    const server = await startRoutesHarness();
    routes.push(server);
    const cookie = { ...server.cookie };

    const created = jsonBody(
      await httpRequest(server.port, {
        method: "POST",
        path: "/api/projects",
        headers: { ...cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ localPath: fixturePath(FIXTURE) }),
      }),
    ) as CreateProjectResponse;
    const analysis = jsonBody(
      await httpRequest(server.port, {
        method: "POST",
        path: `/api/projects/${created.projectId}/analyses`,
        headers: { ...cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ ref: "HEAD" }),
      }),
    ) as CreateAnalysisResponse;
    await server.jobRunner.drain();

    const lesson = server.repos.lessons.listByGeneration(
      analysis.generationId,
    )[0];
    const source = server.repos.sources.all(analysis.generationId)[0];
    expect(lesson).toBeDefined();
    expect(source).toBeDefined();

    const removed = await httpRequest(server.port, {
      method: "DELETE",
      path: `/api/projects/${created.projectId}?confirm=true`,
      headers: cookie,
    });
    expect(removed.status).toBe(200);

    for (const oldLink of [
      `/api/generations/${analysis.generationId}/lessons`,
      `/api/generations/${analysis.generationId}/lessons/${lesson.lessonId}`,
      `/api/generations/${analysis.generationId}/sources/${source.sourceId}`,
      `/api/generations/${analysis.generationId}/coverage`,
    ]) {
      const response = await httpRequest(server.port, {
        path: oldLink,
        headers: cookie,
      });
      expect(response.status, oldLink).toBe(410);
      expect(errorCode(response), oldLink).toBe("source_removed");
      // No redirect to the newest generation.
      expect(response.headers.location, oldLink).toBeUndefined();
    }
  }, 120_000);
});

async function create(
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
