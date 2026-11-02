import {
  LearningError,
  type ChangeEventId,
  type ChangeEventKind,
  type ChangeEventPayload,
  type ChangeEventState,
  type ChangeRecord,
  type ChangesRepo,
  type Database,
  type JobId,
  type LinkRelation,
  type NewChangeEvent,
  type ProjectId,
  type RepoId,
  type Significance,
  type StreamKind,
} from "../contracts/index.js";

interface ChangeRow {
  event_id: string;
  event_key: string;
  repo_id: string;
  project_id: string;
  stream_id: string;
  stream_kind: string;
  kind: string;
  base_sha: string | null;
  head_sha: string | null;
  merge_base_sha: string | null;
  base_context_sha: string | null;
  significance: string;
  state: string;
  job_id: string | null;
  gap_reason: string | null;
  linked_event_id: string | null;
  link_relation: string | null;
  discovered_at: string;
  published_at: string | null;
  payload_json: string;
}

const SELECT_COLUMNS = `SELECT event_id, event_key, repo_id, project_id, stream_id,
  stream_kind, kind, base_sha, head_sha, merge_base_sha, base_context_sha, significance,
  state, job_id, gap_reason, linked_event_id, link_relation, discovered_at, published_at,
  payload_json FROM change_events`;

function toRecord(row: ChangeRow): ChangeRecord {
  return {
    eventId: row.event_id as ChangeEventId,
    eventKey: row.event_key,
    repoId: row.repo_id as RepoId,
    projectId: row.project_id as ProjectId,
    streamId: row.stream_id,
    streamKind: row.stream_kind as StreamKind,
    kind: row.kind as ChangeEventKind,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    mergeBaseSha: row.merge_base_sha,
    baseContextSha: row.base_context_sha,
    significance: row.significance as Significance,
    state: row.state as ChangeEventState,
    jobId: row.job_id as JobId | null,
    gapReason: row.gap_reason,
    linkedEventId: row.linked_event_id as ChangeEventId | null,
    linkRelation: row.link_relation as LinkRelation | null,
    discoveredAt: row.discovered_at,
    publishedAt: row.published_at,
    payload: JSON.parse(row.payload_json) as ChangeEventPayload,
  };
}

/** Field → column map for `setState`'s patch. Closed set, never user input. */
const PATCH_COLUMNS: Readonly<Record<string, string>> = {
  jobId: "job_id",
  gapReason: "gap_reason",
  publishedAt: "published_at",
  payload: "payload_json",
  linkedEventId: "linked_event_id",
  linkRelation: "link_relation",
  significance: "significance",
};

interface PageCursor {
  discoveredAt: string;
  eventId: string;
}

function encodePageCursor(row: ChangeRow): string {
  return Buffer.from(
    JSON.stringify({ d: row.discovered_at, e: row.event_id }),
    "utf8",
  ).toString("base64url");
}

function decodePageCursor(cursor: string): PageCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new LearningError("invalid_input", "游标无法解析", {
      reason: "cursor_invalid",
    });
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new LearningError("invalid_input", "游标无法解析", {
      reason: "cursor_invalid",
    });
  }
  const value = parsed as Record<string, unknown>;
  if (typeof value.d !== "string" || typeof value.e !== "string") {
    throw new LearningError("invalid_input", "游标无法解析", {
      reason: "cursor_invalid",
    });
  }
  return { discoveredAt: value.d, eventId: value.e };
}

/** `ChangesRepo` — the only SQL that touches `change_events`. */
export function createChangesRepo(db: Database): ChangesRepo {
  const insertStmt = db.raw.prepare(
    `INSERT INTO change_events (event_id, event_key, repo_id, project_id, stream_id,
       stream_kind, kind, base_sha, head_sha, merge_base_sha, base_context_sha,
       significance, state, job_id, gap_reason, linked_event_id, link_relation,
       discovered_at, published_at, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const byIdStmt = db.raw.prepare(`${SELECT_COLUMNS} WHERE event_id = ?`);
  const countStmt = db.raw.prepare(
    "SELECT COUNT(*) AS total FROM change_events WHERE project_id = ?",
  );

  return {
    insertMany(events: NewChangeEvent[]): void {
      for (const event of events) {
        insertStmt.run(
          event.eventId,
          event.eventKey,
          event.repoId,
          event.projectId,
          event.streamId,
          event.streamKind,
          event.kind,
          event.baseSha,
          event.headSha,
          event.mergeBaseSha,
          event.baseContextSha,
          event.significance,
          event.state,
          event.jobId,
          event.gapReason,
          event.linkedEventId,
          event.linkRelation,
          event.discoveredAt,
          event.publishedAt,
          JSON.stringify(event.payload),
        );
      }
    },
    page(
      projectId: ProjectId,
      cursor: string | null,
      limit: number,
    ): { items: ChangeRecord[]; next: string | null } {
      if (limit <= 0) {
        return { items: [], next: null };
      }
      const decoded = cursor === null ? null : decodePageCursor(cursor);
      const conditions = ["project_id = ?"];
      const values: unknown[] = [projectId];
      if (decoded !== null) {
        conditions.push(
          "(discovered_at < ? OR (discovered_at = ? AND event_id < ?))",
        );
        values.push(
          decoded.discoveredAt,
          decoded.discoveredAt,
          decoded.eventId,
        );
      }
      const sql = `${SELECT_COLUMNS} WHERE ${conditions.join(" AND ")}
        ORDER BY discovered_at DESC, event_id DESC LIMIT ?`;
      const rows = db.raw.prepare(sql).all(...values, limit + 1) as ChangeRow[];
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const last = pageRows[pageRows.length - 1];
      return {
        items: pageRows.map(toRecord),
        next: hasMore && last ? encodePageCursor(last) : null,
      };
    },
    byId(id: ChangeEventId): ChangeRecord | null {
      const row = byIdStmt.get(id) as ChangeRow | undefined;
      return row ? toRecord(row) : null;
    },
    setState(
      id: ChangeEventId,
      state: ChangeEventState,
      patch?: Partial<ChangeRecord>,
    ): void {
      const assignments = ["state = ?"];
      const values: unknown[] = [state];
      const source = patch as Record<string, unknown> | undefined;
      for (const [field, column] of Object.entries(PATCH_COLUMNS)) {
        const value = source?.[field];
        if (value === undefined) {
          continue;
        }
        assignments.push(`${column} = ?`);
        values.push(field === "payload" ? JSON.stringify(value) : value);
      }
      const sql = `UPDATE change_events SET ${assignments.join(", ")} WHERE event_id = ?`;
      db.raw.prepare(sql).run(...values, id);
    },
    link(i: {
      prEventId: ChangeEventId;
      defaultBranchEventId: ChangeEventId;
      relation: LinkRelation;
    }): void {
      db.raw
        .prepare(
          `UPDATE change_events SET linked_event_id = ?, link_relation = ?
           WHERE event_id = ?`,
        )
        .run(i.defaultBranchEventId, i.relation, i.prEventId);
    },
    countByProject(projectId: ProjectId): number {
      const row = countStmt.get(projectId) as { total: number } | undefined;
      return row ? row.total : 0;
    },
    listByStream(streamId: string, states: ChangeEventState[]): ChangeRecord[] {
      if (states.length === 0) {
        return [];
      }
      const placeholders = new Array(states.length).fill("?").join(", ");
      const sql = `${SELECT_COLUMNS} WHERE stream_id = ? AND state IN (${placeholders})
        ORDER BY discovered_at ASC, event_id ASC`;
      return (db.raw.prepare(sql).all(streamId, ...states) as ChangeRow[]).map(
        toRecord,
      );
    },
  };
}
