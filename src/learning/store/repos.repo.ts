import type {
  Database,
  NewRepoRecord,
  RepoIdentity,
  RepoId,
  RepoKind,
  RepoRecord,
  ReposRepo,
} from "../contracts/index.js";

interface RepoRow {
  repo_id: string;
  identity: string;
  kind: string;
  mirror_path: string;
  remote_url: string | null;
  created_at: string;
}

const SELECT_COLUMNS =
  "SELECT repo_id, identity, kind, mirror_path, remote_url, created_at FROM repos";

function toRecord(row: RepoRow): RepoRecord {
  return {
    repoId: row.repo_id as RepoId,
    identity: row.identity,
    kind: row.kind as RepoKind,
    mirrorPath: row.mirror_path,
    remoteUrl: row.remote_url,
    createdAt: row.created_at,
  };
}

/** `ReposRepo` — the only SQL that touches `repos`. */
export function createReposRepo(db: Database): ReposRepo {
  const byIdentityStmt = db.raw.prepare(`${SELECT_COLUMNS} WHERE identity = ?`);
  const byIdStmt = db.raw.prepare(`${SELECT_COLUMNS} WHERE repo_id = ?`);
  const insertStmt = db.raw.prepare(
    `INSERT INTO repos (repo_id, identity, kind, mirror_path, remote_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const byIdentity = (identity: RepoIdentity): RepoRecord | null => {
    const row = byIdentityStmt.get(identity) as RepoRow | undefined;
    return row ? toRecord(row) : null;
  };

  return {
    byIdentity,
    upsert(rec: NewRepoRecord): RepoRecord {
      const existing = byIdentity(rec.identity);
      if (existing) {
        return existing;
      }
      insertStmt.run(
        rec.repoId,
        rec.identity,
        rec.kind,
        rec.mirrorPath,
        rec.remoteUrl,
        rec.createdAt,
      );
      return rec;
    },
    byId(id: RepoId): RepoRecord | null {
      const row = byIdStmt.get(id) as RepoRow | undefined;
      return row ? toRecord(row) : null;
    },
  };
}
