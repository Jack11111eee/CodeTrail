import type {
  Database,
  RepoId,
  SnapshotRecord,
  SnapshotsRepo,
} from "../contracts/index.js";

interface SnapshotRow {
  repo_id: string;
  commit_sha: string;
  tree_hash: string;
  worktree_path: string;
  resolved_at: string;
}

const SELECT_COLUMNS = `SELECT repo_id, commit_sha, tree_hash, worktree_path, resolved_at
  FROM snapshots`;

function toRecord(row: SnapshotRow): SnapshotRecord {
  return {
    repoId: row.repo_id as RepoId,
    commitSha: row.commit_sha,
    treeHash: row.tree_hash,
    worktreePath: row.worktree_path,
    resolvedAt: row.resolved_at,
  };
}

/** `SnapshotsRepo` — the only SQL that touches `snapshots`. */
export function createSnapshotsRepo(db: Database): SnapshotsRepo {
  const byCommitStmt = db.raw.prepare(
    `${SELECT_COLUMNS} WHERE repo_id = ? AND commit_sha = ?`,
  );
  const upsertStmt = db.raw.prepare(
    `INSERT INTO snapshots (repo_id, commit_sha, tree_hash, worktree_path, resolved_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, commit_sha) DO UPDATE SET
       tree_hash = excluded.tree_hash,
       worktree_path = excluded.worktree_path,
       resolved_at = excluded.resolved_at`,
  );
  const referencedStmt = db.raw.prepare(
    `SELECT 1 AS hit FROM generations
     WHERE status = 'published' AND (commit_sha = ? OR comparison_base_sha = ?)
     LIMIT 1`,
  );

  return {
    byCommit(repoId: RepoId, sha: string): SnapshotRecord | null {
      const row = byCommitStmt.get(repoId, sha) as SnapshotRow | undefined;
      return row ? toRecord(row) : null;
    },
    upsert(rec: SnapshotRecord): void {
      upsertStmt.run(
        rec.repoId,
        rec.commitSha,
        rec.treeHash,
        rec.worktreePath,
        rec.resolvedAt,
      );
    },
    referencedByPublished(sha: string): boolean {
      return referencedStmt.get(sha, sha) !== undefined;
    },
  };
}
