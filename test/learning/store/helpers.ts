import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  normalizeScope,
  type ChangeEventId,
  type ChangeEventPayload,
  type ChangeRecord,
  type Citation,
  type ConversationId,
  type GenerationId,
  type GenerationRecord,
  type JobId,
  type JobRecord,
  type LessonId,
  type LessonRow,
  type MessageId,
  type MessageRecord,
  type ModelSettings,
  type ProjectId,
  type ProjectRecord,
  type ReadingPosition,
  type RepoId,
  type RepoRecord,
  type SnapshotRecord,
  type SourceId,
  type SourceRow,
  type UsageRecord,
} from "../../../src/learning/contracts/index.ts";
import {
  migrate,
  openDatabase,
  type Database,
} from "../../../src/learning/store/index.ts";

/** A fixed instant so record round-trips are byte-stable. */
export const AT = "2026-01-01T00:00:00.000Z";

export interface TempDb {
  db: Database;
  file: string;
  dir: string;
}

export function createTempDb(): TempDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-store-"));
  const file = path.join(dir, "codetrail.sqlite");
  const db = openDatabase({ file });
  migrate(db);
  return { db, file, dir };
}

export function closeTempDb(ctx: TempDb): void {
  try {
    ctx.db.close();
  } catch {
    // already closed
  }
  fs.rmSync(ctx.dir, { recursive: true, force: true });
}

export function makeRepo(overrides: Partial<RepoRecord> = {}): RepoRecord {
  return {
    repoId: "r_1" as RepoId,
    identity: "local:/tmp/example-repo",
    kind: "local",
    mirrorPath: "/tmp/example-repo.git",
    remoteUrl: null,
    createdAt: AT,
    ...overrides,
  };
}

export function makeProject(
  overrides: Partial<ProjectRecord> = {},
): ProjectRecord {
  return {
    projectId: "p_1" as ProjectId,
    repoId: "r_1" as RepoId,
    kind: "local",
    displayName: "Example",
    remoteUrl: null,
    defaultBranch: "main",
    scope: normalizeScope(),
    watchEnabled: false,
    createdAt: AT,
    deletedAt: null,
    ...overrides,
  };
}

export function makeGeneration(
  overrides: Partial<GenerationRecord> = {},
): GenerationRecord {
  const generationId = (overrides.generationId ?? "g_1") as GenerationId;
  return {
    generationId,
    cacheKey: `ck_${generationId}`,
    repoId: "r_1" as RepoId,
    projectId: "p_1" as ProjectId,
    commitSha: "a".repeat(40),
    comparisonBaseSha: null,
    kind: "research",
    scopeHash: "sc_1",
    configHash: "cf_1",
    promptTemplateVersion: "v1",
    preferencesVersion: 0,
    upstreamVersion: "upstream-1",
    status: "published",
    contentDir: `/tmp/knowledge/${generationId}`,
    sealedTreeHash: "th_1",
    baselineFromGenerationId: null,
    fallbackReason: null,
    jobId: null,
    createdAt: AT,
    publishedAt: AT,
    ...overrides,
  };
}

export function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  const jobId = (overrides.jobId ?? "j_1") as JobId;
  return {
    jobId,
    dedupeKey: `dk_${jobId}`,
    kind: "change_analysis",
    repoId: "r_1" as RepoId,
    projectId: null,
    streamId: null,
    state: "queued",
    payload: {
      kind: "change",
      eventId: "e_1" as ChangeEventId,
      baseSha: "b".repeat(40),
      headSha: "c".repeat(40),
      mergeBaseSha: "d".repeat(40),
      streamKind: "default_branch",
    },
    attempt: 0,
    errorCode: null,
    errorDetail: null,
    progress: null,
    outputGenerationId: null,
    createdAt: AT,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

export function makeChange(
  overrides: Partial<ChangeRecord> = {},
): ChangeRecord {
  const eventId = (overrides.eventId ?? "e_1") as ChangeEventId;
  return {
    eventId,
    eventKey: `ek_${eventId}`,
    repoId: "r_1" as RepoId,
    projectId: "p_1" as ProjectId,
    streamId: "default_branch",
    streamKind: "default_branch",
    kind: "commit",
    baseSha: "b".repeat(40),
    headSha: "c".repeat(40),
    mergeBaseSha: "d".repeat(40),
    baseContextSha: null,
    significance: "full",
    state: "discovered",
    jobId: null,
    gapReason: null,
    linkedEventId: null,
    linkRelation: null,
    discoveredAt: AT,
    publishedAt: null,
    payload: { commit: { firstParent: null, associatedCommits: [] } },
    ...overrides,
  };
}

export function makeLesson(overrides: Partial<LessonRow> = {}): LessonRow {
  const lessonId = (overrides.lessonId ?? "l_1") as LessonId;
  return {
    lessonId,
    generationId: "g_1" as GenerationId,
    kind: "research",
    title: "Lesson",
    relPath: `lessons/${lessonId}.json`,
    jsonSha256: "0".repeat(64),
    publishedAt: AT,
    ...overrides,
  };
}

export function makeSource(overrides: Partial<SourceRow> = {}): SourceRow {
  const sourceId = (overrides.sourceId ?? "s_1") as SourceId;
  return {
    generationId: "g_1" as GenerationId,
    sourceId,
    kind: "repo",
    commitSha: "a".repeat(40),
    payloadJson: JSON.stringify({ path: "src/index.ts" }),
    contentHash: `sha256:${"1".repeat(64)}`,
    ...overrides,
  };
}

export function makeSnapshot(
  overrides: Partial<SnapshotRecord> = {},
): SnapshotRecord {
  return {
    repoId: "r_1" as RepoId,
    commitSha: "a".repeat(40),
    treeHash: "tree-1",
    worktreePath: "/tmp/work/a",
    resolvedAt: AT,
    ...overrides,
  };
}

export function makeMessage(
  overrides: Partial<MessageRecord> = {},
): MessageRecord {
  const messageId = (overrides.messageId ?? "m_1") as MessageId;
  return {
    messageId,
    conversationId: "c_1" as ConversationId,
    role: "assistant",
    content: "answer",
    status: "complete",
    answerPhase: "complete",
    citations: [],
    selection: null,
    checks: null,
    unknownReason: null,
    incomplete: false,
    createdAt: AT,
    ...overrides,
  };
}

export function makeUsage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    usageId: "u_1",
    jobId: null,
    conversationId: null,
    kind: "qa",
    provider: "scripted",
    model: "scripted-model",
    inputTokens: 10,
    outputTokens: 5,
    calls: 1,
    costCents: null,
    createdAt: AT,
    ...overrides,
  };
}

export function makeReadingPosition(
  overrides: Partial<ReadingPosition> = {},
): ReadingPosition {
  return {
    generationId: "g_1" as GenerationId,
    lessonId: "l_1" as LessonId,
    conversationId: null,
    offset: 3,
    updatedAt: AT,
    ...overrides,
  };
}

export function makeModelSettings(
  overrides: Partial<ModelSettings> = {},
): ModelSettings {
  return {
    provider: "openai",
    model: "gpt-example",
    maxOutputTokens: 4096,
    temperature: 0.2,
    pricing: { inputCentsPerMTok: 10, outputCentsPerMTok: 30 },
    quota: {
      maxCalls: 100,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 200_000,
    },
    ...overrides,
  };
}

export function makeCitation(overrides: Partial<Citation> = {}): Citation {
  return {
    sourceId: "s_1" as SourceId,
    generationId: "g_1" as GenerationId,
    commitSha: "a".repeat(40),
    label: "src/index.ts:1-3",
    ...overrides,
  };
}

/** A payload shape the `change` pipeline can round-trip. */
export function makeChangePayload(): ChangeEventPayload {
  return { commit: { firstParent: "b".repeat(40), associatedCommits: [] } };
}
