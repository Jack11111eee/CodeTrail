/**
 * Semantic-index extension point (architecture §10.5, AC-RET-09).
 *
 * V1 ships the seam only: an interface, an empty registry and `active()`
 * returning `null`. No embedding library is imported, no model is loaded and
 * no network call is made — retrieval is FTS5 plus the snapshot fallback.
 */

import type { Binding } from "../contracts/index.js";

export interface SemanticIndexExtension {
  readonly id: string;
  index(
    binding: Binding,
    documents: { id: string; text: string }[],
  ): Promise<void>;
  query(
    binding: Binding,
    text: string,
    limit: number,
  ): Promise<{ id: string; score: number }[]>;
}

export interface SemanticIndexRegistry {
  register(ext: SemanticIndexExtension): void;
  /** Always `null` in V1: no implementation is instantiated. */
  active(): SemanticIndexExtension | null;
}

/**
 * The V1 registry. `register` accepts an extension so a future version can
 * wire one in without an API change, but nothing is ever activated and the
 * registry holds no state that could make `active()` non-null.
 */
export function createSemanticIndexRegistry(): SemanticIndexRegistry {
  return {
    register(_ext: SemanticIndexExtension): void {
      // Deliberately inert in V1.
      void _ext;
    },
    active(): SemanticIndexExtension | null {
      return null;
    },
  };
}

export const semanticIndexes: SemanticIndexRegistry =
  createSemanticIndexRegistry();
