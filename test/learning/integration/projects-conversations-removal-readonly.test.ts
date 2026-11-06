/**
 * Merge boundary: `projects` removal ◊ `generations` reads ◊ `conversations`
 * reads/writes (architecture §5.8, AC-PRJ-14, AC-R16-02).
 *
 * The route modules were built on separate branches. This suite registers all
 * of them on one real server and removes the project through the public
 * `DELETE /api/projects/:id?confirm=true` endpoint — not by calling the removal
 * service directly — then checks every dependent read path against the same
 * persisted state:
 *
 *   - history stays readable (200) and citations degrade to `source_removed`;
 *   - generation/lesson/source/coverage reads answer 410 `source_removed`
 *     with `details.reason = "project_removed"`, never a redirect;
 *   - a new turn is 409 `project_removed_read_only`;
 *   - a new conversation cannot bind the removed generation (410);
 *   - rows (generations, lessons, sources, change events) survive the delete.
 *
 * This is the conversation half of AC-PRJ-14 that the projects branch could not
 * exercise in isolation because the conversations module was absent.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ConversationView,
  DependentsView,
  ProjectDetail,
  ProjectListView,
} from "../../../src/learning/contracts/index.ts";
import { httpRequest, jsonBody, errorCode } from "../helpers/stub-server.ts";
import {
  seedConversationWithCitation,
  seedPublishedGeneration,
  startMergedServer,
  type MergedServer,
} from "./merged-learning-server.ts";

const PROJECT_ID = "p_removaltest00000000";
const REPO_ID = "r_removaltest00000000";
const GENERATION_ID = "g_removaltest00000000";
const COMMIT_SHA = "a".repeat(40);
const CHANGE_EVENT_ID = "e_removaltest00000000";

let server: MergedServer | undefined;

function reasonOf(response: { text: string }): unknown {
  const parsed = jsonBody(response as never) as {
    error?: { details?: { reason?: unknown } };
  };
  return parsed?.error?.details?.reason;
}

function get(path: string) {
  return httpRequest(server!.port, {
    path,
    headers: { ...server!.cookie },
  });
}

function post(path: string, body: unknown) {
  return httpRequest(server!.port, {
    method: "POST",
    path,
    headers: { ...server!.cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function del(path: string) {
  return httpRequest(server!.port, {
    method: "DELETE",
    path,
    headers: { ...server!.cookie },
  });
}

beforeEach(async () => {
  server = await startMergedServer();
  const at = server.clock.now().toISOString();

  server.repos.repos.upsert({
    repoId: REPO_ID as never,
    identity: "local:/tmp/removal-fixture",
    kind: "local",
    mirrorPath: "/tmp/removal-fixture.git",
    remoteUrl: null,
    createdAt: at,
  });
  server.repos.projects.insert({
    projectId: PROJECT_ID as never,
    repoId: REPO_ID as never,
    kind: "local",
    displayName: "removal-fixture",
    remoteUrl: null,
    defaultBranch: "main",
    scope: {
      include: ["**/*"],
      exclude: [],
      maxFiles: 1000,
      maxFileBytes: 5 * 1024 * 1024,
      hash: "scope:removal",
    },
    watchEnabled: false,
    createdAt: at,
    deletedAt: null,
  });

  // A change event from the updates branch makes the dependents projection
  // cross the third merged feature.
  server.repos.changes.insertMany([
    {
      eventId: CHANGE_EVENT_ID as never,
      eventKey: "event:removal-fixture",
      repoId: REPO_ID as never,
      projectId: PROJECT_ID as never,
      streamId: "default_branch:main",
      streamKind: "default_branch",
      kind: "commit",
      baseSha: "b".repeat(40),
      headSha: COMMIT_SHA,
      mergeBaseSha: "b".repeat(40),
      baseContextSha: "b".repeat(40),
      significance: "short",
      state: "published",
      jobId: null,
      gapReason: null,
      linkedEventId: null,
      linkRelation: null,
      discoveredAt: at,
      publishedAt: at,
      payload: {},
    },
  ]);
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("removing a project across the merged route modules", () => {
  it("keeps history readable but degrades citations and refuses new work", async () => {
    const seeded = await seedPublishedGeneration(server!, {
      generationId: GENERATION_ID,
      repoId: REPO_ID,
      projectId: PROJECT_ID,
      commitSha: COMMIT_SHA,
    });
    const conversation = await seedConversationWithCitation(server!, {
      generationId: GENERATION_ID,
      lessonId: seeded.lessonId,
      sourceId: seeded.sourceId,
      commitSha: COMMIT_SHA,
    });

    // ── before removal: everything resolves ────────────────────────────────
    const detail = await get(`/api/projects/${PROJECT_ID}`);
    expect(detail.status).toBe(200);
    const before = jsonBody(detail) as ProjectDetail;
    expect(before.projectId).toBe(PROJECT_ID);
    expect(before.analyzedCommitSha).toBe(COMMIT_SHA);
    expect(before.generationCount).toBe(1);
    expect(before.watchEnabled).toBe(false);

    const conversationBefore = await get(
      `/api/conversations/${conversation.conversationId}`,
    );
    expect(conversationBefore.status).toBe(200);
    const viewBefore = jsonBody(conversationBefore) as ConversationView;
    expect(viewBefore.generationIds).toEqual([GENERATION_ID]);
    expect(viewBefore.messages.at(-1)?.citations[0]).toMatchObject({
      sourceId: seeded.sourceId,
      availability: "available",
    });

    const dependentsBefore = await get(
      `/api/projects/${PROJECT_ID}/dependents`,
    );
    expect(dependentsBefore.status).toBe(200);
    const dependents = jsonBody(dependentsBefore) as DependentsView;
    expect(dependents.conversations.ids).toEqual([conversation.conversationId]);
    expect(dependents.lessons.ids).toEqual([seeded.lessonId]);
    expect(dependents.generations.ids).toEqual([GENERATION_ID]);
    expect(dependents.changeEvents.ids).toEqual([CHANGE_EVENT_ID]);
    for (const group of [
      dependents.conversations,
      dependents.lessons,
      dependents.generations,
      dependents.changeEvents,
    ]) {
      expect(group.count).toBe(group.ids.length);
    }

    // ── unconfirmed removal writes nothing ────────────────────────────────
    const refused = await del(`/api/projects/${PROJECT_ID}`);
    expect(refused.status).toBe(400);
    expect(errorCode(refused)).toBe("invalid_input");
    expect(reasonOf(refused)).toBe("confirm_required");
    expect((await get(`/api/projects/${PROJECT_ID}`)).status).toBe(200);

    // ── confirmed removal (the public projects endpoint) ──────────────────
    const removed = await del(`/api/projects/${PROJECT_ID}?confirm=true`);
    expect(removed.status).toBe(200);
    expect(jsonBody(removed)).toMatchObject({
      removed: true,
      dependents: { projectId: PROJECT_ID },
    });

    const list = jsonBody(await get("/api/projects")) as ProjectListView;
    expect(
      list.projects.some((project) => project.projectId === PROJECT_ID),
    ).toBe(false);

    // ── generation reads: 410, never a redirect ───────────────────────────
    for (const path of [
      `/api/generations/${GENERATION_ID}/lessons`,
      `/api/generations/${GENERATION_ID}/lessons/${seeded.lessonId}`,
      `/api/generations/${GENERATION_ID}/sources/${seeded.sourceId}`,
      `/api/generations/${GENERATION_ID}/coverage`,
    ]) {
      const response = await get(path);
      expect(response.status, `${path} must be 410 after removal`).toBe(410);
      expect(errorCode(response)).toBe("source_removed");
      expect(reasonOf(response)).toBe("project_removed");
      expect(response.headers.location).toBeUndefined();
    }

    // ── conversation reads: 200 with read-time availability ───────────────
    const conversationAfter = await get(
      `/api/conversations/${conversation.conversationId}`,
    );
    expect(conversationAfter.status).toBe(200);
    const viewAfter = jsonBody(conversationAfter) as ConversationView;
    expect(viewAfter.messages.map((message) => message.messageId)).toEqual(
      viewBefore.messages.map((message) => message.messageId),
    );
    expect(viewAfter.messages.at(-1)?.citations[0]).toMatchObject({
      sourceId: seeded.sourceId,
      availability: "source_removed",
    });

    // ── new work is refused with the documented reasons ───────────────────
    const messagesBefore = server!.repos.conversations.messages(
      conversation.conversationId as never,
    ).length;
    const newTurn = await post(
      `/api/conversations/${conversation.conversationId}/messages`,
      { text: "继续解释" },
    );
    expect(newTurn.status).toBe(409);
    expect(errorCode(newTurn)).toBe("conflict");
    expect(reasonOf(newTurn)).toBe("project_removed_read_only");
    expect(
      server!.repos.conversations.messages(
        conversation.conversationId as never,
      ).length,
    ).toBe(messagesBefore);

    const newConversation = await post("/api/conversations", {
      generationIds: [GENERATION_ID],
    });
    expect(newConversation.status).toBe(410);
    expect(errorCode(newConversation)).toBe("source_removed");
    expect(reasonOf(newConversation)).toBe("project_removed");

    // ── rows survive: nothing is silently deleted ─────────────────────────
    expect(
      server!.repos.generations.byId(GENERATION_ID as never),
    ).not.toBeNull();
    expect(
      server!.repos.lessons.byId(GENERATION_ID as never, seeded.lessonId),
    ).not.toBeNull();
    expect(
      server!.repos.sources.get(GENERATION_ID as never, seeded.sourceId as never),
    ).not.toBeNull();
    expect(server!.repos.changes.byId(CHANGE_EVENT_ID)).not.toBeNull();
  });
});
