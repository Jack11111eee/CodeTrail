import type { Database } from "../contracts/index.js";
import { databaseClock } from "./db.js";

/**
 * Migration 1 — the normative DDL of architecture §13.2, reproduced verbatim.
 *
 * Every statement is `IF NOT EXISTS`, so replaying a migration against an
 * already-migrated file is a no-op; the `migrations` bookkeeping table makes
 * the same guarantee explicit.
 */
const MIGRATION_1_SQL = `
CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS repos (
  repo_id TEXT PRIMARY KEY, identity TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
  mirror_path TEXT NOT NULL, remote_url TEXT, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repos(repo_id),
  kind TEXT NOT NULL, display_name TEXT NOT NULL, remote_url TEXT,
  default_branch TEXT, scope_json TEXT NOT NULL, watch_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, deleted_at TEXT);
CREATE INDEX IF NOT EXISTS idx_projects_repo ON projects(repo_id);

CREATE TABLE IF NOT EXISTS snapshots (
  repo_id TEXT NOT NULL, commit_sha TEXT NOT NULL, tree_hash TEXT NOT NULL,
  worktree_path TEXT NOT NULL, resolved_at TEXT NOT NULL, PRIMARY KEY (repo_id, commit_sha));

CREATE TABLE IF NOT EXISTS generations (
  generation_id TEXT PRIMARY KEY, cache_key TEXT NOT NULL UNIQUE, repo_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  comparison_base_sha TEXT,                       -- set iff kind='comparison'
  kind TEXT NOT NULL DEFAULT 'research',          -- research | change | comparison
  scope_hash TEXT NOT NULL, config_hash TEXT NOT NULL,
  prompt_template_version TEXT NOT NULL, preferences_version INTEGER NOT NULL,
  upstream_version TEXT NOT NULL, status TEXT NOT NULL,
  content_dir TEXT NOT NULL, sealed_tree_hash TEXT,
  baseline_from_generation_id TEXT, fallback_reason TEXT,
  project_id TEXT, job_id TEXT, created_at TEXT NOT NULL, published_at TEXT);
CREATE INDEX IF NOT EXISTS idx_generations_repo ON generations(repo_id, commit_sha);
CREATE INDEX IF NOT EXISTS idx_generations_status ON generations(status);
CREATE INDEX IF NOT EXISTS idx_generations_kind ON generations(kind, status);

CREATE TABLE IF NOT EXISTS lessons (
  lesson_id TEXT PRIMARY KEY, generation_id TEXT NOT NULL REFERENCES generations(generation_id),
  kind TEXT NOT NULL,                      -- research | change | comparison (Appendix B14)
  title TEXT NOT NULL, rel_path TEXT NOT NULL,
  json_sha256 TEXT NOT NULL, published_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_lessons_generation ON lessons(generation_id);

CREATE TABLE IF NOT EXISTS sources (
  generation_id TEXT NOT NULL, source_id TEXT NOT NULL, kind TEXT NOT NULL,
  commit_sha TEXT NOT NULL,            -- per-source; ≠ generation.commit_sha in comparisons
  payload_json TEXT NOT NULL, content_hash TEXT NOT NULL,
  PRIMARY KEY (generation_id, source_id));
CREATE INDEX IF NOT EXISTS idx_sources_commit ON sources(generation_id, commit_sha);

CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY, generation_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL, last_active_at TEXT NOT NULL, summary_json TEXT);
CREATE INDEX IF NOT EXISTS idx_conversations_gens
  ON conversations(generation_ids_json);
-- Revision 2: the previous UNIQUE(generation_ids_json, created_at) was effectively
-- non-unique (created_at always differs) and implied a dedupe that does not exist.
-- Conversations are never deduped: two identical POSTs create two conversations, and the
-- only invariant AC-QA-01 needs is that generation_ids_json never changes after insert.

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL,
  -- P0-B: these three columns are what makes refresh-restore lossless. Without them
  -- AC-QA-04 (same messages after restart), AC-QA-14 (unknown + reason) and AC-QA-11
  -- (incomplete:true) were true only in memory.
  answer_phase TEXT NOT NULL DEFAULT 'complete',
  unknown_reason TEXT,
  incomplete INTEGER NOT NULL DEFAULT 0,
  citations_json TEXT, selection_json TEXT, check_json TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_streaming ON messages(conversation_id) WHERE status = 'streaming';

CREATE TABLE IF NOT EXISTS conversation_selections (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL,
  lesson_id TEXT, module_id TEXT, source_id TEXT, code_location_json TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_selections_conversation ON conversation_selections(conversation_id);

CREATE TABLE IF NOT EXISTS change_events (
  event_id TEXT PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, repo_id TEXT NOT NULL,
  project_id TEXT NOT NULL, stream_id TEXT NOT NULL, stream_kind TEXT NOT NULL,
  kind TEXT NOT NULL, base_sha TEXT, head_sha TEXT, merge_base_sha TEXT, base_context_sha TEXT,
  significance TEXT NOT NULL DEFAULT 'full', state TEXT NOT NULL,
  job_id TEXT, gap_reason TEXT,
  linked_event_id TEXT REFERENCES change_events(event_id),   -- §12.7 merge linkage
  link_relation TEXT,                                        -- identical_content|supplementary|unlinked_squash
  discovered_at TEXT NOT NULL, published_at TEXT,
  payload_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_events_project ON change_events(project_id, discovered_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_stream ON change_events(stream_id, state);
CREATE INDEX IF NOT EXISTS idx_events_linked ON change_events(linked_event_id);

CREATE TABLE IF NOT EXISTS watch_cursors (
  repo_id TEXT NOT NULL, stream_id TEXT NOT NULL, kind TEXT NOT NULL,
  cursor_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (repo_id, stream_id, kind));

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
  repo_id TEXT NOT NULL, project_id TEXT, stream_id TEXT, state TEXT NOT NULL,
  payload_json TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
  error_code TEXT, error_detail TEXT, progress_json TEXT, output_generation_id TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_stream_running ON jobs(stream_id)
  WHERE state IN ('running','cancelling') AND stream_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS job_attempts (
  job_id TEXT NOT NULL REFERENCES jobs(job_id), attempt INTEGER NOT NULL,
  state TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, usage_id TEXT,
  PRIMARY KEY (job_id, attempt));

CREATE TABLE IF NOT EXISTS usage_records (
  usage_id TEXT PRIMARY KEY, job_id TEXT, conversation_id TEXT, kind TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL, calls INTEGER NOT NULL,
  cost_cents INTEGER, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS learner_preferences (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS preference_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS reading_positions (
  generation_id TEXT NOT NULL, lesson_id TEXT NOT NULL, conversation_id TEXT,
  offset INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (generation_id, lesson_id));

CREATE TABLE IF NOT EXISTS terms (
  term_id TEXT PRIMARY KEY, zh TEXT NOT NULL, en TEXT NOT NULL, symbols_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS term_links (
  term_id TEXT NOT NULL, generation_id TEXT NOT NULL, source_id TEXT NOT NULL,
  PRIMARY KEY (term_id, generation_id, source_id));
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
-- Single row 'model' holds ModelSettings. It is deliberately NOT in learner_preferences:
-- preferences belong to the learner (and feed preferences_version), settings belong to the
-- deployment (and feed config_hash). PUT /api/settings/model rewrites this row; because
-- GenerationConfig.model is part of computeConfigHash, every subsequent job gets a new
-- config_hash → new dedupe_key → new cache_key (Appendix B, B5).
`;

/** The ordered migration list. Migration 1 is the complete schema. */
export const MIGRATIONS: readonly { version: number; sql: string }[] = [
  { version: 1, sql: MIGRATION_1_SQL },
  { version: 2, sql: "ALTER TABLE lessons ADD COLUMN deleted_at TEXT;" },
  {
    version: 3,
    sql: `CREATE TABLE learning_topics (
    topic_id TEXT PRIMARY KEY, generation_id TEXT NOT NULL REFERENCES generations(generation_id),
    conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(conversation_id), title TEXT,
    auto_title INTEGER NOT NULL DEFAULT 1, first_question TEXT, lesson_message_id TEXT REFERENCES messages(message_id),
    state TEXT NOT NULL DEFAULT 'draft', error_detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
    CREATE INDEX idx_learning_topics_generation ON learning_topics(generation_id, created_at);`,
  },
];

const CREATE_MIGRATIONS_TABLE =
  "CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)";
const SELECT_VERSION =
  "SELECT COALESCE(MAX(version), 0) AS version FROM migrations";
const INSERT_VERSION =
  "INSERT INTO migrations (version, applied_at) VALUES (?, ?)";

/**
 * Apply every migration whose version is greater than the recorded maximum.
 *
 * Returns the number of migrations applied and the resulting schema version.
 * A second call against an up-to-date file applies nothing and returns
 * `{ applied: 0, version: 3 }`.
 */
export function migrate(db: Database): { applied: number; version: number } {
  db.raw.exec(CREATE_MIGRATIONS_TABLE);

  let applied = 0;
  for (const migration of MIGRATIONS) {
    const row = db.raw.prepare(SELECT_VERSION).get() as { version: number };
    if (migration.version <= row.version) {
      continue;
    }
    const appliedAt = databaseClock(db).now().toISOString();
    db.transaction(() => {
      db.raw.exec(migration.sql);
      db.raw.prepare(INSERT_VERSION).run(migration.version, appliedAt);
    });
    applied += 1;
  }

  const finalRow = db.raw.prepare(SELECT_VERSION).get() as { version: number };
  return { applied, version: finalRow.version };
}
