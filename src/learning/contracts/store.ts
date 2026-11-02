import type { TermView, UsageKind, UsageView } from "./api.js";
import type {
  ChangeEventKind,
  ChangeEventPayload,
  ChangeEventState,
  Significance,
  StreamKind,
} from "./change.js";
import type { CursorJson, CursorKind, CursorUpdate } from "./cursor.js";
import type { JobErrorCode } from "./errors.js";
import type {
  ChangeEventId,
  ConversationId,
  GenerationId,
  JobId,
  LessonId,
  MessageId,
  ProjectId,
  RepoId,
  SourceId,
  TermId,
} from "./ids.js";
import type { JobAttemptState, JobKind, JobProgress, JobState } from "./job.js";
import type { LessonChecks, LessonKind } from "./lesson.js";
import type { QaSelection } from "./ports.js";
import type { GenerationConfig, RepoIdentity, RepoKind } from "./refs.js";
import type { NormalizedScope } from "./scope.js";
import type { SourceKind } from "./sources.js";

// ── generations ─────────────────────────────────────────────────────────────
export type GenerationStatus = "staged" | "published" | "failed" | "superseded";
export type GenerationKind = "research" | "change" | "comparison";

export interface GenerationRecord {
  generationId: GenerationId;
  cacheKey: string;
  repoId: RepoId;
  projectId: ProjectId | null;
  commitSha: string;
  comparisonBaseSha: string | null;
  kind: GenerationKind;
  scopeHash: string;
  configHash: string;
  promptTemplateVersion: string;
  preferencesVersion: number;
  upstreamVersion: string;
  status: GenerationStatus;
  contentDir: string;
  sealedTreeHash: string | null;
  baselineFromGenerationId: GenerationId | null;
  fallbackReason: string | null;
  jobId: JobId | null;
  createdAt: string;
  publishedAt: string | null;
}
export type NewGeneration = GenerationRecord;

// ── jobs ────────────────────────────────────────────────────────────────────
export interface JobRecord {
  jobId: JobId;
  dedupeKey: string;
  kind: JobKind;
  repoId: RepoId;
  projectId: ProjectId | null;
  streamId: string | null;
  state: JobState;
  payload: JobPayload;
  attempt: number;
  errorCode: JobErrorCode | null;
  errorDetail: string | null;
  progress: JobProgress | null;
  outputGenerationId: GenerationId | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export type NewJob = JobRecord;

export type JobPayload = GenerationPayload | ChangePayload | ComparisonPayload;

export interface GenerationPayload {
  kind: "generation";
  mode: "init" | "update";
  ref: string;
  commitSha: string;
  baseContextSha: string | null;
  scope: NormalizedScope;
  config: GenerationConfig;
  baselineFromGenerationId: GenerationId | null;
}

export interface ChangePayload {
  kind: "change";
  eventId: ChangeEventId;
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  streamKind: StreamKind;
}

export interface ComparisonPayload {
  kind: "comparison";
  baseSha: string;
  headSha: string;
  scope: NormalizedScope;
  config: GenerationConfig;
}

export interface JobAttemptRecord {
  jobId: JobId;
  attempt: number;
  state: JobAttemptState;
  startedAt: string;
  finishedAt: string | null;
  usageId: string | null;
}

// ── lessons / sources ───────────────────────────────────────────────────────
export interface LessonRow {
  lessonId: LessonId;
  generationId: GenerationId;
  kind: LessonKind;
  title: string;
  relPath: string;
  jsonSha256: string;
  publishedAt: string;
}

export interface SourceRow {
  generationId: GenerationId;
  sourceId: SourceId;
  kind: SourceKind;
  /** Per-source; differs from generation.commit_sha only in comparisons. */
  commitSha: string;
  payloadJson: string;
  contentHash: string;
}

// ── change events ───────────────────────────────────────────────────────────
export type LinkRelation =
  "identical_content" | "supplementary" | "unlinked_squash";

export interface ChangeRecord {
  eventId: ChangeEventId;
  eventKey: string;
  repoId: RepoId;
  projectId: ProjectId;
  streamId: string;
  streamKind: StreamKind;
  kind: ChangeEventKind;
  baseSha: string | null;
  headSha: string | null;
  mergeBaseSha: string | null;
  baseContextSha: string | null;
  significance: Significance;
  state: ChangeEventState;
  jobId: JobId | null;
  gapReason: string | null;
  linkedEventId: ChangeEventId | null;
  linkRelation: LinkRelation | null;
  discoveredAt: string;
  publishedAt: string | null;
  payload: ChangeEventPayload;
}
export type NewChangeEvent = ChangeRecord;

// ── conversations ───────────────────────────────────────────────────────────
export type MessageRole = "user" | "assistant";
/** PRD §4 table vocabulary. The stream-time "generating" state is `AnswerPhase`. */
export type MessageStatus = "streaming" | "complete" | "failed" | "cancelled";
export type AnswerPhase =
  "generating" | "checking" | "complete" | "failed" | "cancelled";

export interface Citation {
  sourceId: SourceId;
  generationId: GenerationId;
  commitSha: string;
  label: string;
}

export interface MessageRecord {
  messageId: MessageId;
  conversationId: ConversationId;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  answerPhase: AnswerPhase;
  citations: Citation[];
  selection: QaSelection | null;
  checks: LessonChecks | null;
  unknownReason: string | null;
  incomplete: boolean;
  createdAt: string;
}

export interface SelectionRecord {
  id: number;
  conversationId: ConversationId;
  lessonId: LessonId | null;
  moduleId: string | null;
  sourceId: SourceId | null;
  codeLocation: { path: string; lines: { start: number; end: number } } | null;
  createdAt: string;
}

export interface ReadingPosition {
  generationId: GenerationId;
  lessonId: LessonId;
  conversationId: ConversationId | null;
  offset: number;
  updatedAt: string;
}

export interface LearnerPreferences {
  explainLevel: "plain_first" | "technical_first";
  /** 自述基础; never converted into a score. */
  background: string | null;
  language: "zh";
  version: number;
}

// ── projects / repos / conversations ────────────────────────────────────────
export interface RepoRecord {
  repoId: RepoId;
  identity: RepoIdentity;
  kind: RepoKind;
  mirrorPath: string;
  remoteUrl: string | null;
  createdAt: string;
}
/** Insert shape. Identical to the row because every column is supplied by the caller. */
export type NewRepoRecord = RepoRecord;

export interface ProjectRecord {
  projectId: ProjectId;
  repoId: RepoId;
  kind: RepoKind;
  displayName: string;
  remoteUrl: string | null;
  defaultBranch: string | null;
  /** Stored as scope_json. */
  scope: NormalizedScope;
  watchEnabled: boolean;
  createdAt: string;
  deletedAt: string | null;
}
export type NewProjectRecord = ProjectRecord;

/** A rolling summary of a conversation (PRD §9: summaries carry their sources). */
export interface ConversationSummary {
  text: string;
  sources: SourceId[];
  unresolved: string[];
}

export interface ConversationRecord {
  conversationId: ConversationId;
  generationIds: GenerationId[];
  createdAt: string;
  lastActiveAt: string;
  /** Stored as summary_json. */
  summary: ConversationSummary | null;
}

// ── repository interfaces — the ONLY SQL owners, implemented by store/*.repo.ts ──
export interface ReposRepo {
  byIdentity(identity: RepoIdentity): RepoRecord | null;
  /** UNIQUE(identity) ⇒ reuse, never duplicate. */
  upsert(rec: NewRepoRecord): RepoRecord;
  byId(id: RepoId): RepoRecord | null;
}

export interface ProjectsRepo {
  insert(rec: NewProjectRecord): void;
  /** Includes soft-deleted rows. */
  byId(id: ProjectId): ProjectRecord | null;
  /** deleted_at IS NULL only. */
  list(): ProjectRecord[];
  setWatch(
    id: ProjectId,
    enabled: boolean,
    scope: NormalizedScope | null,
  ): void;
  markDeleted(id: ProjectId, at: string): void;
  liveProjectForRepo(repoId: RepoId): ProjectRecord | null;
}

export interface SnapshotsRepo {
  byCommit(repoId: RepoId, sha: string): SnapshotRecord | null;
  /** PK(repo_id, commit_sha). */
  upsert(rec: SnapshotRecord): void;
  /** Used by gc --reclaim-removed-projects. */
  referencedByPublished(sha: string): boolean;
}

export interface JobsRepo {
  /** Conflict on dedupe_key. */
  insert(job: NewJob): void;
  byDedupeKey(key: string): JobRecord | null;
  byId(id: JobId): JobRecord | null;
  transition(
    id: JobId,
    from: JobState[],
    to: JobState,
    patch?: Partial<JobRecord>,
  ): boolean;
  listByState(states: JobState[]): JobRecord[];
  listByStream(streamId: string): JobRecord[];
  listByProject(projectId: ProjectId, states: JobState[]): JobRecord[];
  bumpAttempt(id: JobId): number;
}

export interface AttemptsRepo {
  open(jobId: JobId, attempt: number, at: string): void;
  close(
    jobId: JobId,
    attempt: number,
    state: JobAttemptState,
    at: string,
    usageId: string | null,
  ): void;
  list(jobId: JobId): JobAttemptRecord[];
}

export interface GenerationsRepo {
  byCacheKey(key: string): GenerationRecord | null;
  byId(id: GenerationId): GenerationRecord | null;
  latestPublished(
    repoId: RepoId,
    opts?: { kind?: GenerationKind; before?: string },
  ): GenerationRecord | null;
  /** Publish transaction only. */
  insertPublished(rec: NewGeneration): void;
  setStatus(
    id: GenerationId,
    status: GenerationStatus,
    patch?: Record<string, unknown>,
  ): void;
  listByProject(projectId: ProjectId): GenerationRecord[];
}

export interface LessonsRepo {
  /** Publish transaction only. */
  insertMany(rows: LessonRow[]): void;
  listByGeneration(gid: GenerationId): LessonRow[];
  byId(gid: GenerationId, lessonId: LessonId): LessonRow | null;
}

export interface SourcesRepo {
  /** Publish transaction only. */
  insertMany(rows: SourceRow[]): void;
  all(gid: GenerationId): SourceRow[];
  get(gid: GenerationId, sourceId: SourceId): SourceRow | null;
}

export interface ConversationsRepo {
  insert(rec: {
    conversationId: ConversationId;
    generationIds: GenerationId[];
    at: string;
  }): void;
  byId(id: ConversationId): ConversationRecord | null;
  touch(id: ConversationId, at: string): void;
  insertMessage(m: MessageRecord): void;
  updateMessage(id: MessageId, patch: Partial<MessageRecord>): void;
  messages(
    id: ConversationId,
    opts?: { limit?: number; before?: string },
  ): MessageRecord[];
  addSelection(sel: Omit<SelectionRecord, "id">): SelectionRecord;
  selections(id: ConversationId): SelectionRecord[];
  countByProject(projectId: ProjectId): number;
  /**
   * Boot-time normalisation: every row left in status='streaming' becomes
   * status='cancelled', answer_phase='cancelled'. Returns the number of rows changed.
   */
  cancelStreaming(): number;
}

export interface CursorsRepo {
  get(repoId: RepoId, streamId: string, kind: CursorKind): CursorJson | null;
  /** Compare-and-swap: returns false when expectedPrevious does not match. */
  put(update: CursorUpdate): boolean;
}

export interface ChangesRepo {
  insertMany(events: NewChangeEvent[]): void;
  page(
    projectId: ProjectId,
    cursor: string | null,
    limit: number,
  ): { items: ChangeRecord[]; next: string | null };
  byId(id: ChangeEventId): ChangeRecord | null;
  setState(
    id: ChangeEventId,
    state: ChangeEventState,
    patch?: Partial<ChangeRecord>,
  ): void;
  /** Publish transaction only (§12.7). */
  link(i: {
    prEventId: ChangeEventId;
    defaultBranchEventId: ChangeEventId;
    relation: LinkRelation;
  }): void;
  countByProject(projectId: ProjectId): number;
  listByStream(streamId: string, states: ChangeEventState[]): ChangeRecord[];
}

export interface UsageRepo {
  insert(rec: UsageRecord): void;
  groupByKind(kind?: UsageKind): UsageView["groups"];
}

export interface PreferencesRepo {
  get(): LearnerPreferences;
  /** Bumps version + preference_meta. */
  put(patch: Partial<LearnerPreferences>): LearnerPreferences;
  version(): number;
  readingPositions(): ReadingPosition[];
  putReadingPosition(pos: ReadingPosition): void;
}

export interface SettingsRepo {
  /** app_settings key='model'. */
  model(): ModelSettings | null;
  putModel(s: ModelSettings): void;
}

export interface TermsRepo {
  list(q?: string): TermView[];
  byId(id: TermId): TermView | null;
  linkTerm(i: {
    termId: TermId;
    generationId: GenerationId;
    sourceId: SourceId;
  }): void;
}

// ── snapshots / usage / settings ────────────────────────────────────────────
export interface SnapshotRecord {
  repoId: RepoId;
  commitSha: string;
  treeHash: string;
  worktreePath: string;
  resolvedAt: string;
}

export interface UsageRecord {
  usageId: string;
  jobId: JobId | null;
  conversationId: ConversationId | null;
  kind: UsageKind;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  costCents: number | null;
  createdAt: string;
}

/** Persisted in app_settings(key='model'). */
export interface ModelSettings {
  provider: string;
  model: string;
  maxOutputTokens: number;
  temperature: number;
  pricing: { inputCentsPerMTok: number; outputCentsPerMTok: number } | null;
  quota: { maxCalls: number; maxInputTokens: number; maxOutputTokens: number };
}
