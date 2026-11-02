import type {
  AttemptsRepo,
  Database,
  JobAttemptRecord,
  JobAttemptState,
  JobId,
} from "../contracts/index.js";

interface AttemptRow {
  job_id: string;
  attempt: number;
  state: string;
  started_at: string;
  finished_at: string | null;
  usage_id: string | null;
}

const SELECT_COLUMNS = `SELECT job_id, attempt, state, started_at, finished_at, usage_id
  FROM job_attempts`;

function toRecord(row: AttemptRow): JobAttemptRecord {
  return {
    jobId: row.job_id as JobId,
    attempt: row.attempt,
    state: row.state as JobAttemptState,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    usageId: row.usage_id,
  };
}

/** `AttemptsRepo` — the only SQL that touches `job_attempts`. */
export function createAttemptsRepo(db: Database): AttemptsRepo {
  const openStmt = db.raw.prepare(
    `INSERT INTO job_attempts (job_id, attempt, state, started_at, finished_at, usage_id)
     VALUES (?, ?, 'running', ?, NULL, NULL)`,
  );
  const closeStmt = db.raw.prepare(
    `UPDATE job_attempts SET state = ?, finished_at = ?, usage_id = ?
     WHERE job_id = ? AND attempt = ?`,
  );
  const listStmt = db.raw.prepare(
    `${SELECT_COLUMNS} WHERE job_id = ? ORDER BY attempt ASC`,
  );

  return {
    open(jobId: JobId, attempt: number, at: string): void {
      openStmt.run(jobId, attempt, at);
    },
    close(
      jobId: JobId,
      attempt: number,
      state: JobAttemptState,
      at: string,
      usageId: string | null,
    ): void {
      closeStmt.run(state, at, usageId, jobId, attempt);
    },
    list(jobId: JobId): JobAttemptRecord[] {
      return (listStmt.all(jobId) as AttemptRow[]).map(toRecord);
    },
  };
}
