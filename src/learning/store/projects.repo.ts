import type {
  Database,
  NewProjectRecord,
  NormalizedScope,
  ProjectId,
  ProjectRecord,
  ProjectsRepo,
  RepoId,
  RepoKind,
} from "../contracts/index.js";

interface ProjectRow {
  project_id: string;
  repo_id: string;
  kind: string;
  display_name: string;
  remote_url: string | null;
  default_branch: string | null;
  scope_json: string;
  watch_enabled: number;
  created_at: string;
  deleted_at: string | null;
}

const SELECT_COLUMNS = `SELECT project_id, repo_id, kind, display_name, remote_url,
  default_branch, scope_json, watch_enabled, created_at, deleted_at FROM projects`;

function toRecord(row: ProjectRow): ProjectRecord {
  return {
    projectId: row.project_id as ProjectId,
    repoId: row.repo_id as RepoId,
    kind: row.kind as RepoKind,
    displayName: row.display_name,
    remoteUrl: row.remote_url,
    defaultBranch: row.default_branch,
    scope: JSON.parse(row.scope_json) as NormalizedScope,
    watchEnabled: row.watch_enabled !== 0,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  };
}

/** `ProjectsRepo` — the only SQL that touches `projects`. */
export function createProjectsRepo(db: Database): ProjectsRepo {
  const insertStmt = db.raw.prepare(
    `INSERT INTO projects (project_id, repo_id, kind, display_name, remote_url,
       default_branch, scope_json, watch_enabled, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const byIdStmt = db.raw.prepare(`${SELECT_COLUMNS} WHERE project_id = ?`);
  const listStmt = db.raw.prepare(
    `${SELECT_COLUMNS} WHERE deleted_at IS NULL ORDER BY created_at ASC, project_id ASC`,
  );
  const setWatchStmt = db.raw.prepare(
    `UPDATE projects SET watch_enabled = ?, scope_json = COALESCE(?, scope_json)
     WHERE project_id = ?`,
  );
  const markDeletedStmt = db.raw.prepare(
    "UPDATE projects SET deleted_at = ? WHERE project_id = ?",
  );
  const liveForRepoStmt = db.raw.prepare(
    `${SELECT_COLUMNS} WHERE repo_id = ? AND deleted_at IS NULL
     ORDER BY created_at DESC, project_id DESC LIMIT 1`,
  );

  return {
    insert(rec: NewProjectRecord): void {
      insertStmt.run(
        rec.projectId,
        rec.repoId,
        rec.kind,
        rec.displayName,
        rec.remoteUrl,
        rec.defaultBranch,
        JSON.stringify(rec.scope),
        rec.watchEnabled ? 1 : 0,
        rec.createdAt,
        rec.deletedAt,
      );
    },
    byId(id: ProjectId): ProjectRecord | null {
      const row = byIdStmt.get(id) as ProjectRow | undefined;
      return row ? toRecord(row) : null;
    },
    list(): ProjectRecord[] {
      return (listStmt.all() as ProjectRow[]).map(toRecord);
    },
    setWatch(
      id: ProjectId,
      enabled: boolean,
      scope: NormalizedScope | null,
    ): void {
      setWatchStmt.run(
        enabled ? 1 : 0,
        scope === null ? null : JSON.stringify(scope),
        id,
      );
    },
    markDeleted(id: ProjectId, at: string): void {
      markDeletedStmt.run(at, id);
    },
    liveProjectForRepo(repoId: RepoId): ProjectRecord | null {
      const row = liveForRepoStmt.get(repoId) as ProjectRow | undefined;
      return row ? toRecord(row) : null;
    },
  };
}
