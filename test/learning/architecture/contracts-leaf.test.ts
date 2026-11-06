import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Frozen contract layer guard (architecture §2.2, issue-04 ACs).
 *
 * 1. `src/learning/contracts/**` typechecks in isolation with its own tsconfig.
 * 2. A source scan rejects every import outside `contracts/**`, `zod` (only in
 *    `lesson.ts`) and `import type` from `@langchain/core`.
 * 3. Every non-`index.ts` contract module is reachable from the barrel.
 * 4. Each port and record name is declared exactly once under `src/learning/**`.
 * 5. A probe module imports every exported port/record from the barrel, builds
 *    every DI root, names the static-UI seam and narrows the lesson union.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CONTRACTS_DIR = path.join(REPO_ROOT, "src/learning/contracts");
const SRC_LEARNING = path.join(REPO_ROOT, "src/learning");
const TSC = path.join(REPO_ROOT, "node_modules/typescript7/bin/tsc");
const TEMP_PREFIX = `.contracts-leaf-${process.pid}`;

const COMPILER_OPTIONS = {
  target: "ES2022",
  module: "NodeNext",
  moduleResolution: "NodeNext",
  lib: ["ES2022"],
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  esModuleInterop: true,
  forceConsistentCasingInFileNames: true,
  types: ["node"],
};

const tempFiles: string[] = [];

function writeTempFile(name: string, content: string): string {
  const file = path.join(REPO_ROOT, name);
  fs.writeFileSync(file, content, "utf8");
  tempFiles.push(file);
  return file;
}

afterAll(() => {
  for (const file of tempFiles) {
    try {
      fs.unlinkSync(file);
    } catch {
      // best effort cleanup
    }
  }
});

function runTsc(configPath: string): { code: number; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      [TSC, "--noEmit", "-p", configPath],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    return { code: 0, output };
  } catch (error) {
    const failure = error as {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: failure.status ?? 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

function contractFiles(): string[] {
  return fs
    .readdirSync(CONTRACTS_DIR)
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

/** Return human-readable violations for one contract source file. */
function scanSource(filePath: string, source: string): string[] {
  const violations: string[] = [];
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const checkSpecifier = (specifier: string, typeOnly: boolean): void => {
    const label = path.basename(filePath);
    if (specifier.startsWith(".")) {
      const resolved = path.resolve(path.dirname(filePath), specifier);
      const relative = path.relative(CONTRACTS_DIR, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        violations.push(
          `${label}: relative import escapes contracts/: ${specifier}`,
        );
      }
      return;
    }
    if (specifier === "zod" || specifier.startsWith("zod/")) {
      if (path.basename(filePath) !== "lesson.ts") {
        violations.push(
          `${label}: zod is allowed only in lesson.ts: ${specifier}`,
        );
      }
      return;
    }
    if (
      specifier === "@langchain/core" ||
      specifier.startsWith("@langchain/core/")
    ) {
      if (!typeOnly) {
        violations.push(
          `${label}: @langchain/core must be imported with import type: ${specifier}`,
        );
      }
      return;
    }
    violations.push(
      `${label}: import outside contracts/, zod and @langchain/core: ${specifier}`,
    );
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier)) {
        const typeOnly = ts.isImportDeclaration(node)
          ? node.importClause?.isTypeOnly === true
          : node.isTypeOnly;
        checkSpecifier(specifier.text, typeOnly);
      }
    } else if (ts.isImportTypeNode(node)) {
      if (
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      ) {
        checkSpecifier(node.argument.literal.text, true);
      }
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument)) {
          checkSpecifier(argument.text, false);
        }
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"
      ) {
        violations.push(`${path.basename(filePath)}: require() is not allowed`);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

const PORTS_AND_RECORDS = [
  // ids
  "ProjectId",
  "RepoId",
  "GenerationId",
  "LessonId",
  "SourceId",
  "ConversationId",
  "MessageId",
  "JobId",
  "ChangeEventId",
  "TermId",
  // errors
  "HttpErrorCode",
  "ErrorBody",
  "JobErrorCode",
  "SourceStatus",
  "ErrorReason",
  // sources
  "SourceKind",
  "RepoSourceRef",
  "ExternalSourceRef",
  "TeachingExampleRef",
  "SourceRef",
  "SourceGap",
  // lesson
  "StatementLabel",
  "BoundaryStatus",
  "DiagramKind",
  "DiagramNodeStatus",
  "ScenarioKind",
  "CheckStatus",
  "LessonKind",
  "LessonTerm",
  "ComparisonSide",
  "LessonContext",
  "LessonScenario",
  "LessonModuleOverview",
  "PlainExplanation",
  "TechnicalExplanation",
  "LessonAlternative",
  "LessonChoice",
  "LessonBoundary",
  "LessonStatement",
  "DiagramNode",
  "DiagramEdge",
  "LessonDiagram",
  "RenderDiagram",
  "LessonChecks",
  "RequiredLessonGroup",
  "StructuralFailure",
  "LessonBase",
  "Lesson",
  "ChangeRecordFields",
  "ChangeLesson",
  "ComparisonLesson",
  // job
  "JobKind",
  "JobState",
  "JobAttemptState",
  "JobProgress",
  // change
  "StreamKind",
  "ChangeEventKind",
  "ChangeEventState",
  "Significance",
  "PullRequestPayload",
  "CommitPayload",
  "ChangeEventPayload",
  "DiffEntry",
  "DiffResult",
  // refs
  "RepoKind",
  "RepoIdentity",
  "StagedGenerationRef",
  "PublishedGenerationRef",
  "AnyGenerationRef",
  "GenerationConfig",
  "WikiGraphNode",
  "WikiGraphEdge",
  "WikiGraph",
  "PageManifestView",
  // scope
  "LanguageId",
  "ScopeConfig",
  "NormalizedScope",
  "ExclusionReason",
  "LanguageReport",
  "CoverageReport",
  // store
  "GenerationStatus",
  "GenerationKind",
  "GenerationRecord",
  "NewGeneration",
  "JobRecord",
  "NewJob",
  "JobPayload",
  "GenerationPayload",
  "ChangePayload",
  "ComparisonPayload",
  "JobAttemptRecord",
  "LessonRow",
  "SourceRow",
  "LinkRelation",
  "ChangeRecord",
  "NewChangeEvent",
  "MessageRole",
  "MessageStatus",
  "AnswerPhase",
  "Citation",
  "MessageRecord",
  "SelectionRecord",
  "ReadingPosition",
  "LearnerPreferences",
  "RepoRecord",
  "NewRepoRecord",
  "ProjectRecord",
  "NewProjectRecord",
  "ConversationSummary",
  "ConversationRecord",
  "SnapshotRecord",
  "UsageRecord",
  "ModelSettings",
  "ReposRepo",
  "ProjectsRepo",
  "SnapshotsRepo",
  "JobsRepo",
  "AttemptsRepo",
  "GenerationsRepo",
  "LessonsRepo",
  "SourcesRepo",
  "ConversationsRepo",
  "CursorsRepo",
  "ChangesRepo",
  "UsageRepo",
  "PreferencesRepo",
  "SettingsRepo",
  "TermsRepo",
  // cursor
  "CursorKind",
  "CursorJson",
  "CursorUpdate",
  // ports
  "Clock",
  "SnapshotReader",
  "SourceReader",
  "QaSelection",
  "ContextBudget",
  "ToolBudget",
  "GithubCredential",
  "JobEvent",
  "UsageMeter",
  "IndexCache",
  "SnapshotService",
  "EnqueueJobInput",
  "JobRunner",
  "SealedFile",
  "SealManifest",
  "BuildWorkspace",
  "PublishCommit",
  "GcReport",
  "Publisher",
  "WatchTickResult",
  "WatchScheduler",
  "Binding",
  "RetrievalHit",
  "Retriever",
  "SourceSearcher",
  "RegisterRepoSourceInput",
  "SourceRegistry",
  "ExternalFetchRequest",
  "ExternalFetchResult",
  "ExternalDocService",
  "ConversationSnapshot",
  "ConversationService",
  "AnswerRequest",
  "AnswerEvent",
  "AnswerService",
  "SessionStore",
  "ProjectState",
  "ProjectDependents",
  "RemovalService",
  "AppDeps",
  "Repositories",
  "JobRunnerDeps",
  "WatchDeps",
  "AnswerDeps",
  "LessonBuilderPort",
  "AuthMode",
  "RouteHandlerKey",
  "RouteDef",
  "RouteRequest",
  "RouteResponse",
  "HandlerFactory",
  "RouteModule",
  "StaticUiSeam",
  "ServerOptions",
  "RunningServer",
  // foundation
  "DataPaths",
  "SqlitePreparedStatement",
  "SqliteHandle",
  "Database",
  "ModelRole",
  "ChatModelLike",
  "ModelHandle",
  // upstream
  "WikiHit",
  "WikiSectionResult",
  "ClaimView",
  "StagedWikiRef",
  "PublishedWikiRef",
  "WikiRef",
  "GenerationRunRequest",
  "UpstreamRunEvent",
  "UpstreamGenerationPort",
  "UpstreamRetrievalPort",
  "UpstreamClaimsPort",
  "UpstreamGraphPort",
  "UpstreamMermaidPort",
  // github
  "CommitMeta",
  "PullRequestMeta",
  "GithubPage",
  "GithubClient",
  "DiscoveryOptions",
  "DiscoveryResult",
  "DiscoveryService",
  // lessonbuild
  "EvidenceCatalogEntry",
  "ValidationIssue",
  "ValidationResult",
  "ValidationContext",
  "SemanticRepairFn",
  "BuildLessonsInput",
  "BuildLessonsResult",
  "BuildChangeLessonInput",
  "BuildComparisonLessonInput",
  // api
  "HealthView",
  "CreateProjectRequest",
  "CreateProjectResponse",
  "ProjectSummary",
  "ProjectListView",
  "ProjectDetail",
  "DependentsView",
  "DeleteProjectResponse",
  "CreateAnalysisRequest",
  "CreateAnalysisResponse",
  "CreateComparisonRequest",
  "CreateComparisonResponse",
  "JobView",
  "LessonSummary",
  "LessonListView",
  "LessonDetailView",
  "SourceView",
  "CreateConversationRequest",
  "CitationView",
  "MessageView",
  "SelectionView",
  "ConversationView",
  "MessageListView",
  "PostMessageRequest",
  "PutWatchRequest",
  "PutWatchResponse",
  "ChangeSummary",
  "ChangeListView",
  "ChangeDetailView",
  "PreferencesView",
  "PutPreferencesRequest",
  "TermView",
  "TermListView",
  "ModelSettingsView",
  "PutModelSettingsRequest",
  "UsageKind",
  "UsageView",
  "StorageView",
  "ProjectsPageModel",
  "ReaderPageModel",
  "InboxPageModel",
  "TermsPageModel",
  "SettingsPageModel",
];

function walkTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTypeScriptFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

const PROBE_SOURCE = `
import { z } from "zod";
import type {
  ProjectId, RepoId, GenerationId, LessonId, SourceId, ConversationId, MessageId, JobId,
  ChangeEventId, TermId,
  HttpErrorCode, ErrorBody, JobErrorCode, SourceStatus, ErrorReason,
  SourceKind, RepoSourceRef, ExternalSourceRef, TeachingExampleRef, SourceRef, SourceGap,
  StatementLabel, BoundaryStatus, DiagramKind, DiagramNodeStatus, ScenarioKind, CheckStatus,
  LessonKind, LessonTerm, ComparisonSide, LessonContext, LessonScenario, LessonModuleOverview,
  PlainExplanation, TechnicalExplanation, LessonAlternative, LessonChoice, LessonBoundary,
  LessonStatement, DiagramNode, DiagramEdge, LessonDiagram, RenderDiagram, LessonChecks,
  RequiredLessonGroup, StructuralFailure, LessonBase, Lesson, ChangeRecordFields, ChangeLesson,
  ComparisonLesson,
  JobKind, JobState, JobAttemptState, JobProgress,
  StreamKind, ChangeEventKind, ChangeEventState, Significance, PullRequestPayload, CommitPayload,
  ChangeEventPayload, DiffEntry, DiffResult,
  RepoKind, RepoIdentity, StagedGenerationRef, PublishedGenerationRef, AnyGenerationRef,
  GenerationConfig, WikiGraphNode, WikiGraphEdge, WikiGraph, PageManifestView,
  LanguageId, ScopeConfig, NormalizedScope, ExclusionReason, LanguageReport, CoverageReport,
  GenerationStatus, GenerationKind, GenerationRecord, NewGeneration, JobRecord, NewJob, JobPayload,
  GenerationPayload, ChangePayload, ComparisonPayload, JobAttemptRecord, LessonRow, SourceRow,
  LinkRelation, ChangeRecord, NewChangeEvent, MessageRole, MessageStatus, AnswerPhase, Citation,
  MessageRecord, SelectionRecord, ReadingPosition, LearnerPreferences, RepoRecord, NewRepoRecord,
  ProjectRecord, NewProjectRecord, ConversationSummary, ConversationRecord, SnapshotRecord,
  UsageRecord, ModelSettings, ReposRepo, ProjectsRepo, SnapshotsRepo, JobsRepo, AttemptsRepo,
  GenerationsRepo, LessonsRepo, SourcesRepo, ConversationsRepo, CursorsRepo, ChangesRepo, UsageRepo,
  PreferencesRepo, SettingsRepo, TermsRepo,
  CursorKind, CursorJson, CursorUpdate,
  Clock, SnapshotReader, SourceReader, QaSelection, ContextBudget, ToolBudget, GithubCredential,
  JobEvent, UsageMeter, IndexCache, SnapshotService, EnqueueJobInput, JobRunner, SealedFile,
  SealManifest, BuildWorkspace, PublishCommit, GcReport, Publisher, WatchTickResult,
  WatchScheduler, Binding, RetrievalHit, Retriever, SourceSearcher, RegisterRepoSourceInput,
  SourceRegistry, ExternalFetchRequest, ExternalFetchResult, ExternalDocService,
  ConversationSnapshot, ConversationService, AnswerRequest, AnswerEvent, AnswerService,
  SessionStore, ProjectState, ProjectDependents, RemovalService, AppDeps, Repositories,
  JobRunnerDeps, WatchDeps, AnswerDeps, LessonBuilderPort, AuthMode, RouteHandlerKey, RouteDef,
  RouteRequest, RouteResponse, HandlerFactory, RouteModule, StaticUiSeam, ServerOptions,
  RunningServer,
  DataPaths, SqlitePreparedStatement, SqliteHandle, Database, ModelRole, ChatModelLike,
  ModelHandle,
  WikiHit, WikiSectionResult, ClaimView, StagedWikiRef, PublishedWikiRef, WikiRef,
  GenerationRunRequest, UpstreamRunEvent, UpstreamGenerationPort, UpstreamRetrievalPort,
  UpstreamClaimsPort, UpstreamGraphPort, UpstreamMermaidPort,
  CommitMeta, PullRequestMeta, GithubPage, GithubClient, DiscoveryOptions, DiscoveryResult,
  DiscoveryService,
  EvidenceCatalogEntry, ValidationIssue, ValidationResult, ValidationContext, SemanticRepairFn,
  BuildLessonsInput, BuildLessonsResult, BuildChangeLessonInput, BuildComparisonLessonInput,
  HealthView, CreateProjectRequest, CreateProjectResponse, ProjectSummary, ProjectListView,
  ProjectDetail, DependentsView, DeleteProjectResponse, CreateAnalysisRequest,
  CreateAnalysisResponse, CreateComparisonRequest, CreateComparisonResponse, JobView, LessonSummary,
  LessonListView, LessonDetailView, SourceView, CreateConversationRequest, CitationView,
  MessageView, SelectionView, ConversationView, MessageListView, PostMessageRequest,
  PutWatchRequest, PutWatchResponse, ChangeSummary, ChangeListView, ChangeDetailView,
  PreferencesView, PutPreferencesRequest, TermView, TermListView, ModelSettingsView,
  PutModelSettingsRequest, UsageKind, UsageView, StorageView, ProjectsPageModel, ReaderPageModel,
  InboxPageModel, TermsPageModel, SettingsPageModel,
} from "./src/learning/contracts/index.js";

declare const paths: DataPaths;
declare const clock: Clock;
declare const db: Database;
declare const repos: Repositories;
declare const jobRunner: JobRunner;
declare const publisher: Publisher;
declare const watch: WatchScheduler;
declare const snapshotService: SnapshotService;
declare const retriever: Retriever;
declare const conversations: ConversationService;
declare const answers: AnswerService;
declare const registry: SourceRegistry;
declare const external: ExternalDocService;
declare const session: SessionStore;
declare const removal: RemovalService;
declare const usage: UsageMeter;
declare const upstream: UpstreamGenerationPort;
declare const lessons: LessonBuilderPort;
declare const github: GithubClient;
declare const discovery: DiscoveryService;

export const deps: AppDeps = {
  paths, clock, db, repos, jobRunner, publisher, watch, snapshotService, retriever,
  conversations, answers, registry, external, model: null, session, removal, usage,
};

export const jobDeps: JobRunnerDeps = {
  db, repos, paths, clock, snapshotService, publisher, upstream, lessons, model: null,
  usage, registry, external,
};

export const watchDeps: WatchDeps = {
  db, repos, clock, github, discovery, jobRunner, intervalMs: 300_000,
};

export const answerDeps: AnswerDeps = {
  db, repos, clock, model: null, retriever, registry, snapshotService, external, conversations,
};

export const serverOptions: ServerOptions = { paths, port: 0, clock, deps, ui: undefined };
export const uiSeam: StaticUiSeam | undefined = serverOptions.ui;
export const appRemoval: AppDeps["removal"] = removal;
export const appUsage: AppDeps["usage"] = usage;
export const jobRegistry: JobRunnerDeps["registry"] = registry;
export const jobExternal: JobRunnerDeps["external"] = external;

export const researchKind: Lesson["kind"] = "research";
export const changeKind: ChangeLesson["kind"] = "change";
export const comparisonKind: ComparisonLesson["kind"] = "comparison";
// @ts-expect-error Lesson.kind is the literal "research", not the wide union
export const wrongResearchKind: Lesson["kind"] = "change";
// @ts-expect-error ChangeLesson.kind is the literal "change"
export const wrongChangeKind: ChangeLesson["kind"] = "research";

export function narrow(view: LessonDetailView): Lesson | ChangeLesson | ComparisonLesson {
  const lesson = view.lesson;
  if (lesson.kind === "research") return lesson;
  if (lesson.kind === "change") return lesson;
  return lesson;
}

const researchSchema = z.object({ kind: z.literal("research") });
const changeSchema = z.object({ kind: z.literal("change") });
const comparisonSchema = z.object({ kind: z.literal("comparison") });
export const anyLessonSchema = z.discriminatedUnion("kind", [
  researchSchema,
  changeSchema,
  comparisonSchema,
]);

export type _AllNames = [
  ProjectId, RepoId, GenerationId, LessonId, SourceId, ConversationId, MessageId, JobId,
  ChangeEventId, TermId, HttpErrorCode, ErrorBody, JobErrorCode, SourceStatus, ErrorReason,
  SourceKind, RepoSourceRef, ExternalSourceRef, TeachingExampleRef, SourceRef, SourceGap,
  StatementLabel, BoundaryStatus, DiagramKind, DiagramNodeStatus, ScenarioKind, CheckStatus,
  LessonKind, LessonTerm, ComparisonSide, LessonContext, LessonScenario, LessonModuleOverview,
  PlainExplanation, TechnicalExplanation, LessonAlternative, LessonChoice, LessonBoundary,
  LessonStatement, DiagramNode, DiagramEdge, LessonDiagram, RenderDiagram, LessonChecks,
  RequiredLessonGroup, StructuralFailure, LessonBase, Lesson, ChangeRecordFields, ChangeLesson,
  ComparisonLesson, JobKind, JobState, JobAttemptState, JobProgress, StreamKind, ChangeEventKind,
  ChangeEventState, Significance, PullRequestPayload, CommitPayload, ChangeEventPayload, DiffEntry,
  DiffResult, RepoKind, RepoIdentity, StagedGenerationRef, PublishedGenerationRef,
  AnyGenerationRef, GenerationConfig, WikiGraphNode, WikiGraphEdge, WikiGraph, PageManifestView,
  LanguageId, ScopeConfig, NormalizedScope, ExclusionReason, LanguageReport, CoverageReport,
  GenerationStatus, GenerationKind, GenerationRecord, NewGeneration, JobRecord, NewJob, JobPayload,
  GenerationPayload, ChangePayload, ComparisonPayload, JobAttemptRecord, LessonRow, SourceRow,
  LinkRelation, ChangeRecord, NewChangeEvent, MessageRole, MessageStatus, AnswerPhase, Citation,
  MessageRecord, SelectionRecord, ReadingPosition, LearnerPreferences, RepoRecord, NewRepoRecord,
  ProjectRecord, NewProjectRecord, ConversationSummary, ConversationRecord, SnapshotRecord,
  UsageRecord, ModelSettings, ReposRepo, ProjectsRepo, SnapshotsRepo, JobsRepo, AttemptsRepo,
  GenerationsRepo, LessonsRepo, SourcesRepo, ConversationsRepo, CursorsRepo, ChangesRepo, UsageRepo,
  PreferencesRepo, SettingsRepo, TermsRepo, CursorKind, CursorJson, CursorUpdate, Clock,
  SnapshotReader, SourceReader, QaSelection, ContextBudget, ToolBudget, GithubCredential, JobEvent,
  UsageMeter, IndexCache, SnapshotService, EnqueueJobInput, JobRunner, SealedFile, SealManifest,
  BuildWorkspace, PublishCommit, GcReport, Publisher, WatchTickResult, WatchScheduler, Binding,
  RetrievalHit, Retriever, SourceSearcher, RegisterRepoSourceInput, SourceRegistry,
  ExternalFetchRequest, ExternalFetchResult, ExternalDocService, ConversationSnapshot,
  ConversationService, AnswerRequest, AnswerEvent, AnswerService, SessionStore, ProjectState,
  ProjectDependents, RemovalService, AppDeps, Repositories, JobRunnerDeps, WatchDeps, AnswerDeps,
  LessonBuilderPort, AuthMode, RouteHandlerKey, RouteDef, RouteRequest, RouteResponse,
  HandlerFactory, RouteModule, StaticUiSeam, ServerOptions, RunningServer, DataPaths,
  SqlitePreparedStatement, SqliteHandle, Database, ModelRole, ChatModelLike, ModelHandle, WikiHit,
  WikiSectionResult, ClaimView, StagedWikiRef, PublishedWikiRef, WikiRef, GenerationRunRequest,
  UpstreamRunEvent, UpstreamGenerationPort, UpstreamRetrievalPort, UpstreamClaimsPort,
  UpstreamGraphPort, UpstreamMermaidPort, CommitMeta, PullRequestMeta, GithubPage<CommitMeta>, GithubClient,
  DiscoveryOptions, DiscoveryResult, DiscoveryService, EvidenceCatalogEntry, ValidationIssue,
  ValidationResult, ValidationContext, SemanticRepairFn, BuildLessonsInput, BuildLessonsResult,
  BuildChangeLessonInput, BuildComparisonLessonInput, HealthView, CreateProjectRequest,
  CreateProjectResponse, ProjectSummary, ProjectListView, ProjectDetail, DependentsView,
  DeleteProjectResponse, CreateAnalysisRequest, CreateAnalysisResponse, CreateComparisonRequest,
  CreateComparisonResponse, JobView, LessonSummary, LessonListView, LessonDetailView, SourceView,
  CreateConversationRequest, CitationView, MessageView, SelectionView, ConversationView,
  MessageListView, PostMessageRequest, PutWatchRequest, PutWatchResponse, ChangeSummary,
  ChangeListView, ChangeDetailView, PreferencesView, PutPreferencesRequest, TermView, TermListView,
  ModelSettingsView, PutModelSettingsRequest, UsageKind, UsageView, StorageView, ProjectsPageModel,
  ReaderPageModel, InboxPageModel, TermsPageModel, SettingsPageModel,
];
`;

describe("contract layer is a leaf", () => {
  it("typechecks src/learning/contracts in isolation", () => {
    const config = writeTempFile(
      `${TEMP_PREFIX}-isolated.json`,
      JSON.stringify(
        {
          compilerOptions: COMPILER_OPTIONS,
          include: ["src/learning/contracts/**/*.ts"],
        },
        null,
        2,
      ),
    );
    const result = runTsc(config);
    expect(result.code, result.output).toBe(0);
  });

  it("compiles a probe that imports every port/record and builds every DI root", () => {
    const probe = writeTempFile(`${TEMP_PREFIX}-probe.ts`, PROBE_SOURCE);
    const config = writeTempFile(
      `${TEMP_PREFIX}-probe.json`,
      JSON.stringify(
        {
          compilerOptions: COMPILER_OPTIONS,
          include: ["src/learning/contracts/**/*.ts", path.basename(probe)],
        },
        null,
        2,
      ),
    );
    const result = runTsc(config);
    expect(result.code, result.output).toBe(0);
  });

  it("permits only contracts/**, zod in lesson.ts and import type from @langchain/core", () => {
    const violations = contractFiles().flatMap((name) => {
      const file = path.join(CONTRACTS_DIR, name);
      return scanSource(file, fs.readFileSync(file, "utf8"));
    });
    expect(violations).toEqual([]);
  });

  it("rejects each forbidden import category", () => {
    const ids = path.join(CONTRACTS_DIR, "ids.ts");
    const lesson = path.join(CONTRACTS_DIR, "lesson.ts");
    const foundation = path.join(CONTRACTS_DIR, "foundation.ts");

    expect(scanSource(ids, 'import fs from "node:fs";')).not.toEqual([]);
    expect(scanSource(ids, 'import { z } from "zod";')).not.toEqual([]);
    expect(scanSource(lesson, 'import { z } from "zod";')).toEqual([]);
    expect(
      scanSource(
        foundation,
        'import type { BaseChatModel } from "@langchain/core/language_models/chat_models";',
      ),
    ).toEqual([]);
    expect(
      scanSource(
        foundation,
        'import { BaseChatModel } from "@langchain/core/language_models/chat_models";',
      ),
    ).not.toEqual([]);
    expect(
      scanSource(ids, 'import type { DataPaths } from "../config/paths.js";'),
    ).not.toEqual([]);
    expect(
      scanSource(ids, 'import type { RepoIdentity } from "./refs.js";'),
    ).toEqual([]);
    expect(scanSource(ids, 'const x = require("node:fs");')).not.toEqual([]);
  });

  it("exposes every non-index module from the barrel", () => {
    const barrel = fs.readFileSync(
      path.join(CONTRACTS_DIR, "index.ts"),
      "utf8",
    );
    const modules = contractFiles().filter((name) => name !== "index.ts");
    expect(modules).toHaveLength(18);
    for (const moduleFile of modules) {
      const base = moduleFile.slice(0, -".ts".length);
      expect(barrel, `${moduleFile} must be reachable from index.ts`).toMatch(
        new RegExp(`from\\s+["']\\./${base}\\.js["']`),
      );
    }
  });

  it("declares each port and record name exactly once under src/learning", () => {
    const files = walkTypeScriptFiles(SRC_LEARNING);
    const sources = files.map((file) => fs.readFileSync(file, "utf8"));
    const duplicates: string[] = [];
    for (const name of PORTS_AND_RECORDS) {
      const declaration = new RegExp(
        `export\\s+(?:declare\\s+)?(?:interface|class|type|const|function)\\s+${name}\\b`,
        "g",
      );
      let count = 0;
      for (const source of sources) {
        count += source.match(declaration)?.length ?? 0;
      }
      if (count !== 1) {
        duplicates.push(`${name}: ${count}`);
      }
    }
    expect(duplicates).toEqual([]);
  });
});
