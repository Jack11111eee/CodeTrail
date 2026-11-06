import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConversationService } from "../../../src/learning/qa/conversations.ts";
import { topicsRoutes } from "../../../src/learning/api/routes/topics.ts";
import { conversationsRoutes } from "../../../src/learning/api/routes/conversations.ts";
import { createStaticUi } from "../../../src/learning/api/static.ts";
import {
  sourceIdOf,
  newMessageId,
} from "../../../src/learning/contracts/index.ts";
import type {
  AnswerRequest,
  CreateAnalysisResponse,
  CreateProjectResponse,
  LearningTopicView,
} from "../../../src/learning/contracts/index.ts";
import { fixturePath } from "../helpers/git-fixture.ts";
import { httpRequest, jsonBody } from "../helpers/stub-server.ts";
import {
  startRoutesHarness,
  type RoutesHarness,
} from "../projects/routes-harness.ts";
let h: RoutesHarness;
let generation: CreateAnalysisResponse["generationId"];
let calls: AnswerRequest[];
let fail = false;
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
const create = async (title?: string) =>
  jsonBody(
    await request(
      "POST",
      `/api/generations/${generation}/topics`,
      title === undefined ? {} : { title },
    ),
  ) as LearningTopicView;
const view = async (id: string) =>
  jsonBody(await request("GET", `/api/topics/${id}`)) as LearningTopicView;
beforeEach(async () => {
  h = await startRoutesHarness({
    extraModules: [topicsRoutes, conversationsRoutes],
  });
  h.deps.conversations = createConversationService({
    db: h.db,
    repos: h.repos,
    clock: h.clock,
  });
  calls = [];
  fail = false;
  h.deps.answers = {
    async *answer(req) {
      calls.push(req);
      await h.deps.conversations.appendUserMessage(
        req.conversationId,
        req.text,
        req.selection ?? null,
      );
      const messageId = newMessageId();
      h.repos.conversations.insertMessage({
        messageId,
        conversationId: req.conversationId,
        role: "assistant",
        content: fail ? "未完成" : `讲解：${req.text}`,
        status: fail ? "failed" : "complete",
        answerPhase: fail ? "failed" : "complete",
        citations: [],
        selection: null,
        checks: null,
        unknownReason: null,
        incomplete: fail,
        createdAt: h.clock.now().toISOString(),
      });
      if (fail)
        yield { type: "error", code: "model_error", message: "模型临时失败" };
      if (req.topic?.suggestTitle)
        yield { type: "topic_title", title: "风险评分请求流程" };
      yield {
        type: "done",
        messageId,
        status: fail ? "failed" : "complete",
        incomplete: fail,
      };
    },
  };
  const project = jsonBody(
    await request("POST", "/api/projects", {
      localPath: fixturePath("last-mile-mini"),
    }),
  ) as CreateProjectResponse;
  generation = (
    jsonBody(
      await request("POST", `/api/projects/${project.projectId}/analyses`, {
        ref: "HEAD",
      }),
    ) as CreateAnalysisResponse
  ).generationId;
  await h.jobRunner.drain();
});
afterEach(async () => {
  await h?.close();
});
describe("independent learning topics", () => {
  it("creates a durable untitled draft without a model call, names it on the first answer and preserves the article through follow-ups", async () => {
    const seal = h.repos.generations.byId(generation)!.sealedTreeHash;
    const wikiSource = sourceIdOf("repo", `wiki\0${generation}\0quickstart\0`);
    const wikiResponse = await request(
      "GET",
      `/api/generations/${generation}/sources/${wikiSource}`,
    );
    expect(wikiResponse.status).toBe(200);
    expect(jsonBody(wikiResponse)).toMatchObject({
      availability: "available",
      label: "openwiki/quickstart.md",
      content: "# Quickstart\n",
    });
    const a = await create();
    const b = await create("手动主题");
    expect(a).toMatchObject({
      title: null,
      displayTitle: "未命名主题",
      state: "draft",
      firstQuestion: null,
      lesson: null,
      autoTitle: true,
    });
    expect(calls).toHaveLength(0);
    expect(a.conversationId).not.toBe(b.conversationId);
    const initial = await request("POST", `/api/topics/${a.topicId}/messages`, {
      text: "风险评分如何流转？",
    });
    expect(initial.status).toBe(200);
    expect(initial.text).toContain('"status":"complete"');
    const ready = await view(a.topicId);
    expect(ready).toMatchObject({
      title: "风险评分请求流程",
      state: "ready",
      firstQuestion: "风险评分如何流转？",
      lesson: { content: "讲解：风险评分如何流转？" },
    });
    await request("POST", `/api/topics/${a.topicId}/messages`, {
      text: "失败时呢？",
    });
    expect((await view(a.topicId)).lessonMessageId).toBe(ready.lessonMessageId);
    expect((await view(a.topicId)).lesson?.content).toBe(ready.lesson?.content);
    expect((await view(a.topicId)).firstQuestion).toBe("风险评分如何流转？");
    expect(h.repos.conversations.messages(a.conversationId)).toHaveLength(4);
    expect(h.repos.conversations.messages(b.conversationId)).toHaveLength(0);
    expect(calls[0].topic).toEqual({
      initial: true,
      suggestTitle: true,
      title: null,
    });
    expect(calls[1].topic).toEqual({
      initial: false,
      suggestTitle: false,
      title: "风险评分请求流程",
    });
    await request("POST", `/api/topics/${b.topicId}/messages`, {
      text: "看看入口",
    });
    expect((await view(b.topicId)).title).toBe("手动主题");
    expect(calls.at(-1)?.topic?.suggestTitle).toBe(false);
    expect(h.repos.generations.byId(generation)?.sealedTreeHash).toBe(seal);
    // SSR must choose the topic's own conversation even if a foreign conversation query is supplied.
    const ui = createStaticUi(h.deps);
    const page = await ui.handle({
      method: "GET",
      path: "/learn/reader",
      params: { path: "/learn/reader" },
      query: { generation, topic: a.topicId, conversation: b.conversationId },
      headers: {},
      body: undefined,
      signal: new AbortController().signal,
    });
    expect(page?.kind).toBe("json");
    if (page?.kind === "json") {
      expect(String(page.body)).toContain(
        `data-conversation-id="${a.conversationId}"`,
      );
      expect(String(page.body)).not.toContain(
        `data-conversation-id="${b.conversationId}"`,
      );
    }
  });
  it("retains failed questions for retry, recovers interrupted state and preserves completed explanations on follow-up failure", async () => {
    const topic = await create("  ");
    fail = true;
    await request("POST", `/api/topics/${topic.topicId}/messages`, {
      text: "训练怎么做？",
    });
    expect(await view(topic.topicId)).toMatchObject({
      state: "failed",
      title: null,
      firstQuestion: "训练怎么做？",
      lesson: null,
      error: "模型临时失败",
    });
    fail = false;
    await request("POST", `/api/topics/${topic.topicId}/messages`, {
      text: "训练怎么做？",
    });
    const completed = await view(topic.topicId);
    fail = true;
    await request("POST", `/api/topics/${topic.topicId}/messages`, {
      text: "再解释一下",
    });
    expect(await view(topic.topicId)).toMatchObject({
      state: "ready",
      lessonMessageId: completed.lessonMessageId,
      error: "模型临时失败",
    });
    const fresh = await create();
    const at = h.clock.now().toISOString();
    expect(h.repos.topics.begin(fresh.topicId, "中断的问题", at)).toBe(true);
    expect(h.repos.topics.begin(fresh.topicId, "另一个问题", at)).toBe(false);
    expect(
      (
        await request("POST", `/api/topics/${fresh.topicId}/messages`, {
          text: "重复",
        })
      ).status,
    ).toBe(409);
    expect(
      (await request("DELETE", `/api/topics/${fresh.topicId}?confirm=true`))
        .status,
    ).toBe(409);
    h.repos.topics.begin(topic.topicId, "后续问题", at);
    h.repos.topics.recoverInterrupted(at);
    expect(await view(fresh.topicId)).toMatchObject({
      state: "failed",
      firstQuestion: "中断的问题",
    });
    expect(await view(topic.topicId)).toMatchObject({
      state: "ready",
      lessonMessageId: completed.lessonMessageId,
    });
  });
  it("requires deletion confirmation and authentication, restores all history and validates title/question input", async () => {
    const topic = await create();
    await request("POST", `/api/topics/${topic.topicId}/messages`, {
      text: "项目入口？",
    });
    const before = await view(topic.topicId);
    expect(
      (await request("DELETE", `/api/topics/${topic.topicId}`)).status,
    ).toBe(400);
    expect(
      (
        await httpRequest(h.port, {
          method: "GET",
          path: `/api/topics/${topic.topicId}`,
        })
      ).status,
    ).toBe(401);
    expect(
      (await request("DELETE", `/api/topics/${topic.topicId}?confirm=true`))
        .status,
    ).toBe(200);
    expect((await request("GET", `/api/topics/${topic.topicId}`)).status).toBe(
      410,
    );
    expect(h.repos.topics.listByGeneration(generation)).toHaveLength(0);
    expect(
      h.repos.topics.listByGeneration(generation, { includeDeleted: true }),
    ).toHaveLength(1);
    expect(
      (await request("POST", `/api/topics/${topic.topicId}/restore`, {}))
        .status,
    ).toBe(200);
    expect((await view(topic.topicId)).lessonMessageId).toBe(
      before.lessonMessageId,
    );
    expect(h.repos.conversations.messages(topic.conversationId)).toHaveLength(
      2,
    );
    expect(
      (
        await request("POST", `/api/generations/${generation}/topics`, {
          title: "x".repeat(81),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("POST", `/api/topics/${topic.topicId}/messages`, {
          text: " ",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("POST", `/api/topics/${topic.topicId}/messages`, {
          text: "越界？",
          selection: { sourceId: "repo:missing" },
        })
      ).status,
    ).toBe(409);
    expect((await request("GET", "/api/topics/lt_missing")).status).toBe(404);
  });
});
