import type {
  Citation,
  ConversationId,
  ConversationRecord,
  ConversationSummary,
  ConversationsRepo,
  Database,
  GenerationId,
  LessonChecks,
  LessonId,
  MessageId,
  MessageRecord,
  MessageRole,
  MessageStatus,
  AnswerPhase,
  ProjectId,
  QaSelection,
  SelectionRecord,
  SourceId,
} from "../contracts/index.js";

interface ConversationRow {
  conversation_id: string;
  generation_ids_json: string;
  created_at: string;
  last_active_at: string;
  summary_json: string | null;
}

interface MessageRow {
  message_id: string;
  conversation_id: string;
  role: string;
  content: string;
  status: string;
  answer_phase: string;
  unknown_reason: string | null;
  incomplete: number;
  citations_json: string | null;
  selection_json: string | null;
  check_json: string | null;
  created_at: string;
}

interface SelectionRow {
  id: number;
  conversation_id: string;
  lesson_id: string | null;
  module_id: string | null;
  source_id: string | null;
  code_location_json: string | null;
  created_at: string;
}

const CONVERSATION_COLUMNS = `SELECT conversation_id, generation_ids_json, created_at,
  last_active_at, summary_json FROM conversations`;

const MESSAGE_COLUMNS = `SELECT message_id, conversation_id, role, content, status,
  answer_phase, unknown_reason, incomplete, citations_json, selection_json, check_json,
  created_at FROM messages`;

const SELECTION_COLUMNS = `SELECT id, conversation_id, lesson_id, module_id, source_id,
  code_location_json, created_at FROM conversation_selections`;

function toConversation(row: ConversationRow): ConversationRecord {
  return {
    conversationId: row.conversation_id as ConversationId,
    generationIds: JSON.parse(row.generation_ids_json) as GenerationId[],
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    summary:
      row.summary_json === null
        ? null
        : (JSON.parse(row.summary_json) as ConversationSummary),
  };
}

function toMessage(row: MessageRow): MessageRecord {
  return {
    messageId: row.message_id as MessageId,
    conversationId: row.conversation_id as ConversationId,
    role: row.role as MessageRole,
    content: row.content,
    status: row.status as MessageStatus,
    answerPhase: row.answer_phase as AnswerPhase,
    citations:
      row.citations_json === null
        ? []
        : (JSON.parse(row.citations_json) as Citation[]),
    selection:
      row.selection_json === null
        ? null
        : (JSON.parse(row.selection_json) as QaSelection),
    checks:
      row.check_json === null
        ? null
        : (JSON.parse(row.check_json) as LessonChecks),
    unknownReason: row.unknown_reason,
    incomplete: row.incomplete !== 0,
    createdAt: row.created_at,
  };
}

function toSelection(row: SelectionRow): SelectionRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id as ConversationId,
    lessonId: row.lesson_id as LessonId | null,
    moduleId: row.module_id,
    sourceId: row.source_id as SourceId | null,
    codeLocation:
      row.code_location_json === null
        ? null
        : (JSON.parse(
            row.code_location_json,
          ) as SelectionRecord["codeLocation"]),
    createdAt: row.created_at,
  };
}

/**
 * Field → column map for `updateMessage`. Closed set, never user input.
 * `conversation_id` is deliberately absent: a message never moves between
 * conversations.
 */
const MESSAGE_PATCH_COLUMNS: Readonly<Record<string, string>> = {
  role: "role",
  content: "content",
  status: "status",
  answerPhase: "answer_phase",
  citations: "citations_json",
  selection: "selection_json",
  checks: "check_json",
  unknownReason: "unknown_reason",
  incomplete: "incomplete",
  createdAt: "created_at",
};

function encodeMessageValue(field: string, value: unknown): unknown {
  switch (field) {
    case "citations":
      return JSON.stringify(value);
    case "selection":
    case "checks":
      return value === null ? null : JSON.stringify(value);
    case "incomplete":
      return value === true ? 1 : 0;
    default:
      return value;
  }
}

/** `ConversationsRepo` — the only SQL that touches `conversations`, `messages`
 *  and `conversation_selections`. */
export function createConversationsRepo(db: Database): ConversationsRepo {
  const insertStmt = db.raw.prepare(
    `INSERT INTO conversations (conversation_id, generation_ids_json, created_at,
       last_active_at, summary_json)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const byIdStmt = db.raw.prepare(
    `${CONVERSATION_COLUMNS} WHERE conversation_id = ?`,
  );
  const touchStmt = db.raw.prepare(
    "UPDATE conversations SET last_active_at = ? WHERE conversation_id = ?",
  );
  const insertMessageStmt = db.raw.prepare(
    `INSERT INTO messages (message_id, conversation_id, role, content, status,
       answer_phase, unknown_reason, incomplete, citations_json, selection_json,
       check_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const messagesAscStmt = db.raw.prepare(
    `${MESSAGE_COLUMNS} WHERE conversation_id = ?
     ORDER BY created_at ASC, rowid ASC`,
  );
  const messagesBeforeAscStmt = db.raw.prepare(
    `${MESSAGE_COLUMNS} WHERE conversation_id = ? AND created_at < ?
     ORDER BY created_at ASC, rowid ASC`,
  );
  const messagesDescStmt = db.raw.prepare(
    `${MESSAGE_COLUMNS} WHERE conversation_id = ?
     ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  );
  const messagesBeforeDescStmt = db.raw.prepare(
    `${MESSAGE_COLUMNS} WHERE conversation_id = ? AND created_at < ?
     ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  );
  const insertSelectionStmt = db.raw.prepare(
    `INSERT INTO conversation_selections (conversation_id, lesson_id, module_id,
       source_id, code_location_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const selectionsStmt = db.raw.prepare(
    `${SELECTION_COLUMNS} WHERE conversation_id = ? ORDER BY id ASC`,
  );
  const countByProjectStmt = db.raw.prepare(
    `SELECT COUNT(DISTINCT c.conversation_id) AS total
     FROM conversations c
     JOIN json_each(c.generation_ids_json) AS j
     JOIN generations g ON g.generation_id = j.value
     WHERE g.project_id = ?`,
  );
  const cancelStreamingStmt = db.raw.prepare(
    `UPDATE messages SET status = 'cancelled', answer_phase = 'cancelled'
     WHERE status = 'streaming'`,
  );

  return {
    insert(rec: {
      conversationId: ConversationId;
      generationIds: GenerationId[];
      at: string;
    }): void {
      insertStmt.run(
        rec.conversationId,
        JSON.stringify(rec.generationIds),
        rec.at,
        rec.at,
        null,
      );
    },
    byId(id: ConversationId): ConversationRecord | null {
      const row = byIdStmt.get(id) as ConversationRow | undefined;
      return row ? toConversation(row) : null;
    },
    touch(id: ConversationId, at: string): void {
      touchStmt.run(at, id);
    },
    insertMessage(m: MessageRecord): void {
      insertMessageStmt.run(
        m.messageId,
        m.conversationId,
        m.role,
        m.content,
        m.status,
        m.answerPhase,
        m.unknownReason,
        m.incomplete ? 1 : 0,
        JSON.stringify(m.citations),
        m.selection === null ? null : JSON.stringify(m.selection),
        m.checks === null ? null : JSON.stringify(m.checks),
        m.createdAt,
      );
    },
    updateMessage(id: MessageId, patch: Partial<MessageRecord>): void {
      const assignments: string[] = [];
      const values: unknown[] = [];
      const source = patch as Record<string, unknown>;
      for (const [field, column] of Object.entries(MESSAGE_PATCH_COLUMNS)) {
        const value = source[field];
        if (value === undefined) {
          continue;
        }
        assignments.push(`${column} = ?`);
        values.push(encodeMessageValue(field, value));
      }
      if (assignments.length === 0) {
        return;
      }
      const sql = `UPDATE messages SET ${assignments.join(", ")} WHERE message_id = ?`;
      db.raw.prepare(sql).run(...values, id);
    },
    messages(
      id: ConversationId,
      opts?: { limit?: number; before?: string },
    ): MessageRecord[] {
      const before = opts?.before ?? null;
      const limit = opts?.limit;
      // A message id cursor includes the insertion-order tie-breaker. Legacy
      // timestamp cursors remain accepted for existing callers.
      if (before?.startsWith("m_")) {
        const rows = db.raw
          .prepare(
            `${MESSAGE_COLUMNS} WHERE conversation_id = ?
          AND (created_at, rowid) < (SELECT created_at, rowid FROM messages WHERE message_id = ? AND conversation_id = ?)
          ORDER BY created_at ${limit === undefined ? "ASC" : "DESC"}, rowid ${limit === undefined ? "ASC" : "DESC"}${limit === undefined ? "" : " LIMIT ?"}`,
          )
          .all(
            id,
            before,
            id,
            ...(limit === undefined ? [] : [limit]),
          ) as MessageRow[];
        return (limit === undefined ? rows : rows.reverse()).map(toMessage);
      }
      if (limit === undefined) {
        const rows =
          before === null
            ? (messagesAscStmt.all(id) as MessageRow[])
            : (messagesBeforeAscStmt.all(id, before) as MessageRow[]);
        return rows.map(toMessage);
      }
      const rows =
        before === null
          ? (messagesDescStmt.all(id, limit) as MessageRow[])
          : (messagesBeforeDescStmt.all(id, before, limit) as MessageRow[]);
      return rows.reverse().map(toMessage);
    },
    addSelection(sel: Omit<SelectionRecord, "id">): SelectionRecord {
      const result = insertSelectionStmt.run(
        sel.conversationId,
        sel.lessonId,
        sel.moduleId,
        sel.sourceId,
        sel.codeLocation === null ? null : JSON.stringify(sel.codeLocation),
        sel.createdAt,
      );
      return { ...sel, id: Number(result.lastInsertRowid) };
    },
    selections(id: ConversationId): SelectionRecord[] {
      return (selectionsStmt.all(id) as SelectionRow[]).map(toSelection);
    },
    countByProject(projectId: ProjectId): number {
      const row = countByProjectStmt.get(projectId) as
        { total: number } | undefined;
      return row ? row.total : 0;
    },
    cancelStreaming(): number {
      return Number(cancelStreamingStmt.run().changes);
    },
  };
}
