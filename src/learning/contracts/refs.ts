import { LearningError } from "./errors.js";
import type { GenerationId, JobId, RepoId } from "./ids.js";
import type { GenerationRecord } from "./store.js";

export type RepoKind = "local" | "github";
/** "local:<realpath>" | "github:<owner>/<repo>" (owner/repo lowercased for the key only). */
export type RepoIdentity = string;

interface GenerationRefBase {
  /** Derived from cacheKey — known before any row exists. */
  readonly generationId: GenerationId;
  readonly repoId: RepoId;
  readonly commitSha: string;
  /** staging/<jobId>/knowledge, then knowledge/<gid>. */
  readonly knowledgeDir: string;
}

/** Build-time. No DB row, nothing sealed, nothing served. Never resolvable over HTTP. */
export interface StagedGenerationRef extends GenerationRefBase {
  readonly state: "staged";
  readonly jobId: JobId;
  readonly baseContextSha: string | null;
}

/** Read-time. Requires generations.status === "published". */
export interface PublishedGenerationRef extends GenerationRefBase {
  readonly state: "published";
  readonly sealedTreeHash: string;
  readonly publishedAt: string;
  readonly comparisonBase: {
    commitSha: string;
    generationId: GenerationId | null;
  } | null;
}

export type AnyGenerationRef = StagedGenerationRef | PublishedGenerationRef;

export function isStaged(r: AnyGenerationRef): r is StagedGenerationRef {
  return r.state === "staged";
}

export function isPublished(r: AnyGenerationRef): r is PublishedGenerationRef {
  return r.state === "published";
}

export function stagedRef(i: {
  generationId: GenerationId;
  repoId: RepoId;
  commitSha: string;
  knowledgeDir: string;
  jobId: JobId;
  baseContextSha: string | null;
}): StagedGenerationRef {
  return {
    state: "staged",
    generationId: i.generationId,
    repoId: i.repoId,
    commitSha: i.commitSha,
    knowledgeDir: i.knowledgeDir,
    jobId: i.jobId,
    baseContextSha: i.baseContextSha,
  };
}

export function publishedRef(g: GenerationRecord): PublishedGenerationRef {
  if (g.status !== "published" || g.sealedTreeHash === null) {
    throw new LearningError("unpublished_generation", "该生成版本尚未发布", {
      generationId: g.generationId,
      status: g.status,
    });
  }
  return {
    state: "published",
    generationId: g.generationId,
    repoId: g.repoId,
    commitSha: g.commitSha,
    knowledgeDir: g.contentDir,
    sealedTreeHash: g.sealedTreeHash,
    publishedAt: g.publishedAt ?? g.createdAt,
    comparisonBase: g.comparisonBaseSha
      ? { commitSha: g.comparisonBaseSha, generationId: null }
      : null,
  };
}

export interface GenerationConfig {
  language: "zh";
  model: {
    provider: string;
    model: string;
    baseUrl?: string | null;
    maxOutputTokens: number;
    temperature: number;
  };
  pageConcurrency: number;
  promptTemplateVersion: string;
  lessonPipelineVersion: string;
  includeTests: boolean;
  externalDocs: { enabled: boolean; maxPerLesson: number };
}

export interface WikiGraphNode {
  id: string;
  label: string;
  page: string;
  kind: string;
}

export interface WikiGraphEdge {
  from: string;
  to: string;
  label: string;
}

export interface WikiGraph {
  nodes: WikiGraphNode[];
  edges: WikiGraphEdge[];
  generatedAt: string;
}

export interface PageManifestView {
  schemaVersion: 1;
  pages: Record<
    string,
    {
      pageVersion: string;
      gitHead?: string;
      sourceFingerprint?: string;
      completedBy?: string;
      completedRunId?: string;
    }
  >;
}
