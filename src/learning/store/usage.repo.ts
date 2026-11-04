import type {
  Database,
  UsageKind,
  UsageRecord,
  UsageRepo,
  UsageView,
} from "../contracts/index.js";

interface UsageGroupRow {
  kind: string;
  input_tokens: number | null;
  output_tokens: number | null;
  calls: number | null;
  cost_cents: number | null;
}

const GROUP_COLUMNS = `SELECT kind, SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens, SUM(calls) AS calls,
  SUM(cost_cents) AS cost_cents FROM usage_records`;

/** `UsageRepo` — the only SQL that touches `usage_records`. */
export function createUsageRepo(db: Database): UsageRepo {
  const insertStmt = db.raw.prepare(
    `INSERT INTO usage_records (usage_id, job_id, conversation_id, kind, provider,
       model, input_tokens, output_tokens, calls, cost_cents, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const allGroupsStmt = db.raw.prepare(
    `${GROUP_COLUMNS} GROUP BY kind ORDER BY kind ASC`,
  );
  const oneGroupStmt = db.raw.prepare(
    `${GROUP_COLUMNS} WHERE kind = ? GROUP BY kind ORDER BY kind ASC`,
  );

  return {
    insert(rec: UsageRecord): void {
      insertStmt.run(
        rec.usageId,
        rec.jobId,
        rec.conversationId,
        rec.kind,
        rec.provider,
        rec.model,
        rec.inputTokens,
        rec.outputTokens,
        rec.calls,
        rec.costCents,
        rec.createdAt,
      );
    },
    groupByKind(kind?: UsageKind): UsageView["groups"] {
      const rows = (
        kind === undefined ? allGroupsStmt.all() : oneGroupStmt.all(kind)
      ) as UsageGroupRow[];
      return rows.map((row) => ({
        kind: row.kind as UsageKind,
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
        calls: Number(row.calls ?? 0),
        costCents: row.cost_cents === null ? null : Number(row.cost_cents),
      }));
    },
  };
}
