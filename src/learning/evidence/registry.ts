/**
 * The source registry (architecture §8.1).
 *
 * The write side (`register*`) is used by the lesson builder while the
 * generation has no database row. It validates every repo source against the
 * immutable snapshot, derives a deterministic id and keeps the ref in a
 * process-local map. It never writes `sources` or `generations` — those rows
 * appear only inside the publish transaction.
 *
 * The read side (`get`/`all`) serves refs staged by *this* registry instance
 * and otherwise reads persisted `sources` rows, after asserting the generation
 * is published. A fresh registry therefore cannot read staged refs before the
 * publish transaction, but a registry reopened after restart sees exactly the
 * rows the publish wrote.
 */

import { LearningError } from "../contracts/index.js";
import type {
  Clock,
  ExternalDocService,
  ExternalFetchResult,
  ExternalSourceRef,
  GenerationId,
  GenerationRecord,
  GenerationsRepo,
  RegisterRepoSourceInput,
  RepoSourceRef,
  SnapshotReader,
  SourceGap,
  SourceId,
  SourceReader,
  SourceRef,
  SourceRow,
  SourcesRepo,
  TeachingExampleRef,
} from "../contracts/index.js";
import {
  linesOf,
  sliceHash,
  sliceLines,
  sourceIdOf,
} from "../contracts/index.js";
import { assertReadable } from "../projects/scope.js";

export type {
  RegisterRepoSourceInput,
  SourceRegistry,
} from "../contracts/index.js";
import type { SourceRegistry } from "../contracts/index.js";

/**
 * Extra write-side affordances the builder needs. The public `SourceRegistry`
 * port stays exactly as declared in `contracts/ports.ts`; `createSourceRegistry`
 * returns this richer object, which is assignable to it.
 */
export interface SourceRegistryInternals extends SourceRegistry {
  /** Binds external / teaching-example registrations to a generation. */
  bindGeneration(generationId: GenerationId): void;
  /** Records a `source_missing`/`source_removed` gap for a generation. */
  recordGap(generationId: GenerationId, gap: SourceGap): void;
  /** The persisted generation row, when one exists (used by multi-view). */
  generationFor(generationId: GenerationId): GenerationRecord | null;
}

export interface SourceRegistryDeps {
  clock: Clock;
  sources: SourcesRepo;
  generations: GenerationsRepo;
}

function invalid(
  message: string,
  details?: Record<string, unknown>,
): LearningError {
  return new LearningError("invalid_input", message, details);
}

function mismatched(
  message: string,
  details?: Record<string, unknown>,
): LearningError {
  return new LearningError("version_mismatch", message, details);
}

function notFound(
  message: string,
  details?: Record<string, unknown>,
): LearningError {
  return new LearningError("not_found", message, details);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid(`${field} is required`, { field });
  }
  return value;
}

/** Whole-file refs use the literal `null` segment so commits stay distinct. */
function lineSegment(lines: { start: number; end: number } | null): string {
  return lines === null ? "null" : `${lines.start}-${lines.end}`;
}

/** Deterministic repo id: kind + path + commit + lines (architecture §8.1). */
export function repoSourceId(
  path: string,
  commitSha: string,
  lines: { start: number; end: number } | null,
): SourceId {
  return sourceIdOf("repo", `${path}\0${commitSha}\0${lineSegment(lines)}`);
}

function hydrateRef(row: SourceRow): SourceRef {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payloadJson);
  } catch {
    throw new LearningError("internal_error", "来源记录无法解析", {
      sourceId: row.sourceId,
    });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new LearningError("internal_error", "来源记录格式无效", {
      sourceId: row.sourceId,
    });
  }
  const ref = parsed as SourceRef;
  if (ref.kind !== row.kind) {
    throw new LearningError("internal_error", "来源类型不一致", {
      sourceId: row.sourceId,
    });
  }
  // The row is authoritative for identity; the payload carries everything else.
  if (ref.kind === "repo") {
    return {
      ...ref,
      sourceId: row.sourceId,
      generationId: row.generationId,
      commitSha: row.commitSha,
    };
  }
  return { ...ref, sourceId: row.sourceId };
}

/**
 * Builds a `sources` row from a ref. Repo refs carry their generation; an
 * external/teaching ref does not, so the caller supplies the generation (and
 * optionally the generation commit for the `commit_sha` column).
 */
export function sourceRowFromRef(
  ref: SourceRef,
  generationId?: GenerationId,
  commitSha?: string,
): SourceRow {
  if (ref.kind === "repo") {
    return {
      generationId: ref.generationId,
      sourceId: ref.sourceId,
      kind: ref.kind,
      commitSha: ref.commitSha,
      payloadJson: JSON.stringify(ref),
      contentHash: ref.contentHash,
    };
  }
  if (generationId === undefined) {
    throw invalid("外部来源需要生成版本", { sourceId: ref.sourceId });
  }
  return {
    generationId,
    sourceId: ref.sourceId,
    kind: ref.kind,
    commitSha: commitSha ?? "",
    payloadJson: JSON.stringify(ref),
    contentHash: ref.kind === "external" ? ref.contentHash : "",
  };
}

export function createSourceRegistry(
  deps: SourceRegistryDeps,
): SourceRegistryInternals {
  const staged = new Map<GenerationId, Map<SourceId, SourceRef>>();
  const recordedGaps = new Map<GenerationId, SourceGap[]>();
  let activeGenerationId: GenerationId | null = null;

  function assertPublished(generationId: GenerationId): void {
    const record = deps.generations.byId(generationId);
    if (record === null || record.status !== "published") {
      throw new LearningError("unpublished_generation", "该生成版本尚未发布", {
        generationId,
        status: record?.status ?? null,
      });
    }
  }

  function stage(generationId: GenerationId, ref: SourceRef): void {
    let bucket = staged.get(generationId);
    if (bucket === undefined) {
      bucket = new Map<SourceId, SourceRef>();
      staged.set(generationId, bucket);
    }
    bucket.set(ref.sourceId, ref);
  }

  function requireActiveGeneration(): GenerationId {
    if (activeGenerationId === null) {
      throw invalid("尚未绑定生成版本", { field: "generationId" });
    }
    return activeGenerationId;
  }

  function validateLines(
    text: string,
    lines: { start: number; end: number },
  ): void {
    if (!Number.isInteger(lines.start) || !Number.isInteger(lines.end)) {
      throw invalid("line range must be integers", { lines });
    }
    if (lines.start < 1 || lines.end < lines.start) {
      throw invalid("line range is invalid", { lines });
    }
    const lineCount = linesOf(text).length;
    if (lines.end > lineCount) {
      throw invalid("line range is past end of file", {
        lines,
        lineCount,
      });
    }
  }

  return {
    bindGeneration(generationId: GenerationId): void {
      activeGenerationId = generationId;
    },

    recordGap(generationId: GenerationId, gap: SourceGap): void {
      const bucket = recordedGaps.get(generationId);
      if (bucket === undefined) {
        recordedGaps.set(generationId, [gap]);
      } else {
        bucket.push(gap);
      }
    },

    generationFor(generationId: GenerationId) {
      return deps.generations.byId(generationId);
    },

    async registerRepo(input: RegisterRepoSourceInput): Promise<RepoSourceRef> {
      const { generationId, repoId, commitSha, path: relPath, lines } = input;
      const { snapshot, scope } = input;

      if (snapshot.repoId !== repoId) {
        throw invalid("snapshot belongs to another repo", {
          repoId,
          snapshotRepoId: snapshot.repoId,
        });
      }
      if (snapshot.commitSha !== commitSha) {
        throw mismatched("snapshot is bound to another commit", {
          commitSha,
          snapshotCommitSha: snapshot.commitSha,
        });
      }

      assertReadable(relPath, scope);
      if (!(await snapshot.exists(relPath))) {
        throw notFound("文件不存在", { path: relPath });
      }

      const text = await snapshot.read(relPath);
      let content: string;
      if (lines === null) {
        content = text;
      } else {
        validateLines(text, lines);
        content = sliceLines(text, lines);
      }

      const ref: RepoSourceRef = {
        sourceId: repoSourceId(relPath, commitSha, lines),
        kind: "repo",
        generationId,
        repoId,
        commitSha,
        path: relPath,
        lines,
        contentHash: sliceHash(content),
      };

      activeGenerationId = generationId;
      stage(generationId, ref);
      return ref;
    },

    registerExternal(input: ExternalFetchResult): ExternalSourceRef {
      if (!input.ok) {
        // Never construct a ref for a failed fetch (AC-RET-08).
        throw new LearningError(
          "external_source_unavailable",
          "外部资料暂不可用",
          { reason: input.reason },
        );
      }

      const canonicalUrl = requireNonEmptyString(
        input.canonicalUrl,
        "canonicalUrl",
      );
      const versionOrRetrievedAt = requireNonEmptyString(
        input.versionOrRetrievedAt,
        "versionOrRetrievedAt",
      );
      const contentHash = requireNonEmptyString(
        input.contentHash,
        "contentHash",
      );
      if (typeof input.locator !== "string") {
        throw invalid("locator is required", { field: "locator" });
      }
      if (typeof input.title !== "string" || input.title.trim() === "") {
        throw invalid("title is required", { field: "title" });
      }

      let parsed: URL;
      try {
        parsed = new URL(canonicalUrl);
      } catch {
        throw invalid("canonicalUrl must be an absolute URL", {
          field: "canonicalUrl",
        });
      }
      if (parsed.protocol !== "https:") {
        throw invalid("canonicalUrl must use https", {
          field: "canonicalUrl",
          protocol: parsed.protocol,
        });
      }

      const ref: ExternalSourceRef = {
        sourceId: sourceIdOf("external", `${canonicalUrl}\0${input.locator}`),
        kind: "external",
        canonicalUrl,
        versionOrRetrievedAt,
        locator: input.locator,
        contentHash,
        title: input.title,
      };

      stage(requireActiveGeneration(), ref);
      return ref;
    },

    registerTeachingExample(input: {
      exampleId: string;
      label: string;
    }): TeachingExampleRef {
      const exampleId = requireNonEmptyString(input.exampleId, "exampleId");
      const label = requireNonEmptyString(input.label, "label");
      const ref: TeachingExampleRef = {
        sourceId: sourceIdOf("teaching_example", exampleId),
        kind: "teaching_example",
        exampleId,
        label,
      };
      stage(requireActiveGeneration(), ref);
      return ref;
    },

    get(generationId: GenerationId, sourceId: SourceId): SourceRef | null {
      const bucket = staged.get(generationId);
      if (bucket !== undefined) {
        return bucket.get(sourceId) ?? null;
      }
      assertPublished(generationId);
      const row = deps.sources.get(generationId, sourceId);
      return row === null ? null : hydrateRef(row);
    },

    all(generationId: GenerationId): SourceRef[] {
      const bucket = staged.get(generationId);
      if (bucket !== undefined) {
        return [...bucket.values()].sort((left, right) =>
          left.sourceId.localeCompare(right.sourceId),
        );
      }
      assertPublished(generationId);
      return deps.sources
        .all(generationId)
        .map(hydrateRef)
        .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    },

    gaps(generationId: GenerationId): SourceGap[] {
      return [...(recordedGaps.get(generationId) ?? [])];
    },
  };
}

export interface SourceReaderDeps {
  /** Returns the read-only snapshot bound to `commitSha`. */
  snapshotFor(commitSha: string): SnapshotReader;
  external: ExternalDocService;
}

/**
 * Reads evidence exactly, re-verifying the registered `contentHash` so a
 * changed snapshot or a tampered cache is a `source_drift` failure rather than
 * silently different text.
 */
export function createSourceReader(deps: SourceReaderDeps): SourceReader {
  return {
    async readRepo(ref, scope): Promise<string> {
      void scope;
      const snapshot = deps.snapshotFor(ref.commitSha);
      if (snapshot.commitSha !== ref.commitSha) {
        throw mismatched("快照与来源提交不一致", {
          commitSha: ref.commitSha,
          snapshotCommitSha: snapshot.commitSha,
        });
      }
      const text = await snapshot.read(ref.path);
      const content = ref.lines === null ? text : sliceLines(text, ref.lines);
      if (sliceHash(content) !== ref.contentHash) {
        throw new LearningError("source_drift", "来源内容已变化", {
          sourceId: ref.sourceId,
          path: ref.path,
        });
      }
      return content;
    },

    async readExternal(ref): Promise<string> {
      const text = await deps.external.cached(ref.contentHash);
      if (text === null) {
        throw new LearningError(
          "external_source_unavailable",
          "外部资料暂不可用",
          {
            sourceId: ref.sourceId,
            url: ref.canonicalUrl,
          },
        );
      }
      if (sliceHash(text) !== ref.contentHash) {
        throw new LearningError("source_drift", "来源内容已变化", {
          sourceId: ref.sourceId,
          url: ref.canonicalUrl,
        });
      }
      return text;
    },
  };
}
