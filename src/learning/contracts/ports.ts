import type { LearningTopicsRepo } from "./topics.js";
import type { GenerationConfig } from "./refs.js";
import type { UsageKind } from "./api.js";
import type { CursorUpdate } from "./cursor.js";
import { LearningError } from "./errors.js";
import type { HttpErrorCode } from "./errors.js";
import type { Database, DataPaths, ModelHandle } from "./foundation.js";
import type { DiscoveryService, GithubClient } from "./github.js";
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
} from "./ids.js";
import type { JobKind, JobProgress, JobState } from "./job.js";
import type { CheckStatus, LessonChecks } from "./lesson.js";
import type {
  BuildChangeLessonInput,
  BuildComparisonLessonInput,
  BuildLessonsInput,
  BuildLessonsResult,
} from "./lessonbuild.js";
import type { CoverageReport, NormalizedScope } from "./scope.js";
import type {
  ExternalSourceRef,
  RepoSourceRef,
  SourceGap,
  SourceRef,
  TeachingExampleRef,
} from "./sources.js";
import type {
  AnswerPhase,
  AttemptsRepo,
  ChangePayload,
  ChangesRepo,
  Citation,
  ComparisonPayload,
  ConversationsRepo,
  CursorsRepo,
  GenerationKind,
  GenerationPayload,
  GenerationsRepo,
  JobRecord,
  JobsRepo,
  LessonRow,
  LessonsRepo,
  LinkRelation,
  MessageRecord,
  PreferencesRepo,
  ProjectsRepo,
  ReadingPosition,
  ReposRepo,
  SelectionRecord,
  SettingsRepo,
  SnapshotRecord,
  SnapshotsRepo,
  SourceRow,
  SourcesRepo,
  TermsRepo,
  UsageRepo,
} from "./store.js";
import type { UpstreamGenerationPort } from "./upstream.js";

// ── primitives ──────────────────────────────────────────────────────────────
export interface Clock {
  now(): Date;
  set(iso: string): void;
  advance(ms: number): void;
}

export interface SnapshotReader {
  readonly repoId: RepoId;
  readonly commitSha: string;
  readonly treeHash: string;
  /** assertReadable + symlink check inside. */
  read(relPath: string): Promise<string>;
  exists(relPath: string): Promise<boolean>;
  slice(
    relPath: string,
    lines: { start: number; end: number },
  ): Promise<string>;
  list(scope: NormalizedScope): Promise<{ path: string; bytes: number }[]>;
}

export interface SourceReader {
  readRepo(ref: RepoSourceRef, scope: NormalizedScope): Promise<string>;
  readExternal(ref: ExternalSourceRef): Promise<string>;
}

export interface QaSelection {
  lessonId?: LessonId;
  moduleId?: string;
  sourceId?: SourceId;
  /** Every evidence id bound to the clicked node (AC-UI-04). */
  sourceIds?: SourceId[];
  /** The generation's analysed commit, never the repository's latest head. */
  commitSha?: string;
  codeLocation?: { path: string; lines: { start: number; end: number } };
}

export interface ContextBudget {
  maxInputTokens: number;
  reserveOutputTokens: number;
}

export interface ToolBudget {
  readonly maxToolCalls: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly used: { calls: number; inputTokens: number; outputTokens: number };
  canCall(): boolean;
  consume(c: { inputTokens: number; outputTokens: number }): void;
  exhausted(): boolean;
}

export interface GithubCredential {
  kind: "token";
  token: string;
  login: string | null;
}

export interface JobEvent {
  jobId: JobId;
  seq: number;
  type: "state" | "progress" | "log";
  state?: JobState;
  progress?: JobProgress;
  message?: string;
  at: string;
}

// ── usage accounting ────────────────────────────────────────────────────────
export interface UsageMeter {
  record(i: {
    kind: UsageKind;
    jobId: JobId | null;
    conversationId: ConversationId | null;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    calls: number;
    costCents: number | null;
  }): void;
  /**
   * Pre-flight quota gate. `false` ⇒ the caller MUST fail with `budget_exhausted`
   * before issuing any provider request. Pure: never mutates counters.
   */
  canSpend(i: {
    kind: UsageKind;
    estimatedCalls: number;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
  }): boolean;
  totals(kind?: UsageKind): {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costCents: number | null;
  };
}

// ── retrieval index cache seam ──────────────────────────────────────────────
export interface IndexCache {
  get(generationId: GenerationId, key: string): unknown;
  set(
    generationId: GenerationId,
    key: string,
    value: unknown,
    ttlMs?: number,
  ): void;
  clear(generationId?: GenerationId): void;
}

// ── snapshots (implemented by projects/snapshot.ts) ─────────────────────────
export interface SnapshotService {
  /** → sha. */
  resolve(repoId: RepoId, ref: string): Promise<string>;
  /** Reuse if present. */
  ensure(repoId: RepoId, sha: string): Promise<SnapshotRecord>;
  readFile(
    snap: SnapshotRecord,
    relPath: string,
    scope: NormalizedScope,
  ): Promise<string>;
  listFiles(
    snap: SnapshotRecord,
    scope: NormalizedScope,
  ): Promise<{ path: string; bytes: number }[]>;
  coverage(
    snap: SnapshotRecord,
    scope: NormalizedScope,
    generationId: GenerationId,
  ): Promise<CoverageReport>;
}

// ── jobs (implemented by api/jobs/runner.ts) ────────────────────────────────
export interface EnqueueJobInput {
  kind: JobKind;
  repoId: RepoId;
  projectId: ProjectId | null;
  /** null for generation_initial/update/comparison. */
  streamId: string | null;
  comparisonBaseSha: string | null;
  headSha: string;
  baseContextSha: string | null;
  scopeHash: string;
  analysisConfigHash: string;
  payload: GenerationPayload | ChangePayload | ComparisonPayload;
}

export interface JobRunner {
  /** Wake the durable queued-job dispatcher after a discovery transaction. */
  wake?(): void;
  /** Idempotent on dedupe_key. */
  enqueue(input: EnqueueJobInput): Promise<JobRecord>;
  get(jobId: JobId): Promise<JobRecord | null>;
  /** → cancelling (or cancelled if queued). */
  cancel(jobId: JobId): Promise<JobRecord>;
  /** failed|cancelled|interrupted only. */
  retry(jobId: JobId): Promise<JobRecord>;
  /** Boot: running/cancelling → interrupted. */
  recoverInterrupted(): Promise<number>;
  /** Tests: await the queue. */
  drain(): Promise<void>;
  /** Display only. */
  subscribe(jobId: JobId, cb: (e: JobEvent) => void): () => void;
}

// ── publish (implemented by api/jobs/publish.ts) ────────────────────────────
export interface SealedFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface SealManifest {
  schemaVersion: 1;
  generationId: GenerationId;
  treeHash: string;
  files: SealedFile[];
}

export interface BuildWorkspace {
  /** stagingPath(paths, jobId). */
  stagingDir: string;
  /** staging/<jobId>/tree (writable build worktree). */
  treeDir: string;
  /** staging/<jobId>/knowledge (staging knowledge root). */
  knowledgeDir: string;
  /** staging/<jobId>/knowledge/lessons. */
  lessonsDir: string;
}

export interface PublishCommit {
  manifest: SealManifest;
  generationId: GenerationId;
  jobId: JobId;
  /** research | change | comparison. */
  kind: GenerationKind;
  comparisonBaseSha: string | null;
  lessons: LessonRow[];
  sources: SourceRow[];
  changeEventId: ChangeEventId | null;
  /** §12.7 merge linkage, written in the same tx. */
  linkedEventId: ChangeEventId | null;
  linkRelation: LinkRelation | null;
  publishedCursor: CursorUpdate | null;
}

export interface GcReport {
  removedWorkspaces: string[];
  removedKnowledge: GenerationId[];
  keptPublished: number;
  keptInFlight: number;
  bytesFreed: number;
}

export interface Publisher {
  /** The ONLY constructor of build-area paths. */
  buildWorkspace(jobId: JobId): BuildWorkspace;
  seal(workspaceDir: string, generationId: GenerationId): Promise<SealManifest>;
  /** Rename + single transaction. */
  publishAtomic(input: PublishCommit): Promise<void>;
  gc(opts?: { reclaimRemovedProjects?: boolean }): Promise<GcReport>;
}

// ── watch scheduler (implemented by updates/watch.ts) ──────────────────────
export interface WatchTickResult {
  projectId: ProjectId;
  discovered: number;
  enqueued: number;
  gaps: number;
  lastPollAt: string;
}

export interface WatchScheduler {
  start(): void;
  stop(): void;
  /** → runWatchTick per project. */
  runTick(projectId?: ProjectId): Promise<WatchTickResult[]>;
  lastPollAt(projectId: ProjectId): string | null;
}

// ── retrieval (implemented by retrieval/*) ─────────────────────────────────
export interface Binding {
  generationId: GenerationId;
  repoId: RepoId;
  commitSha: string;
  /** Set only for a comparison generation: the source search then covers both commits. */
  comparisonBaseSha?: string | null;
}

export interface RetrievalHit {
  kind: "wiki" | "source";
  binding: Binding;
  page?: string;
  anchor?: string;
  path?: string;
  lines?: { start: number; end: number };
  preview: string;
  score?: number;
}

export interface Retriever {
  search(
    binding: Binding,
    query: string,
    opts?: { limit?: number; hints?: string[] },
  ): Promise<RetrievalHit[]>;
}

export interface SourceSearcher {
  search(
    snapshot: SnapshotReader,
    scope: NormalizedScope,
    terms: string[],
    opts?: { limit?: number },
  ): Promise<
    { path: string; lines: { start: number; end: number }; preview: string }[]
  >;
}

// ── evidence (implemented by evidence/registry.ts, evidence/external.ts) ────
export interface RegisterRepoSourceInput {
  generationId: GenerationId;
  repoId: RepoId;
  commitSha: string;
  path: string;
  lines: { start: number; end: number } | null;
  /** Read-only access bound to the generation commit. */
  snapshot: SnapshotReader;
  scope: NormalizedScope;
}

export interface SourceRegistry {
  registerRepo(input: RegisterRepoSourceInput): Promise<RepoSourceRef>;
  registerExternal(input: ExternalFetchResult): ExternalSourceRef;
  registerTeachingExample(input: {
    exampleId: string;
    label: string;
  }): TeachingExampleRef;
  get(generationId: GenerationId, sourceId: SourceId): SourceRef | null;
  all(generationId: GenerationId): SourceRef[];
  gaps(generationId: GenerationId): SourceGap[];
}

export interface ExternalFetchRequest {
  url: string;
  locator: string;
  expectedVersion?: string;
}

export type ExternalFetchResult =
  | {
      ok: true;
      canonicalUrl: string;
      versionOrRetrievedAt: string;
      locator: string;
      contentHash: string;
      title: string;
      text: string;
    }
  | {
      ok: false;
      status: "source_missing";
      reason:
        | "blocked_host"
        | "redirect_blocked"
        | "auth_required"
        | "paywalled"
        | "not_found"
        | "network"
        | "too_large"
        | "non_text";
    };

export interface ExternalDocService {
  fetchExact(req: ExternalFetchRequest): Promise<ExternalFetchResult>;
  cached(contentHash: string): Promise<string | null>;
}

// ── conversations and answers ───────────────────────────────────────────────
/**
 * Internal, record-shaped snapshot. NEVER sent over HTTP: the route maps it with
 * `toConversationView()` into `ConversationView`.
 */
export interface ConversationSnapshot {
  conversationId: ConversationId;
  generationIds: GenerationId[];
  createdAt: string;
  lastActiveAt: string;
  messages: MessageRecord[];
  selections: SelectionRecord[];
  readingPosition: ReadingPosition | null;
}

export interface ConversationService {
  create(i: {
    generationIds: GenerationId[];
    lessonId?: LessonId;
    moduleId?: string;
  }): Promise<ConversationSnapshot>;
  get(id: ConversationId): Promise<ConversationSnapshot | null>;
  appendUserMessage(
    id: ConversationId,
    text: string,
    selection: QaSelection | null,
  ): Promise<MessageRecord>;
  appendAssistantDelta(
    id: ConversationId,
    messageId: MessageId,
    text: string,
  ): void;
  setAnswerPhase(
    id: ConversationId,
    messageId: MessageId,
    phase: AnswerPhase,
  ): Promise<void>;
  /**
   * Persists every field of `MessageRecord` that the DDL carries, so a restart
   * restores `answerPhase` / `unknownReason` / `incomplete` verbatim.
   */
  finalizeMessage(
    id: ConversationId,
    messageId: MessageId,
    patch: {
      status: "complete" | "failed" | "cancelled";
      answerPhase: AnswerPhase;
      citations: Citation[];
      checks: LessonChecks | null;
      unknownReason: string | null;
      incomplete: boolean;
    },
  ): Promise<void>;
  addSelection(id: ConversationId, sel: QaSelection): Promise<SelectionRecord>;
}

export interface AnswerRequest {
  conversationId: ConversationId;
  text: string;
  selection: QaSelection | null;
  signal: AbortSignal;
  topic?: { title: string | null; suggestTitle: boolean; initial: boolean };
}

export type AnswerEvent =
  | { type: "topic_title"; title: string }
  | { type: "start"; messageId: MessageId }
  | { type: "delta"; text: string }
  | { type: "citation"; sourceId: SourceId; label: string; commitSha: string }
  | {
      type: "check";
      structural: CheckStatus;
      evidence: CheckStatus;
      semantic: CheckStatus;
    }
  | {
      type: "done";
      messageId: MessageId;
      status: "complete" | "failed" | "cancelled";
      incomplete: boolean;
      unknownReason?: string;
    }
  | { type: "error"; code: HttpErrorCode; message: string };

export interface AnswerService {
  answer(req: AnswerRequest): AsyncIterable<AnswerEvent>;
}

// ── session (implemented by api/auth.ts) ───────────────────────────────────
export interface SessionStore {
  /** 32 random bytes hex; 0600. */
  ensureToken(): Promise<string>;
  /** timingSafeEqual. */
  verify(candidate: string | undefined): boolean;
  /** HttpOnly; SameSite=Strict; Path=/. */
  cookieHeader(token: string): string;
  clearCookieHeader(): string;
}

// ── project removal (implemented by projects/removal.ts) ───────────────────
export type ProjectState = "active" | "removed" | "unknown";

export interface ProjectDependents {
  conversations: ConversationId[];
  lessons: LessonId[];
  generations: GenerationId[];
  changeEvents: ChangeEventId[];
}

export interface RemovalService {
  dependents(projectId: ProjectId): Promise<ProjectDependents>;
  remove(projectId: ProjectId, confirm: boolean): Promise<ProjectDependents>;
  state(projectId: ProjectId): ProjectState;
}

export function assertProjectActive(
  state: ProjectState,
  projectId: ProjectId,
): void {
  if (state === "removed") {
    throw new LearningError("source_removed", "项目已被移除", {
      reason: "project_removed",
      projectId,
    });
  }
  if (state === "unknown") {
    throw new LearningError("not_found", "项目不存在", { projectId });
  }
}

// ── deps roots (the DI surface; constructed once, in api/cli.ts) ────────────
export interface AppDeps {
  paths: DataPaths;
  clock: Clock;
  db: Database;
  repos: Repositories;
  jobRunner: JobRunner;
  publisher: Publisher;
  watch: WatchScheduler;
  snapshotService: SnapshotService;
  retriever: Retriever;
  conversations: ConversationService;
  answers: AnswerService;
  registry: SourceRegistry;
  external: ExternalDocService;
  model: ModelHandle | null;
  session: SessionStore;
  removal: RemovalService;
  usage: UsageMeter;
}

export interface Repositories {
  projects: ProjectsRepo;
  repos: ReposRepo;
  snapshots: SnapshotsRepo;
  generations: GenerationsRepo;
  lessons: LessonsRepo;
  topics: LearningTopicsRepo;
  sources: SourcesRepo;
  conversations: ConversationsRepo;
  changes: ChangesRepo;
  cursors: CursorsRepo;
  jobs: JobsRepo;
  attempts: AttemptsRepo;
  usage: UsageRepo;
  prefs: PreferencesRepo;
  settings: SettingsRepo;
  terms: TermsRepo;
}

export interface JobRunnerDeps {
  /** Resolve a provider from the configuration captured by the submitted job. */
  modelForConfig?(config: GenerationConfig): ModelHandle;
  db: Database;
  repos: Repositories;
  paths: DataPaths;
  clock: Clock;
  snapshotService: SnapshotService;
  publisher: Publisher;
  upstream: UpstreamGenerationPort;
  lessons: LessonBuilderPort;
  model: ModelHandle | null;
  usage: UsageMeter;
  registry: SourceRegistry;
  external: ExternalDocService;
}

export interface WatchDeps {
  db: Database;
  repos: Repositories;
  clock: Clock;
  github: GithubClient;
  discovery: DiscoveryService;
  jobRunner: JobRunner;
  intervalMs: number;
}

export interface AnswerDeps {
  db: Database;
  repos: Repositories;
  clock: Clock;
  model: ModelHandle | null;
  retriever: Retriever;
  registry: SourceRegistry;
  snapshotService: SnapshotService;
  external: ExternalDocService;
  conversations: ConversationService;
}

export interface LessonBuilderPort {
  buildResearchLessons(i: BuildLessonsInput): Promise<BuildLessonsResult>;
  buildChangeLesson(i: BuildChangeLessonInput): Promise<BuildLessonsResult>;
  buildComparisonLesson(
    i: BuildComparisonLessonInput,
  ): Promise<BuildLessonsResult>;
}

// ── HTTP route plumbing ────────────────────────────────────────────────────
export type AuthMode = "public" | "session";

export type RouteHandlerKey =
  | "health"
  | "bootstrap"
  | "projects.create"
  | "projects.list"
  | "projects.get"
  | "projects.dependents"
  | "projects.delete"
  | "analyses.create"
  | "comparisons.create"
  | "jobs.get"
  | "jobs.events"
  | "jobs.cancel"
  | "jobs.retry"
  | "generations.lessons"
  | "generations.lesson"
  | "generations.lesson.delete"
  | "generations.lesson.restore"
  | "topics.create"
  | "topics.get"
  | "topics.messages"
  | "topics.delete"
  | "topics.restore"
  | "generations.source"
  | "generations.coverage"
  | "conversations.create"
  | "conversations.get"
  | "conversations.messages"
  | "conversations.post"
  | "watch.put"
  | "changes.list"
  | "changes.get"
  | "preferences.get"
  | "preferences.put"
  | "terms.list"
  | "terms.get"
  | "settings.model.get"
  | "settings.model.put"
  | "settings.model.test"
  | "usage.get"
  | "storage.get";

export interface RouteDef {
  method: "GET" | "POST" | "PUT" | "DELETE";
  pattern: string;
  auth: AuthMode;
  handler: RouteHandlerKey;
}

export interface RouteRequest {
  params: Readonly<Record<string, string>>;
  query: Readonly<Record<string, string>>;
  /** Parsed + schema-validated before the handler runs. */
  body: unknown;
  headers: Readonly<Record<string, string | undefined>>;
  signal: AbortSignal;
}

export type RouteResponse =
  | {
      kind: "json";
      status: number;
      body: unknown;
      headers?: Record<string, string>;
    }
  | { kind: "sse"; events: AsyncIterable<unknown> }
  | { kind: "empty"; status: number; headers?: Record<string, string> };

export type HandlerFactory = (
  deps: AppDeps,
) => (req: RouteRequest) => Promise<RouteResponse>;

export interface RouteModule {
  readonly id:
    | "projects"
    | "jobs"
    | "generations"
    | "conversations"
    | "prefs"
    | "terms"
    | "settings"
    | "ops"
    | "changes"
    | "topics";
  readonly routes: readonly RouteDef[];
  readonly handlers: Partial<Record<RouteHandlerKey, HandlerFactory>>;
}

/**
 * Typed seam between the HTTP core and the server-rendered UI. Declared here so
 * `ServerOptions` can name it without importing `ui/`.
 */
export interface StaticUiSeam {
  readonly routes: readonly { method: "GET"; pattern: string }[];
  handle(req: RouteRequest): Promise<RouteResponse | null>;
}

/**
 * `api/server.ts` re-exports this type and implements `createLearningServer`.
 * It lives here so `ui?: StaticUiSeam` can be named without importing `ui/`.
 */
export interface ServerOptions {
  paths: DataPaths;
  port: number;
  clock: Clock;
  deps: AppDeps;
  ui?: StaticUiSeam;
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}
