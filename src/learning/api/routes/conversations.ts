/**
 * Conversation routes (architecture §11.4, §11.5, §14.1, §14.4, §5.8).
 *
 * This module is the **only** place a record-shaped service result becomes an
 * HTTP body. `ConversationService.create/get` return a `ConversationSnapshot`
 * whose `messages`/`selections` are rows; every response body here is produced
 * by `toConversationView` / `toMessageView` from `qa/conversations.ts`, so no
 * `MessageRecord` / `SelectionRecord` field name (`answer_phase`,
 * `citations_json`, …) can leak into the wire contract.
 *
 * `CitationView.availability` is resolved **per read** through the injected
 * `RemovalService.state()`: it is never stored and never cached across
 * requests, so removing a project later degrades its citations to
 * `"source_removed"` without rewriting a single row (§3.11 rule 4).
 *
 * The post route is a thin SSE seam: `deps.answers.answer({…, signal:
 * req.signal})` owns the turn, and `sendSse` aborts that signal when the
 * client disconnects, which leaves the message persisted as `cancelled`.
 */

import {
  assertProjectActive,
  LearningError,
  errorMessageFor,
} from "../../contracts/index.js";
import type {
  AppDeps,
  ConversationId,
  ConversationSnapshot,
  CreateConversationRequest,
  GenerationId,
  HandlerFactory,
  MessageListView,
  PostMessageRequest,
  RouteDef,
  RouteHandlerKey,
  RouteModule,
  SourceId,
  SourceStatus,
} from "../../contracts/index.js";
import {
  assertGenerationSet,
  assertSelectionOwned,
  toConversationView,
  toMessageView,
} from "../../qa/conversations.js";

export const routes: readonly RouteDef[] = [
  {
    method: "POST",
    pattern: "/api/conversations",
    auth: "session",
    handler: "conversations.create",
  },
  {
    method: "GET",
    pattern: "/api/conversations/:id",
    auth: "session",
    handler: "conversations.get",
  },
  {
    method: "GET",
    pattern: "/api/conversations/:id/messages",
    auth: "session",
    handler: "conversations.messages",
  },
  {
    method: "POST",
    pattern: "/api/conversations/:id/messages",
    auth: "session",
    handler: "conversations.post",
  },
];

// ── small guards ────────────────────────────────────────────────────────────

function invalid(
  message: string,
  details?: Record<string, unknown>,
): LearningError {
  return new LearningError("invalid_input", message, details);
}

function notFound(conversationId: ConversationId): LearningError {
  return new LearningError("not_found", errorMessageFor("not_found", "zh"), {
    conversationId,
  });
}

function conversationIdFrom(req: {
  params: Readonly<Record<string, string>>;
}): ConversationId {
  const id = req.params.id;
  if (id === undefined || id === "") {
    throw new LearningError("not_found", errorMessageFor("not_found", "zh"));
  }
  return id as ConversationId;
}

function requireObjectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw invalid(errorMessageFor("invalid_input", "zh"), { field: "body" });
  }
  return body as Record<string, unknown>;
}

/**
 * A project-scoped write must not bind a removed project. The row lookup comes
 * first so `unpublished_generation` (409) keeps precedence over the removal
 * check (410) for an id that never existed.
 */
function assertGenerationsActive(
  deps: AppDeps,
  generationIds: readonly GenerationId[],
): void {
  for (const generationId of generationIds) {
    const generation = deps.repos.generations.byId(generationId);
    if (generation === null || generation.projectId === null) continue;
    assertProjectActive(
      deps.removal.state(generation.projectId),
      generation.projectId,
    );
  }
}

/**
 * A removed project keeps its history readable (§5.8), but a new turn is
 * refused with `409 conflict`/`project_removed_read_only`: the retriever and
 * registry could only produce ungrounded text for it.
 */
function assertConversationWritable(
  deps: AppDeps,
  conversation: ConversationSnapshot,
): void {
  for (const generationId of conversation.generationIds) {
    const generation = deps.repos.generations.byId(generationId);
    if (generation === null || generation.projectId === null) continue;
    if (deps.removal.state(generation.projectId) === "removed") {
      throw new LearningError("conflict", "项目已被移除，无法继续追问", {
        reason: "project_removed_read_only",
        projectId: generation.projectId,
        generationId,
      });
    }
  }
}

// ── record → view plumbing (the single mapping site) ────────────────────────

function availabilityOfGeneration(
  deps: AppDeps,
  generationId: GenerationId,
): SourceStatus {
  const generation = deps.repos.generations.byId(generationId);
  if (generation === null) return "source_missing";
  if (generation.projectId === null) return "available";
  const state = deps.removal.state(generation.projectId);
  if (state === "removed") return "source_removed";
  if (state === "unknown") return "source_missing";
  return "available";
}

/**
 * Resolves a citation's `SourceStatus` at read time. The source row names the
 * generation that owns the citation; a knowledge-derived source (a wiki page)
 * has no row and belongs to the conversation's primary generation.
 */
function availabilityResolver(
  deps: AppDeps,
  generationIds: readonly GenerationId[],
): (sourceId: SourceId) => SourceStatus {
  const primary = generationIds[0] ?? null;
  return (sourceId: SourceId): SourceStatus => {
    for (const generationId of generationIds) {
      if (deps.repos.sources.get(generationId, sourceId) === null) continue;
      return availabilityOfGeneration(deps, generationId);
    }
    return primary === null
      ? "source_missing"
      : availabilityOfGeneration(deps, primary);
  };
}

function toView(deps: AppDeps, snapshot: ConversationSnapshot) {
  return toConversationView(
    snapshot,
    availabilityResolver(deps, snapshot.generationIds),
  );
}

async function requireConversation(
  deps: AppDeps,
  conversationId: ConversationId,
): Promise<ConversationSnapshot> {
  const snapshot = await deps.conversations.get(conversationId);
  if (snapshot === null) throw notFound(conversationId);
  return snapshot;
}

/** `limit` is a non-negative integer string (validate.ts); `1..` here. */
function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw invalid("limit 必须是正整数", { field: "limit" });
  }
  return parsed;
}

// ── handlers ────────────────────────────────────────────────────────────────

const createConversation: HandlerFactory = (deps) => async (req) => {
  const body = requireObjectBody(
    req.body,
  ) as unknown as CreateConversationRequest;
  // The request schema also enforces 1..2; `assertGenerationSet` is the
  // contract rule and keeps a direct handler call honest.
  assertGenerationSet(body.generationIds);
  assertGenerationsActive(deps, body.generationIds);

  const snapshot = await deps.conversations.create({
    generationIds: body.generationIds,
    ...(body.lessonId === undefined ? {} : { lessonId: body.lessonId }),
    ...(body.moduleId === undefined ? {} : { moduleId: body.moduleId }),
  });
  return { kind: "json", status: 201, body: toView(deps, snapshot) };
};

const getConversation: HandlerFactory = (deps) => async (req) => {
  const snapshot = await requireConversation(deps, conversationIdFrom(req));
  // History stays readable for a removed project; only the citations degrade.
  return { kind: "json", status: 200, body: toView(deps, snapshot) };
};

const listMessages: HandlerFactory = (deps) => async (req) => {
  const conversationId = conversationIdFrom(req);
  const snapshot = await requireConversation(deps, conversationId);
  const limit = parseLimit(req.query.limit);
  const before = req.query.before;

  // One extra row tells us whether an older page exists without a COUNT.
  const rows = deps.repos.conversations.messages(conversationId, {
    ...(limit === null ? {} : { limit: limit + 1 }),
    ...(before === undefined ? {} : { before }),
  });

  let page = rows;
  let nextBefore: string | null = null;
  if (limit !== null && rows.length > limit) {
    page = rows.slice(rows.length - limit);
    nextBefore = page[0]?.createdAt ?? null;
  }

  const availabilityOf = availabilityResolver(deps, snapshot.generationIds);
  const body: MessageListView = {
    messages: page.map((message) => toMessageView(message, availabilityOf)),
    nextBefore,
  };
  return { kind: "json", status: 200, body };
};

const postMessage: HandlerFactory = (deps) => async (req) => {
  const conversationId = conversationIdFrom(req);
  const snapshot = await requireConversation(deps, conversationId);
  assertConversationWritable(deps, snapshot);

  const body = requireObjectBody(req.body) as unknown as PostMessageRequest;
  if (typeof body.text !== "string" || body.text.trim() === "") {
    throw invalid("消息内容不能为空", { field: "text" });
  }
  const selection = body.selection ?? null;
  // The binding is immutable, so a selection naming another generation's
  // lesson/module/source is refused here (before the stream opens) with 409.
  assertSelectionOwned(deps.repos, snapshot.generationIds, selection);

  // The answer service owns the turn; the request signal is what turns a client
  // disconnect into `status:"cancelled"` (AC-QA-15). The client can name no
  // tool and cannot rebind: `PostMessageRequest` has no such field and the
  // request schema rejects unknown keys.
  return {
    kind: "sse",
    events: deps.answers.answer({
      conversationId,
      text: body.text,
      selection,
      signal: req.signal,
    }),
  };
};

export const handlers: Partial<Record<RouteHandlerKey, HandlerFactory>> = {
  "conversations.create": createConversation,
  "conversations.get": getConversation,
  "conversations.messages": listMessages,
  "conversations.post": postMessage,
};

export const conversationsModule: RouteModule = {
  id: "conversations",
  routes,
  handlers,
};

/** The name named by the issue contract; same `RouteModule` object. */
export const conversationsRoutes: RouteModule = conversationsModule;
