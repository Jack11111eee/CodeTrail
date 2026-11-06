import { createConversationService } from "../../../src/learning/qa/conversations.ts";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CreateAnalysisResponse,
  CreateProjectResponse,
  LessonListView,
} from "../../../src/learning/contracts/index.ts";
import { fixturePath } from "../helpers/git-fixture.ts";
import { httpRequest, jsonBody } from "../helpers/stub-server.ts";
import {
  startRoutesHarness,
  type RoutesHarness,
} from "../projects/routes-harness.ts";

let h: RoutesHarness;
let generation: CreateAnalysisResponse["generationId"];
let lessonId: LessonListView["lessons"][number]["lessonId"];
const request = (
  method: "GET" | "POST" | "DELETE",
  route: string,
  body?: unknown,
) =>
  httpRequest(h.port, {
    method,
    path: route,
    headers: {
      ...h.cookie,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const lessonUrl = () => `/api/generations/${generation}/lessons/${lessonId}`;

beforeEach(async () => {
  h = await startRoutesHarness();
  const imported = await request("POST", "/api/projects", {
    localPath: fixturePath("last-mile-mini"),
  });
  const project = jsonBody(imported) as CreateProjectResponse;
  const response = await request(
    "POST",
    `/api/projects/${project.projectId}/analyses`,
    { ref: "HEAD" },
  );
  generation = (jsonBody(response) as CreateAnalysisResponse).generationId;
  await h.jobRunner.drain();
  const list = jsonBody(
    await request("GET", `/api/generations/${generation}/lessons`),
  ) as LessonListView;
  lessonId = list.lessons[0].lessonId;
});
afterEach(async () => {
  await h?.close();
});

describe("lesson deletion and restoration", () => {
  it("requires confirmation; deletion persists, clears reading position and preserves sealed content, sources and conversations", async () => {
    const row = h.repos.lessons.byId(generation, lessonId)!;
    const record = h.repos.generations.byId(generation)!;
    const file = path.join(h.paths.knowledge, generation, row.relPath);
    const before = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
    const conversations = createConversationService({
      db: h.db,
      repos: h.repos,
      clock: h.clock,
    });
    const conversation = await conversations.create({
      generationIds: [generation],
      lessonId,
    });
    h.repos.prefs.putReadingPosition({
      generationId: generation,
      lessonId,
      conversationId: conversation.conversationId,
      offset: 100,
      updatedAt: h.clock.now().toISOString(),
    });
    const sourceCount = h.repos.sources.all(generation).length;
    expect((await request("DELETE", lessonUrl())).status).toBe(400);
    expect(h.repos.lessons.byId(generation, lessonId)).not.toBeNull();
    expect(
      (await request("DELETE", `${lessonUrl()}?confirm=true`)).status,
    ).toBe(200);
    expect(h.repos.lessons.byId(generation, lessonId)).toBeNull();
    expect(
      h.repos.lessons.byId(generation, lessonId, { includeDeleted: true })
        ?.deletedAt,
    ).toBeTruthy();
    expect(
      (
        jsonBody(
          await request("GET", `/api/generations/${generation}/lessons`),
        ) as LessonListView
      ).lessons,
    ).toHaveLength(0);
    expect((await request("GET", lessonUrl())).status).toBe(410);
    expect(h.repos.prefs.readingPositions()).toHaveLength(0);
    expect(h.repos.sources.all(generation)).toHaveLength(sourceCount);
    expect(await conversations.get(conversation.conversationId)).not.toBeNull();
    expect(
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
    ).toBe(before);
    expect(h.repos.generations.byId(generation)?.sealedTreeHash).toBe(
      record.sealedTreeHash,
    );
    // Retry is idempotent and restoration makes the same immutable lesson readable.
    expect(
      (await request("DELETE", `${lessonUrl()}?confirm=true`)).status,
    ).toBe(200);
    expect((await request("POST", `${lessonUrl()}/restore`, {})).status).toBe(
      200,
    );
    expect((await request("GET", lessonUrl())).status).toBe(200);
    expect(h.repos.lessons.listByGeneration(generation)).toHaveLength(1);
  });

  it("rejects unauthenticated, unknown and mismatched generation requests", async () => {
    expect(
      (
        await httpRequest(h.port, {
          method: "DELETE",
          path: `${lessonUrl()}?confirm=true`,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(
          "DELETE",
          `/api/generations/${generation}/lessons/l_missing?confirm=true`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          "DELETE",
          `/api/generations/g_missing/lessons/${lessonId}?confirm=true`,
        )
      ).status,
    ).toBe(404);
    expect(h.repos.lessons.byId(generation, lessonId)).not.toBeNull();
  });
});
