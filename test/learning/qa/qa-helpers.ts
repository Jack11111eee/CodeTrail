/**
 * Shared doubles for the read-only Q&A suites.
 *
 * A real SQLite database (temp file), a real conversation service and a real
 * answer service, with only the three external seams doubled: the snapshot
 * service, the retriever and the scripted model. That keeps every assertion
 * about phases, citations and budgets on production code.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  AnswerDeps,
  AnswerEvent,
  AnswerService,
  Binding,
  Clock,
  ConversationId,
  ConversationService,
  Database,
  ExternalDocService,
  GenerationId,
  GenerationKind,
  LearnerPreferences,
  LessonKind,
  ModelHandle,
  ModelRole,
  ModelSettings,
  NormalizedScope,
  ProjectId,
  PublishedGenerationRef,
  Repositories,
  RepoId,
  RetrievalHit,
  SnapshotReader,
  SnapshotRecord,
  SnapshotService,
  SourceId,
  SourceKind,
  SourceRegistry,
  SourceRow,
} from "../../../src/learning/contracts/index.ts";
import {
  LearningError,
  sliceHash,
} from "../../../src/learning/contracts/index.ts";
import { PROMPT_TEMPLATE_VERSION } from "../../../src/learning/config/defaults.ts";
import {
  createSourceRegistry,
  repoSourceId,
} from "../../../src/learning/evidence/index.ts";
import { normalizeScope } from "../../../src/learning/projects/scope.ts";
import {
  createRepositories,
  migrate,
  openDatabase,
} from "../../../src/learning/store/index.ts";
import {
  createScriptedModel,
  SCRIPT_FILE_NAME,
  type ScriptEntry,
  type ScriptedModelOptions,
} from "../../../src/learning/testing/scripted-model.ts";
import {
  AT,
  makeGeneration,
  makeLesson,
  makeProject,
  makeRepo,
} from "../store/helpers.ts";
import { createConversationService } from "../../../src/learning/qa/conversations.ts";
import { createAnswerService } from "../../../src/learning/qa/answer.ts";
import {
  createToolBudget,
  type QaToolContext,
} from "../../../src/learning/qa/tools.ts";

export const QA_PROMPT_VERSION = PROMPT_TEMPLATE_VERSION;
export const REPO_ID = "r_0123456789abcdef";
export const PROJECT_ID = "p_0123456789abcdef";
export const COMMIT_A = "a".repeat(40);
export const COMMIT_B = "b".repeat(40);

const temporaryDirectories: string[] = [];

export function tempDir(prefix = "codetrail-qa-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function writeTree(root: string, files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    const target = path.join(root, relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
}

// ── database ────────────────────────────────────────────────────────────────

export interface QaDb {
  db: Database;
  file: string;
  repos: Repositories;
  clock: Clock;
  close(): void;
}

export function createQaDb(): QaDb {
  const dir = tempDir("codetrail-qa-db-");
  const file = path.join(dir, "codetrail.sqlite");
  const db = openDatabase({ file });
  migrate(db);
  let current = new Date(AT);
  const clock: Clock = {
    now: () => new Date(current),
    set(value: string) {
      current = new Date(value);
    },
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
  return {
    db,
    file,
    repos: createRepositories(db),
    clock,
    close() {
      try {
        db.close();
      } catch {
        // already closed
      }
    },
  };
}

// ── fixtures ────────────────────────────────────────────────────────────────

export interface GenerationFixtureOptions {
  generationId: string;
  repoId?: string;
  projectId?: string;
  commitSha?: string;
  kind?: GenerationKind;
  comparisonBaseSha?: string | null;
  contentDir?: string;
  scope?: NormalizedScope;
  status?: "published" | "staged" | "failed" | "superseded";
  sealedTreeHash?: string | null;
  sources?: {
    sourceId?: string;
    kind?: SourceKind;
    commitSha?: string;
    path?: string;
    lines?: { start: number; end: number } | null;
    payload?: unknown;
  }[];
  lessons?: {
    lessonId: string;
    relPath?: string;
    title?: string;
    kind?: LessonKind;
    moduleIds?: string[];
  }[];
  files?: Record<string, string>;
}

export interface GenerationFixture {
  generationId: GenerationId;
  repoId: RepoId;
  projectId: ProjectId;
  commitSha: string;
  contentDir: string;
  sourceIds: SourceId[];
  lessonIds: string[];
}

/** Inserts a repo/project (once), the generation row and its sources/lessons. */
export function publishGeneration(
  ctx: Pick<QaDb, "repos">,
  options: GenerationFixtureOptions,
): GenerationFixture {
  const repoId = options.repoId ?? REPO_ID;
  const projectId = options.projectId ?? PROJECT_ID;
  const commitSha = options.commitSha ?? COMMIT_A;
  const contentDir =
    options.contentDir ?? tempDir(`codetrail-qa-knowledge-${options.generationId}-`);

  if (ctx.repos.repos.byId(repoId as never) === null) {
    ctx.repos.repos.upsert(
      makeRepo({
        repoId: repoId as never,
        identity: `local:${repoId}`,
        mirrorPath: path.join(tempDir("codetrail-qa-mirror-"), `${repoId}.git`),
      }),
    );
  }
  if (ctx.repos.projects.byId(projectId as never) === null) {
    ctx.repos.projects.insert(
      makeProject({
        projectId: projectId as never,
        repoId: repoId as never,
        scope: options.scope ?? normalizeScope(),
      }),
    );
  }

  const generationId = options.generationId as GenerationId;
  const published = options.status === undefined || options.status === "published";
  ctx.repos.generations.insertPublished(
    makeGeneration({
      generationId,
      cacheKey: `ck_${generationId}`,
      repoId: repoId as never,
      projectId: projectId as never,
      commitSha,
      comparisonBaseSha: options.comparisonBaseSha ?? null,
      kind: options.kind ?? "research",
      contentDir,
      status: options.status ?? "published",
      sealedTreeHash:
        options.sealedTreeHash === undefined
          ? published
            ? `sha256:${"0".repeat(64)}`
            : null
          : options.sealedTreeHash,
      publishedAt: published ? AT : null,
    }),
  );

  if (options.files !== undefined) writeTree(contentDir, options.files);

  const sourceIds: SourceId[] = [];
  const sourceRows: SourceRow[] = [];
  for (const source of options.sources ?? []) {
    const kind = source.kind ?? "repo";
    const sourceCommit = source.commitSha ?? commitSha;
    if (kind === "repo") {
      const sourcePath = source.path ?? "src/index.ts";
      const lines = source.lines ?? null;
      const sourceId =
        source.sourceId ??
        repoSourceId(sourcePath, sourceCommit, lines);
      sourceIds.push(sourceId as SourceId);
      sourceRows.push({
        generationId,
        sourceId: sourceId as SourceId,
        kind,
        commitSha: sourceCommit,
        payloadJson: JSON.stringify({
          sourceId,
          kind: "repo",
          generationId,
          repoId,
          commitSha: sourceCommit,
          path: sourcePath,
          lines,
          contentHash: sliceHash(`${sourcePath}:${sourceCommit}`),
        }),
        contentHash: sliceHash(`${sourcePath}:${sourceCommit}`),
      });
    } else {
      const payload = source.payload ?? {};
      const sourceId = source.sourceId ?? `s_${kind}_${sourceIds.length}`;
      sourceIds.push(sourceId as SourceId);
      sourceRows.push({
        generationId,
        sourceId: sourceId as SourceId,
        kind,
        commitSha: sourceCommit,
        payloadJson: JSON.stringify(payload),
        contentHash: sliceHash(JSON.stringify(payload)),
      });
    }
  }
  if (sourceRows.length > 0) ctx.repos.sources.insertMany(sourceRows);

  const lessonIds: string[] = [];
  for (const lesson of options.lessons ?? []) {
    const relPath = lesson.relPath ?? `lessons/${lesson.lessonId}.json`;
    lessonIds.push(lesson.lessonId);
    ctx.repos.lessons.insertMany([
      makeLesson({
        lessonId: lesson.lessonId as never,
        generationId,
        kind: lesson.kind ?? "research",
        title: lesson.title ?? lesson.lessonId,
        relPath,
        publishedAt: AT,
      }),
    ]);
    if (lesson.moduleIds !== undefined) {
      writeTree(contentDir, {
        [relPath]: JSON.stringify({
          lessonId: lesson.lessonId,
          generationId,
          context: { moduleIds: lesson.moduleIds },
        }),
      });
    }
  }

  return {
    generationId,
    repoId: repoId as RepoId,
    projectId: projectId as ProjectId,
    commitSha,
    contentDir,
    sourceIds,
    lessonIds,
  };
}

// ── snapshot service ────────────────────────────────────────────────────────

export function fakeSnapshotService(
  filesByGeneration: Record<string, Record<string, string>>,
  generationOfCommit: Record<string, string> = {},
): SnapshotService & { reads: number } {
  const service: SnapshotService & { reads: number } = {
    reads: 0,
    resolve(_repoId, ref) {
      void _repoId;
      return Promise.resolve(ref);
    },
    ensure(repoId, sha): Promise<SnapshotRecord> {
      return Promise.resolve({
        repoId,
        commitSha: sha,
        treeHash: `tree-${sha.slice(0, 8)}`,
        worktreePath: `/tmp/codetrail-qa/${sha}`,
        resolvedAt: AT,
      });
    },
    readFile(snap, relPath): Promise<string> {
      service.reads += 1;
      const generationId = generationOfCommit[snap.commitSha];
      const files =
        generationId === undefined ? undefined : filesByGeneration[generationId];
      const text = files?.[relPath];
      if (text === undefined) {
        return Promise.reject(
          new LearningError("not_found", "文件不存在", { path: relPath }),
        );
      }
      return Promise.resolve(text);
    },
    listFiles(snap) {
      const generationId = generationOfCommit[snap.commitSha];
      const files =
        generationId === undefined ? undefined : filesByGeneration[generationId];
      return Promise.resolve(
        Object.entries(files ?? {}).map(([relPath, text]) => ({
          path: relPath,
          bytes: Buffer.byteLength(text, "utf8"),
        })),
      );
    },
    coverage() {
      return Promise.reject(
        new LearningError("internal_error", "not implemented in tests"),
      );
    },
  };
  return service;
}

// ── retriever ───────────────────────────────────────────────────────────────

export interface FakeRetriever {
  search: (
    binding: Binding,
    query: string,
    opts?: { limit?: number; hints?: string[] },
  ) => Promise<RetrievalHit[]>;
  calls: Binding[];
}

export function fakeRetriever(
  hitsByGeneration: Record<string, RetrievalHit[]>,
  onSearch?: (binding: Binding, query: string) => void,
): FakeRetriever {
  const calls: Binding[] = [];
  return {
    calls,
    search(binding, _query) {
      calls.push({ ...binding });
      onSearch?.(binding, _query);
      return Promise.resolve(
        (hitsByGeneration[binding.generationId] ?? []).map((hit) => ({
          ...hit,
          binding: { ...binding },
          ...(hit.lines === undefined ? {} : { lines: { ...hit.lines } }),
        })),
      );
    },
  };
}

export function wikiHit(
  generationId: string,
  commitSha: string,
  page: string,
  preview: string,
): RetrievalHit {
  return {
    kind: "wiki",
    binding: {
      generationId: generationId as GenerationId,
      repoId: REPO_ID as never,
      commitSha,
    },
    page,
    anchor: "",
    preview,
  };
}

export function sourceHit(
  generationId: string,
  repoId: string,
  commitSha: string,
  filePath: string,
  preview: string,
  lines?: { start: number; end: number },
): RetrievalHit {
  return {
    kind: "source",
    binding: {
      generationId: generationId as GenerationId,
      repoId: repoId as never,
      commitSha,
    },
    path: filePath,
    ...(lines === undefined ? {} : { lines }),
    preview,
  };
}

// ── scripted model ──────────────────────────────────────────────────────────

export function scriptDir(scripts: ScriptEntry[]): string {
  const dir = tempDir("codetrail-qa-scripts-");
  fs.writeFileSync(
    path.join(dir, SCRIPT_FILE_NAME),
    JSON.stringify({ scripts }, null, 2),
    "utf8",
  );
  return dir;
}

export function answerEntry(
  payload: unknown,
  occurrence = 1,
): ScriptEntry {
  return {
    workerKind: "qa",
    occurrence,
    steps: [{ content: JSON.stringify(payload) }],
  };
}

export function rawAnswerEntry(content: string, occurrence = 1): ScriptEntry {
  return { workerKind: "qa", occurrence, steps: [{ content }] };
}

export function toolEntry(
  toolCalls: { name: string; args: unknown }[],
  occurrence = 1,
): ScriptEntry {
  return { workerKind: "qa", occurrence, steps: [{ toolCalls }] };
}

const SCRIPTED_SETTINGS: ModelSettings = {
  provider: "scripted",
  model: "scripted",
  maxOutputTokens: 1024,
  temperature: 0,
  pricing: null,
  quota: { maxCalls: 100, maxInputTokens: 100_000, maxOutputTokens: 20_000 },
};

export function scriptedHandle(
  dir: string,
  onCall?: ScriptedModelOptions["onCall"],
  role: ModelRole = "qa",
): ModelHandle {
  const chatModel = createScriptedModel({
    dir,
    role,
    promptTemplateVersion: QA_PROMPT_VERSION,
    onCall,
  });
  return {
    modelId: "scripted",
    settings: SCRIPTED_SETTINGS,
    chat: () => chatModel,
    estimate: () => ({ calls: 1, tokens: 0 }),
  };
}

// ── services ────────────────────────────────────────────────────────────────

export function stubExternal(): ExternalDocService {
  return {
    fetchExact: () =>
      Promise.resolve({
        ok: false,
        status: "source_missing",
        reason: "not_found",
      }),
    cached: () => Promise.resolve(null),
  };
}

export interface HarnessOptions {
  model?: ModelHandle | null;
  modelDir?: string;
  onCall?: ScriptedModelOptions["onCall"];
  hits?: Record<string, RetrievalHit[]>;
  onSearch?: (binding: Binding, query: string) => void;
  filesByGeneration?: Record<string, Record<string, string>>;
  generationOfCommit?: Record<string, string>;
  external?: ExternalDocService;
  registry?: SourceRegistry;
}

export interface Harness {
  db: QaDb;
  conversations: ConversationService;
  answers: AnswerService;
  retriever: FakeRetriever;
  snapshotService: SnapshotService & { reads: number };
  registry: SourceRegistry;
  model: ModelHandle | null;
  prefs: LearnerPreferences;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const db = createQaDb();
  const conversations = createConversationService({
    db: db.db,
    repos: db.repos,
    clock: db.clock,
  });
  const retriever = fakeRetriever(options.hits ?? {}, options.onSearch);
  const snapshotService = fakeSnapshotService(
    options.filesByGeneration ?? {},
    options.generationOfCommit ?? {},
  );
  const registry =
    options.registry ??
    createSourceRegistry({
      clock: db.clock,
      sources: db.repos.sources,
      generations: db.repos.generations,
    });
  const model =
    options.model !== undefined
      ? options.model
      : options.modelDir === undefined
        ? null
        : scriptedHandle(options.modelDir, options.onCall);
  const deps: AnswerDeps = {
    db: db.db,
    repos: db.repos,
    clock: db.clock,
    model,
    retriever,
    registry,
    snapshotService,
    external: options.external ?? stubExternal(),
    conversations,
  };
  return {
    db,
    conversations,
    answers: createAnswerService(deps),
    retriever,
    snapshotService,
    registry,
    model,
    prefs: db.repos.prefs.get(),
  };
}

export async function collect(
  stream: AsyncIterable<AnswerEvent>,
): Promise<AnswerEvent[]> {
  const events: AnswerEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

export function eventsOfType<T extends AnswerEvent["type"]>(
  events: AnswerEvent[],
  type: T,
): Extract<AnswerEvent, { type: T }>[] {
  return events.filter(
    (event): event is Extract<AnswerEvent, { type: T }> => event.type === type,
  );
}

export function messageOf(
  repos: Repositories,
  conversationId: ConversationId,
  messageId: string,
) {
  return repos.conversations
    .messages(conversationId)
    .find((message) => message.messageId === messageId);
}

export function publishedRefOf(fixture: GenerationFixture): PublishedGenerationRef {
  return {
    state: "published",
    generationId: fixture.generationId,
    repoId: fixture.repoId,
    commitSha: fixture.commitSha,
    knowledgeDir: fixture.contentDir,
    sealedTreeHash: `sha256:${"0".repeat(64)}`,
    publishedAt: AT,
    comparisonBase: null,
  };
}

/** A `QaToolContext` over an in-memory snapshot, for direct tool tests. */
export function toolContextFor(
  ctx: QaDb,
  fixture: GenerationFixture,
  files: Record<string, string> = {},
  external: ExternalDocService = stubExternal(),
): QaToolContext {
  const snapshot: SnapshotReader = {
    repoId: fixture.repoId,
    commitSha: fixture.commitSha,
    treeHash: `tree-${fixture.commitSha.slice(0, 8)}`,
    read(relPath: string) {
      const text = files[relPath];
      if (text === undefined) {
        return Promise.reject(
          new LearningError("not_found", "文件不存在", { path: relPath }),
        );
      }
      return Promise.resolve(text);
    },
    exists(relPath: string) {
      return Promise.resolve(relPath in files);
    },
    slice(relPath: string, lines: { start: number; end: number }) {
      const text = files[relPath] ?? "";
      return Promise.resolve(
        text
          .split("\n")
          .slice(lines.start - 1, lines.end)
          .join("\n"),
      );
    },
    list() {
      return Promise.resolve(
        Object.entries(files).map(([relPath, text]) => ({
          path: relPath,
          bytes: Buffer.byteLength(text, "utf8"),
        })),
      );
    },
  };
  return {
    binding: {
      generationId: fixture.generationId,
      repoId: fixture.repoId,
      commitSha: fixture.commitSha,
    },
    generation: publishedRefOf(fixture),
    snapshot,
    scope: normalizeScope(),
    registry: createSourceRegistry({
      clock: ctx.clock,
      sources: ctx.repos.sources,
      generations: ctx.repos.generations,
    }),
    external,
    budget: createToolBudget({
      maxToolCalls: 8,
      maxInputTokens: 24_000,
      maxOutputTokens: 4_000,
    }),
  };
}

export { AT, makeGeneration };
