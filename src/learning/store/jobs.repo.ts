import type {
  Database,
  GenerationId,
  JobErrorCode,
  JobId,
  JobPayload,
  JobProgress,
  JobRecord,
  JobsRepo,
  JobState,
  NewJob,
  ProjectId,
  RepoId,
} from "../contracts/index.js";

interface JobRow {
  job_id: string;
  dedupe_key: string;
  kind: string;
  repo_id: string;
  project_id: string | null;
  stream_id: string | null;
  state: string;
  payload_json: string;
  attempt: number;
  error_code: string | null;
  error_detail: string | null;
  progress_json: string | null;
  output_generation_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const SELECT_COLUMNS = `SELECT job_id, dedupe_key, kind, repo_id, project_id, stream_id,
  state, payload_json, attempt, error_code, error_detail, progress_json,
  output_generation_id, created_at, started_at, finished_at FROM jobs`;

function toRecord(row: JobRow): JobRecord {
  return {
    jobId: row.job_id as JobId,
    dedupeKey: row.dedupe_key,
    kind: row.kind as JobRecord["kind"],
    repoId: row.repo_id as RepoId,
    projectId: row.project_id as ProjectId | null,
    streamId: row.stream_id,
    state: row.state as JobState,
    payload: JSON.parse(row.payload_json) as JobPayload,
    attempt: row.attempt,
    errorCode: row.error_code as JobErrorCode | null,
    errorDetail: row.error_detail,
    progress:
      row.progress_json === null
        ? null
        : (JSON.parse(row.progress_json) as JobProgress),
    outputGenerationId: row.output_generation_id as GenerationId | null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/** Field → column map for `transition`/patch writes. Closed set, never user input. */
const PATCH_COLUMNS: Readonly<Record<string, string>> = {
  dedupeKey: "dedupe_key",
  kind: "kind",
  repoId: "repo_id",
  projectId: "project_id",
  streamId: "stream_id",
  payload: "payload_json",
  attempt: "attempt",
  errorCode: "error_code",
  errorDetail: "error_detail",
  progress: "progress_json",
  outputGenerationId: "output_generation_id",
  createdAt: "created_at",
  startedAt: "started_at",
  finishedAt: "finished_at",
};

function encodePatch(patch: Partial<JobRecord>): {
  columns: string[];
  values: unknown[];
} {
  const columns: string[] = [];
  const values: unknown[] = [];
  const source = patch as Record<string, unknown>;
  for (const [field, column] of Object.entries(PATCH_COLUMNS)) {
    const value = source[field];
    if (value === undefined) {
      continue;
    }
    columns.push(column);
    if (field === "payload") {
      values.push(JSON.stringify(value));
    } else if (field === "progress") {
      values.push(value === null ? null : JSON.stringify(value));
    } else {
      values.push(value);
    }
  }
  return { columns, values };
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}

/** `JobsRepo` — the only SQL that touches `jobs`. */
export function createJobsRepo(db: Database): JobsRepo {
  const insertStmt = db.raw.prepare(
    `INSERT INTO jobs (job_id, dedupe_key, kind, repo_id, project_id, stream_id,
       state, payload_json, attempt, error_code, error_detail, progress_json,
       output_generation_id, created_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const byDedupeKeyStmt = db.raw.prepare(
    `${SELECT_COLUMNS} WHERE dedupe_key = ?`,
  );
  const byIdStmt = db.raw.prepare(`${SELECT_COLUMNS} WHERE job_id = ?`);
  const listByStreamStmt = db.raw.prepare(
    `${SELECT_COLUMNS} WHERE stream_id = ? ORDER BY created_at ASC, job_id ASC`,
  );
  const bumpAttemptStmt = db.raw.prepare(
    "UPDATE jobs SET attempt = attempt + 1 WHERE job_id = ?",
  );
  const attemptStmt = db.raw.prepare(
    "SELECT attempt FROM jobs WHERE job_id = ?",
  );

  const one = (row: unknown): JobRecord | null =>
    row === undefined ? null : toRecord(row as JobRow);

  return {
    insert(job: NewJob): void {
      insertStmt.run(
        job.jobId,
        job.dedupeKey,
        job.kind,
        job.repoId,
        job.projectId,
        job.streamId,
        job.state,
        JSON.stringify(job.payload),
        job.attempt,
        job.errorCode,
        job.errorDetail,
        job.progress === null ? null : JSON.stringify(job.progress),
        job.outputGenerationId,
        job.createdAt,
        job.startedAt,
        job.finishedAt,
      );
    },
    byDedupeKey(key: string): JobRecord | null {
      return one(byDedupeKeyStmt.get(key));
    },
    byId(id: JobId): JobRecord | null {
      return one(byIdStmt.get(id));
    },
    transition(
      id: JobId,
      from: JobState[],
      to: JobState,
      patch?: Partial<JobRecord>,
    ): boolean {
      if (from.length === 0) {
        return false;
      }
      const { columns, values } = encodePatch(patch ?? {});
      const assignments = ["state = ?", ...columns.map((c) => `${c} = ?`)];
      const sql = `UPDATE jobs SET ${assignments.join(", ")} WHERE job_id = ? AND state IN (${placeholders(from.length)})`;
      const result = db.raw.prepare(sql).run(to, ...values, id, ...from);
      return Number(result.changes) > 0;
    },
    listByState(states: JobState[]): JobRecord[] {
      if (states.length === 0) {
        return [];
      }
      const sql = `${SELECT_COLUMNS} WHERE state IN (${placeholders(states.length)}) ORDER BY created_at ASC, job_id ASC`;
      return (db.raw.prepare(sql).all(...states) as JobRow[]).map(toRecord);
    },
    listByStream(streamId: string): JobRecord[] {
      return (listByStreamStmt.all(streamId) as JobRow[]).map(toRecord);
    },
    listByProject(projectId: ProjectId, states: JobState[]): JobRecord[] {
      if (states.length === 0) {
        return [];
      }
      const sql = `${SELECT_COLUMNS} WHERE project_id = ? AND state IN (${placeholders(states.length)}) ORDER BY created_at ASC, job_id ASC`;
      return (db.raw.prepare(sql).all(projectId, ...states) as JobRow[]).map(
        toRecord,
      );
    },
    bumpAttempt(id: JobId): number {
      bumpAttemptStmt.run(id);
      const row = attemptStmt.get(id) as { attempt: number } | undefined;
      return row ? row.attempt : 0;
    },
  };
}
