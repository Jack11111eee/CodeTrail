import { randomUUID } from "node:crypto";
import { LearningError } from "../../contracts/index.js";
import type {
  AppDeps,
  AnswerEvent,
  GenerationId,
  HandlerFactory,
  LearningTopic,
  LearningTopicView,
  RouteModule,
} from "../../contracts/index.js";
import { toMessageView, assertSelectionOwned } from "../../qa/conversations.js";
import {
  citationAvailability,
  requirePublishedGeneration,
} from "./generations.js";

export const topicsRoutes: RouteModule = {
  id: "topics",
  routes: [
    {
      method: "POST",
      pattern: "/api/generations/:id/topics",
      auth: "session",
      handler: "topics.create",
    },
    {
      method: "GET",
      pattern: "/api/topics/:id",
      auth: "session",
      handler: "topics.get",
    },
    {
      method: "POST",
      pattern: "/api/topics/:id/messages",
      auth: "session",
      handler: "topics.messages",
    },
    {
      method: "DELETE",
      pattern: "/api/topics/:id",
      auth: "session",
      handler: "topics.delete",
    },
    {
      method: "POST",
      pattern: "/api/topics/:id/restore",
      auth: "session",
      handler: "topics.restore",
    },
  ],
  handlers: {},
};

export function requireTopic(
  deps: AppDeps,
  id: string,
  includeDeleted = false,
): LearningTopic {
  const topic = deps.repos.topics.byId(id, { includeDeleted: true });
  if (!topic) throw new LearningError("not_found", "学习主题不存在");
  requirePublishedGeneration(deps, topic.generationId);
  if (topic.deletedAt && !includeDeleted)
    throw new LearningError(
      "source_removed",
      "学习主题已删除，可在目录中恢复",
      { reason: "topic_deleted" },
    );
  return topic;
}

export function toTopicView(
  deps: AppDeps,
  topic: LearningTopic,
): LearningTopicView {
  const message = topic.lessonMessageId
    ? deps.repos.conversations
        .messages(topic.conversationId)
        .find((row) => row.messageId === topic.lessonMessageId)
    : null;
  return {
    ...topic,
    displayTitle: topic.title || "未命名主题",
    lesson: message
      ? toMessageView(message, () =>
          citationAvailability(deps, topic.generationId),
        )
      : null,
  };
}

const create: HandlerFactory = (deps) => async (req) => {
  const generation = requirePublishedGeneration(
    deps,
    req.params.id as GenerationId,
  );
  const body = req.body as { title?: string };
  const title = body.title?.trim() || null;
  const conversation = await deps.conversations.create({
    generationIds: [generation.generationId],
  });
  const at = deps.clock.now().toISOString();
  const topic: LearningTopic = {
    topicId: `lt_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    generationId: generation.generationId,
    conversationId: conversation.conversationId,
    title,
    autoTitle: !title,
    firstQuestion: null,
    lessonMessageId: null,
    state: "draft",
    error: null,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
  deps.repos.topics.insert(topic);
  return { kind: "json", status: 201, body: toTopicView(deps, topic) };
};

const get: HandlerFactory = (deps) => (req) =>
  Promise.resolve({
    kind: "json",
    status: 200,
    body: toTopicView(deps, requireTopic(deps, req.params.id)),
  });

function fallbackTitle(question: string): string {
  return (
    question
      .trim()
      .replace(/^(?:请问|请帮我|帮我|请)\s*/u, "")
      .replace(/[？?。！!]+$/gu, "")
      .replace(/\s+/gu, " ")
      .slice(0, 24) || "项目学习主题"
  );
}

async function* topicAnswer(
  deps: AppDeps,
  topic: LearningTopic,
  text: string,
  selection: Parameters<AppDeps["answers"]["answer"]>[0]["selection"],
  signal: AbortSignal,
): AsyncGenerator<AnswerEvent> {
  let ended = false;
  let reason = "生成连接已中断，问题已保存，可重试";
  let title: string | undefined;
  try {
    for await (const event of deps.answers.answer({
      conversationId: topic.conversationId,
      text,
      selection,
      signal,
      topic: {
        title: topic.title,
        suggestTitle: topic.autoTitle && !topic.title,
        initial: !topic.lessonMessageId,
      },
    })) {
      if (event.type === "topic_title")
        title = event.title.trim().replace(/\s+/gu, " ").slice(0, 60);
      if (event.type === "error") reason = event.message.slice(0, 400);
      if (event.type === "done") {
        if (event.status === "failed" && event.unknownReason)
          reason =
            (
              {
                evidence_check_failed:
                  "回答中的引用未通过证据校验，问题和草稿已保存，可以重试",
                uncited_conclusion:
                  "回答缺少可验证的引用，问题和草稿已保存，可以重试",
                structural_check_failed:
                  "模型回答格式不完整，问题和草稿已保存，可以重试",
              } as Record<string, string>
            )[event.unknownReason] ?? reason;
        if (event.status === "failed")
          yield { type: "error", code: "conflict", message: reason };
        const message = deps.repos.conversations
          .messages(topic.conversationId)
          .find((row) => row.messageId === event.messageId);
        const complete =
          event.status === "complete" &&
          message?.status === "complete" &&
          message.content.trim();
        const lessonMessageId =
          topic.lessonMessageId ?? (complete ? event.messageId : null);
        deps.repos.topics.finish(topic.topicId, {
          state: lessonMessageId ? "ready" : "failed",
          error: complete
            ? null
            : signal.aborted
              ? "已停止生成，问题已保存，可重试"
              : reason,
          updatedAt: deps.clock.now().toISOString(),
          ...(lessonMessageId ? { lessonMessageId } : {}),
          ...(complete && topic.autoTitle && !topic.title
            ? { title: title || fallbackTitle(text) }
            : {}),
        });
        ended = true;
      }
      yield event;
    }
  } finally {
    if (!ended)
      deps.repos.topics.finish(topic.topicId, {
        state: topic.lessonMessageId ? "ready" : "failed",
        error: signal.aborted ? "已停止生成，问题已保存，可重试" : reason,
        updatedAt: deps.clock.now().toISOString(),
      });
  }
}

const post: HandlerFactory = (deps) => (req) => {
  const topic = requireTopic(deps, req.params.id);
  const body = req.body as {
    text: string;
    selection?: Parameters<AppDeps["answers"]["answer"]>[0]["selection"];
  };
  assertSelectionOwned(
    deps.repos,
    [topic.generationId],
    body.selection ?? null,
  );
  if (
    !deps.repos.topics.begin(
      topic.topicId,
      body.text,
      deps.clock.now().toISOString(),
    )
  )
    throw new LearningError(
      "conflict",
      "这个主题正在生成，请等待或停止当前回答",
    );
  return Promise.resolve({
    kind: "sse",
    events: topicAnswer(
      deps,
      topic,
      body.text,
      body.selection ?? null,
      req.signal,
    ),
  });
};

function visibility(deleted: boolean): HandlerFactory {
  return (deps) => (req) => {
    const topic = requireTopic(deps, req.params.id, true);
    if (topic.state === "generating")
      throw new LearningError("conflict", "请先停止当前生成，再管理这个主题");
    if (deleted && req.query.confirm !== "true")
      throw new LearningError("invalid_input", "请确认删除学习主题", {
        reason: "confirm_required",
      });
    deps.repos.topics.setDeleted(
      topic.topicId,
      deleted ? deps.clock.now().toISOString() : null,
    );
    return Promise.resolve({
      kind: "json",
      status: 200,
      body: {
        topicId: topic.topicId,
        generationId: topic.generationId,
        deleted,
      },
    });
  };
}

Object.assign(topicsRoutes.handlers, {
  "topics.create": create,
  "topics.get": get,
  "topics.messages": post,
  "topics.delete": visibility(true),
  "topics.restore": visibility(false),
});
