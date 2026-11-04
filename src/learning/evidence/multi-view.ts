/**
 * Read-only multi-generation projection (architecture §8.4).
 *
 * Comparison generations hold base- and head-side sources inside one
 * generation; two-generation conversations hold two generations inside one
 * answer. `multiView` binds a registry to a fixed generation list and makes the
 * `version_mismatch` rule enforceable: a source id belonging to a foreign
 * generation — or a repo ref whose commit is not one of the generation's
 * allowed commits — is rejected.
 */

import { LearningError } from "../contracts/index.js";
import type {
  GenerationId,
  GenerationRecord,
  SourceId,
  SourceRef,
  SourceRegistry,
} from "../contracts/index.js";

export type { SourceRegistry };
export { createSourceReader } from "./registry.js";
export type { SourceReaderDeps } from "./registry.js";

export interface GenerationSourceView {
  readonly generationIds: readonly GenerationId[];
  get(sourceId: SourceId): SourceRef | null;
  all(): SourceRef[];
  ownerOf(sourceId: SourceId): GenerationId | null;
  /** Throws `version_mismatch` when the id does not belong to this view. */
  assertBelongsTo(sourceId: SourceId): SourceRef;
  allowedCommitShas(): readonly string[];
}

/** `[g.commitSha] ∪ (g.comparisonBaseSha ? [g.comparisonBaseSha] : [])`. */
export function allowedCommitShas(g: GenerationRecord): readonly string[] {
  return g.comparisonBaseSha === null || g.comparisonBaseSha === ""
    ? [g.commitSha]
    : [g.commitSha, g.comparisonBaseSha];
}

function versionMismatch(
  sourceId: SourceId,
  generationIds: readonly GenerationId[],
): LearningError {
  return new LearningError("version_mismatch", "来源不属于该生成版本", {
    sourceId,
    generationIds,
  });
}

interface GenerationLookup {
  generationFor(generationId: GenerationId): GenerationRecord | null;
}

function hasGenerationLookup(
  registry: SourceRegistry,
): registry is SourceRegistry & GenerationLookup {
  return (
    typeof (registry as Partial<GenerationLookup>).generationFor === "function"
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function multiView(
  registry: SourceRegistry,
  generationIds: GenerationId[],
): GenerationSourceView {
  const ids = Object.freeze([...new Set(generationIds)]);

  function commitsFor(generationId: GenerationId): string[] {
    if (hasGenerationLookup(registry)) {
      const record = registry.generationFor(generationId);
      if (record !== null) {
        return [...allowedCommitShas(record)];
      }
    }
    // Build-time: no generation row exists yet, so the registered repo refs
    // are the only evidence of which commits this generation covers.
    return unique(
      registry
        .all(generationId)
        .filter((ref) => ref.kind === "repo")
        .map((ref) => ref.commitSha),
    );
  }

  function ownerOf(sourceId: SourceId): GenerationId | null {
    for (const generationId of ids) {
      if (registry.get(generationId, sourceId) !== null) {
        return generationId;
      }
    }
    return null;
  }

  return {
    generationIds: ids,

    get(sourceId: SourceId): SourceRef | null {
      const owner = ownerOf(sourceId);
      return owner === null ? null : registry.get(owner, sourceId);
    },

    all(): SourceRef[] {
      const byId = new Map<SourceId, SourceRef>();
      for (const generationId of ids) {
        for (const ref of registry.all(generationId)) {
          if (!byId.has(ref.sourceId)) {
            byId.set(ref.sourceId, ref);
          }
        }
      }
      return [...byId.values()].sort((left, right) =>
        left.sourceId.localeCompare(right.sourceId),
      );
    },

    ownerOf,

    assertBelongsTo(sourceId: SourceId): SourceRef {
      for (const generationId of ids) {
        const ref = registry.get(generationId, sourceId);
        if (ref === null) {
          continue;
        }
        if (ref.kind === "repo") {
          const allowed = commitsFor(generationId);
          if (allowed.length > 0 && !allowed.includes(ref.commitSha)) {
            throw versionMismatch(sourceId, ids);
          }
        }
        return ref;
      }
      throw versionMismatch(sourceId, ids);
    },

    allowedCommitShas(): readonly string[] {
      return unique(ids.flatMap((generationId) => commitsFor(generationId)));
    },
  };
}
