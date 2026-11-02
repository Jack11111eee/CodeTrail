import type { DiffResult } from "./change.js";
import type { SourceId } from "./ids.js";
import type { Lesson, StructuralFailure } from "./lesson.js";
import type { ModelHandle } from "./foundation.js";
import type {
  Clock,
  ExternalDocService,
  SnapshotReader,
  SourceRegistry,
} from "./ports.js";
import type { StagedGenerationRef } from "./refs.js";
import type { CoverageReport, LanguageId, NormalizedScope } from "./scope.js";
import type { ChangeRecord } from "./store.js";
import type { UpstreamMermaidPort } from "./upstream.js";

export interface EvidenceCatalogEntry {
  sourceId: SourceId;
  /** "src/lmp/state/snapshot_cache.py:42-58". */
  label: string;
  /** ≤ 40 lines, trimmed. */
  excerpt: string;
  language: LanguageId;
}

export interface ValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/** Everything a validator may look at. Field names are normative. */
export interface ValidationContext {
  mode: "research" | "change" | "comparison";
  generation: StagedGenerationRef;
  registry: SourceRegistry;
  /** Head side. */
  snapshot: SnapshotReader;
  /** Non-null iff mode === "comparison". */
  baseSnapshot: SnapshotReader | null;
  scope: NormalizedScope;
  coverage: CoverageReport;
  mermaid: UpstreamMermaidPort;
  isUiProject: boolean;
  allowedCommitShas: readonly string[];
}

export type SemanticRepairFn = (i: {
  lesson: Lesson;
  issues: ValidationIssue[];
  catalog: EvidenceCatalogEntry[];
}) => Promise<Lesson>;

export interface BuildLessonsInput {
  /** Build side, no DB row, nothing sealed. */
  generation: StagedGenerationRef;
  snapshot: SnapshotReader;
  scope: NormalizedScope;
  coverage: CoverageReport;
  model: ModelHandle;
  registry: SourceRegistry;
  external: ExternalDocService;
  clock: Clock;
}

export interface BuildLessonsResult {
  lessons: Lesson[];
  failures: { lessonIdHint: string; failures: StructuralFailure[] }[];
  blankTeaching: boolean;
}

/** `StructuralFailure` is declared in contracts/lesson.ts. */
export interface BuildChangeLessonInput {
  /** The change generation being built. */
  generation: StagedGenerationRef;
  event: ChangeRecord;
  diff: DiffResult;
  /** null ⇒ deleted-side reads unavailable ⇒ gap. */
  baseSnapshot: SnapshotReader | null;
  headSnapshot: SnapshotReader;
  scope: NormalizedScope;
  model: ModelHandle;
  registry: SourceRegistry;
  external: ExternalDocService;
  clock: Clock;
}

export interface BuildComparisonLessonInput {
  /** Kind "comparison"; commitSha = head. */
  generation: StagedGenerationRef;
  base: StagedGenerationRef;
  head: StagedGenerationRef;
  diff: DiffResult;
  baseSnapshot: SnapshotReader;
  headSnapshot: SnapshotReader;
  scope: NormalizedScope;
  coverage: CoverageReport;
  model: ModelHandle;
  registry: SourceRegistry;
  external: ExternalDocService;
  clock: Clock;
}
