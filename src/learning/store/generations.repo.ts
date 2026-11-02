import type {
  Database,
  GenerationId,
  GenerationKind,
  GenerationRecord,
  GenerationsRepo,
  GenerationStatus,
  JobId,
  NewGeneration,
  ProjectId,
  RepoId,
} from "../contracts/index.js";

interface GenerationRow {
  generation_id: string;
  cache_key: string;
  repo_id: string;
  commit_sha: string;
  comparison_base_sha: string | null;
  kind: string;
  scope_hash: string;
  config_hash: string;
  prompt_template_version: string;
  preferences_version: number;
  upstream_version: string;
  status: string;
  content_dir: string;
  sealed_tree_hash: string | null;
  baseline_from_generation_id: string | null;
  fallback_reason: string | null;
  project_id: string | null;
  job_id: string | null;
  created_at: string;
  published_at: string | null;
}

const SELECT_COLUMNS = `SELECT generation_id, cache_key, repo_id, commit_sha,
  comparison_base_sha, kind, scope_hash, config_hash, prompt_template_version,
  preferences_version, upstream_version, status, content_dir, sealed_tree_hash,
  baseline_from_generation_id, fallback_reason, project_id, job_id, created_at,
  published_at FROM generations`;

function toRecord(row: GenerationRow): GenerationRecord {
  return {
    generationId: row.generation_id as GenerationId,
    cacheKey: row.cache_key,
    repoId: row.repo_id as RepoId,
    projectId: row.project_id as ProjectId | null,
    commitSha: row.commit_sha,
    comparisonBaseSha: row.comparison_base_sha,
    kind: row.kind as GenerationKind,
    scopeHash: row.scope_hash,
    configHash: row.config_hash,
    promptTemplateVersion: row.prompt_template_version,
    preferencesVersion: row.preferences_version,
    upstreamVersion: row.upstream_version,
    status: row.status as GenerationStatus,
    contentDir: row.content_dir,
    sealedTreeHash: row.sealed_tree_hash,
    baselineFromGenerationId:
      row.baseline_from_generation_id as GenerationId | null,
    fallbackReason: row.fallback_reason,
    jobId: row.job_id as JobId | null,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}

/** Field → column map for `setStatus`'s patch. Closed set, never user input. */
const PATCH_COLUMNS: Readonly<Record<string, string>> = {
  cacheKey: "cache_key",
  repoId: "repo_id",
  projectId: "project_id",
  commitSha: "commit_sha",
  comparisonBaseSha: "comparison_base_sha",
  kind: "kind",
  scopeHash: "scope_hash",
  configHash: "config_hash",
  promptTemplateVersion: "prompt_template_version",
  preferencesVersion: "preferences_version",
  upstreamVersion: "upstream_version",
  contentDir: "content_dir",
  sealedTreeHash: "sealed_tree_hash",
  baselineFromGenerationId: "baseline_from_generation_id",
  fallbackReason: "fallback_reason",
  jobId: "job_id",
  createdAt: "created_at",
  publishedAt: "published_at",
};

function encodeValue(value: unknown): unknown {
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return value;
}

/** `GenerationsRepo` — the only SQL that touches `generations`. */
export function createGenerationsRepo(db: Database): GenerationsRepo {
  const byCacheKeyStmt = db.raw.prepare(
    `${SELECT_COLUMNS} WHERE cache_key = ?`,
  );
  const byIdStmt = db.raw.prepare(`${SELECT_COLUMNS} WHERE generation_id = ?`);
  const insertStmt = db.raw.prepare(
    `INSERT INTO generations (generation_id, cache_key, repo_id, commit_sha,
       comparison_base_sha, kind, scope_hash, config_hash, prompt_template_version,
       preferences_version, upstream_version, status, content_dir, sealed_tree_hash,
       baseline_from_generation_id, fallback_reason, project_id, job_id, created_at,
       published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const listByProjectStmt = db.raw.prepare(
    `${SELECT_COLUMNS} WHERE project_id = ?
     ORDER BY created_at DESC, generation_id DESC`,
  );

  const one = (row: unknown): GenerationRecord | null =>
    row === undefined ? null : toRecord(row as GenerationRow);

  return {
    byCacheKey(key: string): GenerationRecord | null {
      return one(byCacheKeyStmt.get(key));
    },
    byId(id: GenerationId): GenerationRecord | null {
      return one(byIdStmt.get(id));
    },
    latestPublished(
      repoId: RepoId,
      opts?: { kind?: GenerationKind; before?: string },
    ): GenerationRecord | null {
      const conditions = ["repo_id = ?", "status = 'published'"];
      const values: unknown[] = [repoId];
      if (opts?.kind !== undefined) {
        conditions.push("kind = ?");
        values.push(opts.kind);
      }
      if (opts?.before !== undefined) {
        conditions.push("COALESCE(published_at, created_at) < ?");
        values.push(opts.before);
      }
      const sql = `${SELECT_COLUMNS} WHERE ${conditions.join(" AND ")}
        ORDER BY COALESCE(published_at, created_at) DESC, generation_id DESC
        LIMIT 1`;
      return one(db.raw.prepare(sql).get(...values));
    },
    insertPublished(rec: NewGeneration): void {
      insertStmt.run(
        rec.generationId,
        rec.cacheKey,
        rec.repoId,
        rec.commitSha,
        rec.comparisonBaseSha,
        rec.kind,
        rec.scopeHash,
        rec.configHash,
        rec.promptTemplateVersion,
        rec.preferencesVersion,
        rec.upstreamVersion,
        rec.status,
        rec.contentDir,
        rec.sealedTreeHash,
        rec.baselineFromGenerationId,
        rec.fallbackReason,
        rec.projectId,
        rec.jobId,
        rec.createdAt,
        rec.publishedAt,
      );
    },
    setStatus(
      id: GenerationId,
      status: GenerationStatus,
      patch?: Record<string, unknown>,
    ): void {
      const assignments = ["status = ?"];
      const values: unknown[] = [status];
      for (const [field, column] of Object.entries(PATCH_COLUMNS)) {
        const value = patch?.[field];
        if (value === undefined) {
          continue;
        }
        assignments.push(`${column} = ?`);
        values.push(encodeValue(value));
      }
      const sql = `UPDATE generations SET ${assignments.join(", ")} WHERE generation_id = ?`;
      db.raw.prepare(sql).run(...values, id);
    },
    listByProject(projectId: ProjectId): GenerationRecord[] {
      return (listByProjectStmt.all(projectId) as GenerationRow[]).map(
        toRecord,
      );
    },
  };
}
