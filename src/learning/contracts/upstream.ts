import type { ChatModelLike } from "./foundation.js";
import type { GenerationId } from "./ids.js";
import type { PageManifestView, WikiGraph } from "./refs.js";

export interface WikiHit {
  page: string;
  anchor: string;
  title: string;
  preview: string;
}

export interface WikiSectionResult {
  page: string;
  anchor: string;
  content: string;
}

export interface ClaimView {
  id: string;
  statement: string;
  /** "repo://path#Lx-Ly". */
  evidence: { resource: string; version: string }[];
}

/** Build side: nothing is sealed, no row exists. Accepted by claims/mermaid only. */
export interface StagedWikiRef {
  state: "staged";
  generationId: GenerationId;
  commitSha: string;
  knowledgeDir: string;
}

/** Read side: the row is published and sealed. */
export interface PublishedWikiRef {
  state: "published";
  generationId: GenerationId;
  commitSha: string;
  knowledgeDir: string;
  sealedTreeHash: string;
}

export type WikiRef = StagedWikiRef | PublishedWikiRef;

export interface GenerationRunRequest {
  /** Per-job build worktree (writable). */
  worktreePath: string;
  mode: "init" | "update";
  language: "zh";
  modelId: string;
  model: ChatModelLike;
  planningContext?: string;
  force?: boolean;
  /** Literal false — the adapter never allows true. */
  writeRepoFiles: false;
  onEvent?: (e: UpstreamRunEvent) => void;
}

export interface UpstreamRunEvent {
  type: "repository_progress" | "tool_start" | "tool_end" | "text";
  stage?: string;
  page?: string;
  name?: string;
  message?: string;
}

export interface UpstreamGenerationPort {
  run(
    req: GenerationRunRequest,
  ): Promise<{ skipped: boolean; sourceChanged: boolean }>;
  sourceFingerprint(worktreePath: string): Promise<string>;
  treeHashOfWorktree(worktreePath: string): Promise<string>;
  changedPaths(
    worktreePath: string,
    baseGitHead: string | undefined,
  ): Promise<string[]>;
  lastUpdate(
    worktreePath: string,
  ): Promise<{ gitHead?: string; status?: string; language?: string } | null>;
  pageManifest(worktreePath: string): Promise<PageManifestView | null>;
}

/** Read side. */
export interface UpstreamRetrievalPort {
  search(
    ref: PublishedWikiRef,
    query: string,
    hints?: string[],
    limit?: number,
  ): Promise<WikiHit[]>;
  readSections(
    ref: PublishedWikiRef,
    page: string,
    anchors: string[],
  ): Promise<WikiSectionResult[]>;
  pageTitle(ref: PublishedWikiRef, page: string): Promise<string>;
}

/** Build side. */
export interface UpstreamClaimsPort {
  /** discoverPages(). */
  pages(ref: WikiRef): Promise<string[]>;
  claimsFor(ref: WikiRef, page: string): Promise<ClaimView[]>;
  markdown(ref: WikiRef, page: string): Promise<string>;
}

/** Read side. */
export interface UpstreamGraphPort {
  graph(ref: PublishedWikiRef): Promise<WikiGraph>;
}

/** Build side. */
export interface UpstreamMermaidPort {
  validate(
    mermaid: string,
  ): Promise<
    { ok: true; mode: "strict" | "heuristic" } | { ok: false; message: string }
  >;
}
