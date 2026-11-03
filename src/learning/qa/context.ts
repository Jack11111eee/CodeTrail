/**
 * Context assembly for a read-only answer (architecture §11.2, PRD §9).
 *
 * The section order is fixed and is the single implementation for one- and
 * two-generation conversations: selection → recent dialogue (with a
 * source-tagged summary for whatever was dropped) → this turn's retrieval →
 * learner preferences. `assembleMultiContext` in `multi-context.ts` owns the
 * algorithm; this module declares the result shape and degenerates a
 * single-generation request into exactly that order.
 *
 * `QaSelection` and `ContextBudget` are declared in `contracts/ports.ts` and
 * only re-exported here (P0-A).
 */

import type {
  ContextBudget,
  GenerationId,
  LearnerPreferences,
  MessageRecord,
  QaSelection,
  RetrievalHit,
  SourceId,
} from "../contracts/index.js";
import { assembleSections } from "./multi-context.js";

export type { ContextBudget, QaSelection } from "../contracts/index.js";

export type ContextSectionRole =
  | "selection"
  | "history_summary"
  | "history"
  | "retrieval"
  | "preferences";

export interface ContextSection {
  role: ContextSectionRole;
  tokens: number;
  text: string;
  sources: SourceId[];
  /** Present for a retrieval section in a multi-generation conversation. */
  generationId?: GenerationId;
}

export interface AssembledContext {
  sections: ContextSection[];
  totalTokens: number;
  truncated: boolean;
  /** What the budget could not cover, named for the `incomplete` answer. */
  uncovered: string[];
}

export interface AssembleContextInput {
  selection: QaSelection | null;
  messages: MessageRecord[];
  retrieved: RetrievalHit[];
  preferences: LearnerPreferences;
  budget: ContextBudget;
}

/** Assembles a single-generation context in the mandated order. */
export function assembleContext(input: AssembleContextInput): AssembledContext {
  const generationId = input.retrieved[0]?.binding.generationId;
  return assembleSections({
    selection: input.selection,
    messages: input.messages,
    retrieved: [{ generationId, hits: input.retrieved }],
    preferences: input.preferences,
    budget: input.budget,
  });
}
