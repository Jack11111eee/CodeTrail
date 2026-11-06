import type { LearningTopic, LearningTopicView } from "./topics.js";
import type {
  ChangeEventKind,
  ChangeEventPayload,
  ChangeEventState,
  Significance,
  StreamKind,
} from "./change.js";
import type { JobErrorCode, SourceStatus } from "./errors.js";
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
import type { JobKind, JobProgress, JobState } from "./job.js";
import type {
  ChangeLesson,
  ComparisonLesson,
  Lesson,
  LessonKind,
  RenderDiagram,
} from "./lesson.js";
import type { QaSelection } from "./ports.js";
import type { GenerationConfig, RepoKind } from "./refs.js";
import type { CoverageReport, ScopeConfig } from "./scope.js";
import type { SourceKind } from "./sources.js";
import type {
  AnswerPhase,
  LearnerPreferences,
  MessageRole,
  MessageStatus,
  ReadingPosition,
} from "./store.js";

export interface HealthView {
  status: "ok";
  version: string;
  upstreamCommit: string;
}

export type CreateProjectRequest =
  { localPath: string } | { githubUrl: string; ref?: string };

export interface CreateProjectResponse {
  projectId: ProjectId;
  repoId: RepoId;
}

export interface ProjectSummary {
  generationId?: GenerationId | null;
  latestJobId?: JobId | null;
  latestJobResumeAvailable?: boolean;
  projectId: ProjectId;
  repoId: RepoId;
  kind: RepoKind;
  displayName: string;
  defaultBranch: string | null;
  analyzedCommitSha: string | null;
  lastSuccessAt: string | null;
  latestJobState: JobState | null;
  watchEnabled: boolean;
}

export interface ProjectListView {
  projects: ProjectSummary[];
}

export interface ProjectDetail extends ProjectSummary {
  remoteUrl: string | null;
  coverage: { complete: boolean; gapCount: number };
  /** null = never polled or watch disabled. */
  lastPollAt: string | null;
  generationCount: number;
}

export interface DependentsView {
  projectId: ProjectId;
  conversations: { ids: ConversationId[]; count: number };
  lessons: { ids: LessonId[]; count: number };
  generations: { ids: GenerationId[]; count: number };
  changeEvents: { ids: ChangeEventId[]; count: number };
}

export interface DeleteProjectResponse {
  removed: true;
  dependents: DependentsView;
}

export interface CreateAnalysisRequest {
  ref: string;
  scope?: Partial<ScopeConfig>;
  config?: Partial<GenerationConfig>;
}

export interface CreateAnalysisResponse {
  jobId: JobId;
  generationId: GenerationId;
  /** True ⇒ job already completed, zero model calls. */
  cacheHit: boolean;
}

export interface CreateComparisonRequest {
  baseSha: string;
  headSha: string;
  scope?: Partial<ScopeConfig>;
  config?: Partial<GenerationConfig>;
}

export interface CreateComparisonResponse {
  jobId: JobId;
  generationId: GenerationId;
}

export interface JobView {
  jobId: JobId;
  kind: JobKind;
  state: JobState;
  attempt: number;
  streamId: string | null;
  projectId: ProjectId | null;
  progress: JobProgress | null;
  errorCode: JobErrorCode | null;
  errorDetail: string | null;
  outputGenerationId: GenerationId | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  retryable: boolean;
}

export interface LessonSummary {
  lessonId: LessonId;
  kind: LessonKind;
  title: string;
  moduleIds: string[];
  hasCoverageGaps: boolean;
}

export interface LessonListView {
  generationId: GenerationId;
  commitSha: string;
  lessons: LessonSummary[];
}

export interface LessonDetailView {
  lesson: Lesson | ChangeLesson | ComparisonLesson;
  /** §9.6 toRenderData(). */
  diagram: RenderDiagram;
  /** Sanitized render (§16.3). */
  html: string;
}

export interface SourceView {
  generationId: GenerationId;
  sourceId: SourceId;
  kind: SourceKind;
  commitSha: string;
  label: string;
  content: string;
  lines: { start: number; end: number } | null;
  truncated: boolean;
  availability: SourceStatus;
}

export interface CreateConversationRequest {
  /** Length 1 or 2, else invalid_input. */
  generationIds: GenerationId[];
  lessonId?: LessonId;
  moduleId?: string;
}

export interface CitationView {
  sourceId: SourceId;
  generationId: GenerationId;
  commitSha: string;
  label: string;
  availability: SourceStatus;
}

export interface MessageView {
  messageId: MessageId;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  answerPhase: AnswerPhase;
  citations: CitationView[];
  selection: QaSelection | null;
  unknownReason: string | null;
  incomplete: boolean;
  createdAt: string;
}

/**
 * DTO for a stored selection row. `SelectionRecord` is the row; it never leaves
 * `store/`, so the HTTP shape is a distinct type even though the fields coincide
 * today.
 */
export interface SelectionView {
  lessonId: LessonId | null;
  moduleId: string | null;
  sourceId: SourceId | null;
  codeLocation: { path: string; lines: { start: number; end: number } } | null;
  createdAt: string;
}

export interface ConversationView {
  conversationId: ConversationId;
  generationIds: GenerationId[];
  createdAt: string;
  lastActiveAt: string;
  messages: MessageView[];
  selections: SelectionView[];
  readingPosition: ReadingPosition | null;
}

export interface MessageListView {
  messages: MessageView[];
  nextBefore: string | null;
}

export interface PostMessageRequest {
  text: string;
  selection?: QaSelection;
}

export interface PutWatchRequest {
  enabled: boolean;
  scope?: Partial<ScopeConfig>;
  /** Manual refresh (AC-UPD-03, §12.5). */
  refreshNow?: boolean;
}

export interface PutWatchResponse {
  watchEnabled: boolean;
  lastPollAt: string | null;
  refreshed: { discovered: number; enqueued: number; gaps: number } | null;
}

export interface ChangeSummary {
  changeId: ChangeEventId;
  kind: ChangeEventKind;
  streamKind: StreamKind;
  state: ChangeEventState;
  significance: Significance;
  headSha: string | null;
  baseSha: string | null;
  hasGap: boolean;
  linkedChangeId: ChangeEventId | null;
  discoveredAt: string;
  publishedAt: string | null;
  title: string;
  generationId?: GenerationId | null;
}

export interface ChangeListView {
  items: ChangeSummary[];
  next: string | null;
}

export interface ChangeDetailView {
  change: ChangeSummary;
  payload: ChangeEventPayload;
  lesson: ChangeLesson | null;
  /** Never a GitHub write/comment link. */
  commitRef: { sha: string; label: string } | null;
}

export interface PreferencesView {
  preferences: LearnerPreferences;
  readingPositions: ReadingPosition[];
}

export interface PutPreferencesRequest {
  explainLevel?: LearnerPreferences["explainLevel"];
  background?: string | null;
  readingPosition?: {
    generationId: GenerationId;
    lessonId: LessonId;
    offset: number;
  };
}

export interface TermView {
  termId: TermId;
  zh: string;
  en: string;
  symbols: string[];
  links: {
    generationId: GenerationId;
    repoId: RepoId;
    projectId: ProjectId;
    sourceId: SourceId;
  }[];
}

export interface TermListView {
  terms: TermView[];
}

export interface ModelSettingsView {
  baseUrl?: string | null;
  apiKeyConfigured?: boolean;
  maxOutputTokens?: number;
  temperature?: number;
  provider: string;
  model: string;
  pricingConfigured: boolean;
  quota: { maxCalls: number; maxInputTokens: number; maxOutputTokens: number };
  /** "选中代码片段","页面文本","你的问题","偏好摘要","外部资料片段". */
  dataSent: string[];
}

export interface PutModelSettingsRequest {
  /** Null/blank clears the saved override. Omission retains it. */
  baseUrl?: string | null;
  /** Write-only; never persisted into model settings or returned in a DTO. */
  apiKey?: string;
  provider: string;
  model: string;
  maxOutputTokens?: number;
  temperature?: number;
  pricing?: { inputCentsPerMTok: number; outputCentsPerMTok: number } | null;
  quota?: Partial<ModelSettingsView["quota"]>;
}

export interface TestModelConnectionRequest {
  provider: string;
  model: string;
  baseUrl?: string | null;
  /** An unsaved key takes precedence over the stored/environment key. */
  apiKey?: string;
}

export interface TestModelConnectionView {
  ok: true;
  latencyMs: number;
  message: string;
}

export type UsageKind = "initial" | "update" | "comparison" | "qa" | "change";

export interface UsageView {
  groups: {
    kind: UsageKind;
    inputTokens: number;
    outputTokens: number;
    calls: number;
    costCents: number | null;
  }[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    calls: number;
    costCents: number | null;
    pricingConfigured: boolean;
  };
}

export interface StorageView {
  totalBytes: number;
  byProject: { projectId: ProjectId; bytes: number }[];
  byGeneration: { generationId: GenerationId; bytes: number }[];
  bySnapshot: { repoId: RepoId; commitSha: string; bytes: number }[];
  byConversation: { conversationId: ConversationId; bytes: number }[];
}

// ── server-rendered page models ──────────────────────────────────────────────
export interface ProjectsPageModel {
  projects: ProjectSummary[];
  modelConfigured: boolean;
  pollingNote: string;
}

export interface ReaderPageModel {
  projectId?: ProjectId | null;
  source?: SourceView | null;
  generationId: GenerationId;
  commitSha: string;
  repoDisplayName: string;
  lessons: LessonSummary[];
  activeLesson: LessonDetailView | null;
  deletedLessons?: LessonSummary[];
  topics?: LearningTopic[];
  deletedTopics?: LearningTopic[];
  activeTopic?: LearningTopicView | null;
  coverage: CoverageReport;
  conversation: ConversationView | null;
  readingPosition: ReadingPosition | null;
  pollingNote: string;
}

export interface InboxPageModel {
  projectName?: string;
  projects?: { projectId: ProjectId; displayName: string }[];
  projectId: ProjectId;
  items: ChangeSummary[];
  next: string | null;
  pollingNote: string;
}

export interface TermsPageModel {
  terms: TermView[];
}

export interface SettingsPageModel {
  /** The project whose watch controls this page drives; empty when none. */
  projectId: ProjectId | "";
  model: ModelSettingsView;
  usage: UsageView;
  storage: StorageView;
  preferences: PreferencesView;
  watch: {
    enabled: boolean;
    available: boolean;
    reason: string | null;
    lastPollAt: string | null;
  };
  pollingNote: string;
}
