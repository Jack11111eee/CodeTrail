import type {
  ChangeEventId,
  GenerationId,
  LessonId,
  RepoId,
  SourceId,
} from "./ids.js";

/** The four statement labels PRD §7 requires. */
export type StatementLabel =
  | "code_fact"
  | "recorded_design_rationale"
  | "engineering_analysis"
  | "teaching_example";

export type BoundaryStatus = "implemented" | "demo" | "planned" | "unknown";
export type DiagramKind = "component" | "sequence" | "state" | "timeline";
export type DiagramNodeStatus = "observed" | "inferred" | "planned" | "demo";
export type ScenarioKind =
  "user_flow" | "api_call" | "cli" | "library_interface";
/** PRD §7 spells the failure value `failed`. `fail` does not exist anywhere in the codebase. */
export type CheckStatus = "pass" | "failed" | "skipped";
export type LessonKind = "research" | "change" | "comparison";

export interface LessonTerm {
  zh: string;
  en: string;
  symbol?: string;
}

export interface ComparisonSide {
  repoId: RepoId;
  commitSha: string;
  generationId: GenerationId;
}

export interface LessonContext {
  repoId: RepoId;
  commitSha: string;
  generationId: GenerationId;
  scenarioId: string;
  moduleIds: string[];
  /**
   * Present iff the owning lesson's `kind === "comparison"` (validator-enforced).
   * `commitSha` above is then `comparison.head.commitSha`.
   */
  comparison?: { base: ComparisonSide; head: ComparisonSide };
}

export interface LessonScenario {
  id: string;
  kind: ScenarioKind;
  inputs: string[];
  userAction: string;
  observableResult: string;
  isExample: true;
}

export interface LessonModuleOverview {
  moduleId: string;
  responsibility: string;
  inputs: string[];
  outputs: string[];
}

export interface PlainExplanation {
  mechanismId: string;
  text: string;
}

export interface TechnicalExplanation {
  mechanismId: string;
  terms: LessonTerm[];
  text: string;
}

export interface LessonAlternative {
  option: string;
  whenItFits: string;
  cost: string;
  evidenceIds: SourceId[];
}

export interface LessonChoice {
  decision: string;
  current: string;
  alternatives: LessonAlternative[];
  evidenceIds: SourceId[];
}

export interface LessonBoundary {
  item: string;
  status: BoundaryStatus;
  limits: string;
  evidenceIds: SourceId[];
}

export interface LessonStatement {
  id: string;
  label: StatementLabel;
  text: string;
  evidenceIds: SourceId[];
  /** Comparison lessons only; ignored (and rejected if present) elsewhere. */
  side?: "base" | "head" | "both";
}

export interface DiagramNode {
  id: string;
  label: string;
  evidenceIds: SourceId[];
  status: DiagramNodeStatus;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label: string;
  evidenceIds: SourceId[];
  inferred: boolean;
}

export interface LessonDiagram {
  kind: DiagramKind;
  mermaid: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

/**
 * Render-side projection of a diagram (§9.6 `toRenderData`). Declared here — not
 * in `lessons/` — because `LessonDetailView.diagram` exposes it over HTTP.
 */
export interface RenderDiagram {
  kind: DiagramKind;
  commitSha: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  mermaid: string;
  inferredEdgeIds: string[];
  plannedNodeIds: string[];
  demoNodeIds: string[];
}

export interface LessonChecks {
  structural: CheckStatus;
  evidence: CheckStatus;
  semantic: CheckStatus;
  semanticDetail?: string;
}

/** The nine+one groups AC-LES-01/02 enumerate. */
export type RequiredLessonGroup =
  | "context"
  | "scenario"
  | "overview"
  | "plainExplanation"
  | "technicalExplanation"
  | "choices"
  | "boundaries"
  | "statements"
  | "evidence"
  | "diagram";

export interface StructuralFailure {
  group: RequiredLessonGroup;
  path: string;
  message: string;
}

/**
 * Fields shared by every lesson kind. `kind` lives on the concrete types below
 * as a *literal*, so `z.discriminatedUnion("kind", …)` and `LessonDetailView`
 * narrowing both work. (A `ChangeLesson extends Lesson` would be impossible:
 * `Lesson.kind` is the literal `"research"`.)
 */
export interface LessonBase {
  lessonId: LessonId;
  generationId: GenerationId;
  context: LessonContext;
  scenario: LessonScenario;
  overview: LessonModuleOverview[];
  plainExplanation: PlainExplanation[];
  technicalExplanation: TechnicalExplanation[];
  choices: LessonChoice[];
  choicesOmittedReason: string | null;
  boundaries: LessonBoundary[];
  statements: LessonStatement[];
  evidence: SourceId[];
  diagram: LessonDiagram;
  coverageGaps: string[];
  checks: LessonChecks;
}

/** A research lesson. `kind` is the literal `"research"`, not the wide union. */
export interface Lesson extends LessonBase {
  kind: "research";
}

/** Change lessons additionally carry the six PRD §10 fields (AC-UPD-27). */
export interface ChangeRecordFields {
  behaviorChange: { before: string; after: string };
  affectedModules: { moduleId: string; effect: string }[];
  keyTechnologies: string[];
  alternatives: LessonAlternative[];
  evidence: SourceId[];
  unverifiedEffects: string[];
}

export interface ChangeLesson extends LessonBase, ChangeRecordFields {
  kind: "change";
  eventId: ChangeEventId;
  omittedReasons: Partial<Record<keyof ChangeRecordFields, string>>;
}

/** Comparison lessons: before/after sides, no wiki, sources from two commits. */
export interface ComparisonLesson extends LessonBase {
  kind: "comparison";
  context: LessonContext & {
    comparison: { base: ComparisonSide; head: ComparisonSide };
  };
  /** Set when a published research generation existed for that side at build time. */
  baseGenerationId: GenerationId | null;
  headGenerationId: GenerationId | null;
}
