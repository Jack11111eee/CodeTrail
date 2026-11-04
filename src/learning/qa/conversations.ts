/**
 * Conversations bound to one or two published generations (architecture §11.4).
 *
 * `ConversationSnapshot` is the internal, record-shaped read model. It never
 * reaches an HTTP response: `toConversationView` is the single mapping into the
 * `ConversationView` DTO, and `toMessageView` is the single message mapping.
 *
 * The binding is immutable. Creation accepts exactly one or two published
 * generation ids; a later request that names a different generation is a
 * `conflict` with `details.reason = "generation_immutable"`, and a selection
 * that references an id outside the binding is a `version_mismatch`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { LearningError, newConversationId, newMessageId } from "../contracts/index.js";
import type {
  AnswerPhase,
  Clock,
  ConversationId,
  ConversationService,
  ConversationSnapshot,
  ConversationView,
  Database,
  GenerationId,
  LessonId,
  MessageId,
  Citation,
  LessonChecks,
  MessageRecord,
  MessageView,
  QaSelection,
  Repositories,
  SelectionRecord,
  SelectionView,
  SourceId,
  SourceStatus,
} from "../contracts/index.js";
import { normalizeScope } from "../projects/scope.js";
import { assertReadable } from "../projects/scope.js";

export type {
  ConversationService,
  ConversationSnapshot,
} from "../contracts/index.js";

function invalid(message: string, details?: Record<string, unknown>): LearningError {
  return new LearningError("invalid_input", message, details);
}

function unpublished(generationId: GenerationId, status: string | null): LearningError {
  return new LearningError("unpublished_generation", "该生成版本尚未发布", {
    generationId,
    status,
  });
}

/** Exactly 1 or 2 distinct generation ids, else `invalid_input` (AC-QA-01). */
export function assertGenerationSet(gens: GenerationId[]): void {
  if (!Array.isArray(gens)) {
    throw invalid("generationIds 必须是数组", { field: "generationIds" });
  }
  if (gens.length !== 1 && gens.length !== 2) {
    throw invalid("会话必须绑定 1 或 2 个生成版本", {
      field: "generationIds",
      count: gens.length,
    });
  }
  const seen = new Set<string>();
  for (const generationId of gens) {
    if (typeof generationId !== "string" || generationId.trim() === "") {
      throw invalid("生成版本 id 无效", { field: "generationIds" });
    }
    if (seen.has(generationId)) {
      throw invalid("生成版本 id 不能重复", { generationId });
    }
    seen.add(generationId);
  }
}

/** A turn may only use a generation the conversation is already pinned to. */
export function assertVersionPinned(
  conversation: ConversationSnapshot,
  generationId: GenerationId,
): void {
  if (!conversation.generationIds.includes(generationId)) {
    throw new LearningError("conflict", "会话绑定的生成版本不可更改", {
      reason: "generation_immutable",
      generationId,
      bound: [...conversation.generationIds],
    });
  }
}

function requirePublished(
  repos: Repositories,
  generationId: GenerationId,
): void {
  const record = repos.generations.byId(generationId);
  if (record === null) throw unpublished(generationId, null);
  if (record.status !== "published" || record.sealedTreeHash === null) {
    throw unpublished(generationId, record.status);
  }
}

function moduleIdsOf(repos: Repositories, generationId: GenerationId): Set<string> {
  const ids = new Set<string>();
  const generation = repos.generations.byId(generationId);
  if (generation === null) return ids;
  for (const lesson of repos.lessons.listByGeneration(generationId)) {
    const base = lesson.relPath
      .replace(/^.*\//u, "")
      .replace(/\.json$/u, "");
    ids.add(base);
    ids.add(lesson.lessonId);
    try {
      const raw = readFileSync(
        path.join(generation.contentDir, lesson.relPath),
        "utf8",
      );
      const parsed = JSON.parse(raw) as {
        context?: { moduleIds?: unknown };
      };
      const moduleIds = parsed.context?.moduleIds;
      if (Array.isArray(moduleIds)) {
        for (const moduleId of moduleIds) {
          if (typeof moduleId === "string") ids.add(moduleId);
        }
      }
    } catch {
      // A missing/unreadable lesson file contributes only its row identity.
    }
  }
  return ids;
}

function codeLocationOwned(
  repos: Repositories,
  generationIds: readonly GenerationId[],
  location: { path: string; lines: { start: number; end: number } },
): boolean {
  if (
    !Number.isInteger(location.lines.start) ||
    !Number.isInteger(location.lines.end) ||
    location.lines.start < 1 ||
    location.lines.end < location.lines.start
  ) {
    return false;
  }
  for (const generationId of generationIds) {
    const generation = repos.generations.byId(generationId);
    if (generation === null) continue;
    const project =
      generation.projectId === null
        ? null
        : repos.projects.byId(generation.projectId);
    const scope = project?.scope ?? normalizeScope();
    try {
      assertReadable(location.path, scope);
      return true;
    } catch {
      // Try the next generation's scope.
    }
  }
  return false;
}

/**
 * Server-side ownership check for every identifier a selection carries
 * (AC-QA-02). An id outside the binding is a `version_mismatch`.
 */
export function assertSelectionOwned(
  repos: Repositories,
  generationIds: readonly GenerationId[],
  selection: QaSelection | null | undefined,
): void {
  if (selection === null || selection === undefined) return;
  const keys = Object.keys(selection).filter((key) => {
    const value = (selection as Record<string, unknown>)[key];
    return value !== undefined && value !== null;
  });
  if (keys.length === 0) {
    throw invalid("选择不能为空", { field: "selection" });
  }

  if (selection.lessonId !== undefined) {
    const owned = generationIds.some(
      (generationId) =>
        repos.lessons.byId(generationId, selection.lessonId as LessonId) !== null,
    );
    if (!owned) {
      throw new LearningError("version_mismatch", "课节不属于该生成版本", {
        lessonId: selection.lessonId,
        generationIds: [...generationIds],
      });
    }
  }

  if (selection.moduleId !== undefined) {
    const owned = generationIds.some((generationId) =>
      moduleIdsOf(repos, generationId).has(selection.moduleId as string),
    );
    if (!owned) {
      throw new LearningError("version_mismatch", "模块不属于该生成版本", {
        moduleId: selection.moduleId,
        generationIds: [...generationIds],
      });
    }
  }

  if (selection.sourceId !== undefined) {
    const owned = generationIds.some(
      (generationId) =>
        repos.sources.get(generationId, selection.sourceId as SourceId) !== null,
    );
    if (!owned) {
      throw new LearningError("version_mismatch", "来源不属于该生成版本", {
        sourceId: selection.sourceId,
        generationIds: [...generationIds],
      });
    }
  }

  if (selection.codeLocation !== undefined) {
    if (!codeLocationOwned(repos, generationIds, selection.codeLocation)) {
      throw new LearningError("version_mismatch", "代码位置不属于该生成版本", {
        path: selection.codeLocation.path,
        generationIds: [...generationIds],
      });
    }
  }
}

function readingPositionFor(
  repos: Repositories,
  conversationId: ConversationId,
) {
  return (
    repos.prefs
      .readingPositions()
      .find((position) => position.conversationId === conversationId) ?? null
  );
}

function snapshotOf(
  repos: Repositories,
  conversationId: ConversationId,
): ConversationSnapshot | null {
  const record = repos.conversations.byId(conversationId);
  if (record === null) return null;
  return {
    conversationId: record.conversationId,
    generationIds: [...record.generationIds],
    createdAt: record.createdAt,
    lastActiveAt: record.lastActiveAt,
    messages: repos.conversations.messages(conversationId),
    selections: repos.conversations.selections(conversationId),
    readingPosition: readingPositionFor(repos, conversationId),
  };
}

function requireConversation(
  repos: Repositories,
  conversationId: ConversationId,
): ConversationSnapshot {
  const snapshot = snapshotOf(repos, conversationId);
  if (snapshot === null) {
    throw new LearningError("not_found", "会话不存在", { conversationId });
  }
  return snapshot;
}

/** The single `MessageRecord` → `MessageView` mapping (availability at read time). */
export function toMessageView(
  rec: MessageRecord,
  availabilityOf: (sourceId: SourceId) => SourceStatus,
): MessageView {
  return {
    messageId: rec.messageId,
    role: rec.role,
    content: rec.content,
    status: rec.status,
    answerPhase: rec.answerPhase,
    citations: rec.citations.map((citation) => ({
      sourceId: citation.sourceId,
      generationId: citation.generationId,
      commitSha: citation.commitSha,
      label: citation.label,
      availability: availabilityOf(citation.sourceId),
    })),
    selection: rec.selection,
    unknownReason: rec.unknownReason,
    incomplete: rec.incomplete,
    createdAt: rec.createdAt,
  };
}

function toSelectionView(rec: SelectionRecord): SelectionView {
  return {
    lessonId: rec.lessonId,
    moduleId: rec.moduleId,
    sourceId: rec.sourceId,
    codeLocation: rec.codeLocation,
    createdAt: rec.createdAt,
  };
}

/** The single `ConversationSnapshot` → `ConversationView` mapping. */
export function toConversationView(
  snap: ConversationSnapshot,
  availabilityOf: (sourceId: SourceId) => SourceStatus,
): ConversationView {
  return {
    conversationId: snap.conversationId,
    generationIds: [...snap.generationIds],
    createdAt: snap.createdAt,
    lastActiveAt: snap.lastActiveAt,
    messages: snap.messages.map((message) =>
      toMessageView(message, availabilityOf),
    ),
    selections: snap.selections.map(toSelectionView),
    readingPosition: snap.readingPosition,
  };
}

export function createConversationService(deps: {
  db: Database;
  repos: Repositories;
  clock: Clock;
}): ConversationService {
  const { db, repos, clock } = deps;

  function touch(conversationId: ConversationId): void {
    repos.conversations.touch(conversationId, clock.now().toISOString());
  }

  return {
    async create(i: {
      generationIds: GenerationId[];
      lessonId?: LessonId;
      moduleId?: string;
    }): Promise<ConversationSnapshot> {
      await Promise.resolve();
      assertGenerationSet(i.generationIds);
      for (const generationId of i.generationIds) {
        requirePublished(repos, generationId);
      }
      const selection: QaSelection | null =
        i.lessonId === undefined && i.moduleId === undefined
          ? null
          : { lessonId: i.lessonId, moduleId: i.moduleId };
      assertSelectionOwned(repos, i.generationIds, selection);

      const conversationId = newConversationId();
      const now = clock.now().toISOString();
      db.transaction(() => {
        repos.conversations.insert({
          conversationId,
          generationIds: [...i.generationIds],
          at: now,
        });
        if (selection !== null) {
          repos.conversations.addSelection({
            conversationId,
            lessonId: i.lessonId ?? null,
            moduleId: i.moduleId ?? null,
            sourceId: null,
            codeLocation: null,
            createdAt: now,
          });
        }
      });
      return requireConversation(repos, conversationId);
    },

    async get(id: ConversationId): Promise<ConversationSnapshot | null> {
      await Promise.resolve();
      return snapshotOf(repos, id);
    },

    async appendUserMessage(
      id: ConversationId,
      text: string,
      selection: QaSelection | null,
    ): Promise<MessageRecord> {
      await Promise.resolve();
      const conversation = requireConversation(repos, id);
      assertSelectionOwned(repos, conversation.generationIds, selection);
      if (typeof text !== "string" || text.trim() === "") {
        throw invalid("消息内容不能为空", { field: "text" });
      }

      const now = clock.now().toISOString();
      const record: MessageRecord = {
        messageId: newMessageId(),
        conversationId: id,
        role: "user",
        content: text,
        status: "complete",
        answerPhase: "complete",
        citations: [],
        selection,
        checks: null,
        unknownReason: null,
        incomplete: false,
        createdAt: now,
      };
      db.transaction(() => {
        repos.conversations.insertMessage(record);
        if (selection !== null) {
          repos.conversations.addSelection({
            conversationId: id,
            lessonId: selection.lessonId ?? null,
            moduleId: selection.moduleId ?? null,
            sourceId: selection.sourceId ?? null,
            codeLocation: selection.codeLocation ?? null,
            createdAt: now,
          });
        }
        touch(id);
      });
      return record;
    },

    appendAssistantDelta(id: ConversationId, messageId: MessageId, text: string): void {
      const existing = repos.conversations
        .messages(id)
        .find((message) => message.messageId === messageId);
      if (existing === undefined) {
        throw new LearningError("not_found", "消息不存在", { messageId });
      }
      repos.conversations.updateMessage(messageId, {
        content: existing.content + text,
      });
    },

    async setAnswerPhase(
      id: ConversationId,
      messageId: MessageId,
      phase: AnswerPhase,
    ): Promise<void> {
      await Promise.resolve();
      requireConversation(repos, id);
      repos.conversations.updateMessage(messageId, { answerPhase: phase });
      touch(id);
    },

    async finalizeMessage(
      id: ConversationId,
      messageId: MessageId,
      patch: {
        status: "complete" | "failed" | "cancelled";
        answerPhase: AnswerPhase;
        citations: Citation[];
        checks: LessonChecks | null;
        unknownReason: string | null;
        incomplete: boolean;
      },
    ): Promise<void> {
      await Promise.resolve();
      requireConversation(repos, id);
      db.transaction(() => {
        repos.conversations.updateMessage(messageId, {
          status: patch.status,
          answerPhase: patch.answerPhase,
          citations: patch.citations,
          checks: patch.checks,
          unknownReason: patch.unknownReason,
          incomplete: patch.incomplete,
        });
        touch(id);
      });
    },

    async addSelection(id: ConversationId, sel: QaSelection): Promise<SelectionRecord> {
      await Promise.resolve();
      const conversation = requireConversation(repos, id);
      assertSelectionOwned(repos, conversation.generationIds, sel);
      const now = clock.now().toISOString();
      const record = repos.conversations.addSelection({
        conversationId: id,
        lessonId: sel.lessonId ?? null,
        moduleId: sel.moduleId ?? null,
        sourceId: sel.sourceId ?? null,
        codeLocation: sel.codeLocation ?? null,
        createdAt: now,
      });
      touch(id);
      return record;
    },
  };
}
