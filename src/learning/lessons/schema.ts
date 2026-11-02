/**
 * Lesson schema and publish gate (architecture §9.1).
 *
 * A zod mirror of `contracts/lesson.ts` plus the cross-field invariants the
 * publish gate depends on. `AnyLessonSchema` is a discriminated union over
 * `kind`, so a `change` or `comparison` payload can never be accepted by the
 * research schema: a missing `ChangeRecordFields` member or a missing
 * `context.comparison` is reported by that kind's own schema.
 *
 * `parseLesson` reports every failure as a `StructuralFailure` carrying the
 * required group it belongs to, the dotted path and a message that names the
 * offending field (AC-LES-01/02). The publish gate treats `ok: false` as a
 * block; nothing here calls a model or touches a database.
 */

import { z } from "zod";

import { LearningError } from "../contracts/index.js";
import type {
  ChangeEventId,
  ChangeLesson,
  ComparisonLesson,
  DiagramKind,
  GenerationId,
  Lesson,
  LessonId,
  LessonKind,
  RepoId,
  RequiredLessonGroup,
  SourceId,
  StructuralFailure,
} from "../contracts/index.js";

export type { RequiredLessonGroup, StructuralFailure };

export type AnyLesson = Lesson | ChangeLesson | ComparisonLesson;

/** Every required group AC-LES-01/02 enumerate; a superset is never enough. */
export const REQUIRED_LESSON_GROUPS: readonly RequiredLessonGroup[] =
  Object.freeze([
    "context",
    "scenario",
    "overview",
    "plainExplanation",
    "technicalExplanation",
    "choices",
    "boundaries",
    "statements",
    "evidence",
    "diagram",
  ]);

const GROUP_SET: ReadonlySet<string> = new Set(REQUIRED_LESSON_GROUPS);

const nonEmpty = z.string().min(1);
const idList = z.array(nonEmpty);

/**
 * Branded ids are plain strings at runtime. `z.custom` is the only shape that
 * validates a string while producing the branded `SourceId`/`LessonId` type
 * the contracts require.
 */
function brandedId<T extends string>(): z.ZodType<T> {
  return z.custom<T>((value) => typeof value === "string" && value.length > 0);
}

const sourceId = brandedId<SourceId>();
const sourceIds = z.array(sourceId);

// ── building blocks ─────────────────────────────────────────────────────────

const lessonTermSchema = z.object({
  zh: nonEmpty,
  en: nonEmpty,
  symbol: z.string().optional(),
});

const comparisonSideSchema = z.object({
  repoId: brandedId<RepoId>(),
  commitSha: nonEmpty,
  generationId: brandedId<GenerationId>(),
});

const comparisonContextSchema = z.object({
  repoId: brandedId<RepoId>(),
  commitSha: nonEmpty,
  generationId: brandedId<GenerationId>(),
  scenarioId: nonEmpty,
  moduleIds: idList,
  comparison: z.object({
    base: comparisonSideSchema,
    head: comparisonSideSchema,
  }),
});

/** Research/change lessons must not carry `context.comparison` at all. */
const plainContextSchema = z.object({
  repoId: brandedId<RepoId>(),
  commitSha: nonEmpty,
  generationId: brandedId<GenerationId>(),
  scenarioId: nonEmpty,
  moduleIds: idList,
  comparison: z.undefined().optional(),
});

const scenarioSchema = z.object({
  id: nonEmpty,
  kind: z.enum(["user_flow", "api_call", "cli", "library_interface"]),
  inputs: z.array(z.string()),
  userAction: nonEmpty,
  observableResult: nonEmpty,
  isExample: z.literal(true),
});

const moduleOverviewSchema = z.object({
  moduleId: nonEmpty,
  responsibility: nonEmpty,
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
});

const plainExplanationSchema = z.object({
  mechanismId: nonEmpty,
  text: nonEmpty,
});

const technicalExplanationSchema = z.object({
  mechanismId: nonEmpty,
  terms: z.array(lessonTermSchema),
  text: nonEmpty,
});

const alternativeSchema = z.object({
  option: nonEmpty,
  whenItFits: nonEmpty,
  cost: nonEmpty,
  evidenceIds: sourceIds,
});

const choiceSchema = z.object({
  decision: nonEmpty,
  current: nonEmpty,
  alternatives: z.array(alternativeSchema),
  evidenceIds: sourceIds,
});

const boundarySchema = z.object({
  item: nonEmpty,
  status: z.enum(["implemented", "demo", "planned", "unknown"]),
  limits: nonEmpty,
  evidenceIds: sourceIds,
});

/**
 * Research/change statements reject `side`: `z.undefined()` is a *known* key,
 * so a supplied value is a type error instead of being silently stripped.
 */
const plainStatementSchema = z.object({
  id: nonEmpty,
  label: z.enum([
    "code_fact",
    "recorded_design_rationale",
    "engineering_analysis",
    "teaching_example",
  ]),
  text: nonEmpty,
  evidenceIds: sourceIds,
  side: z.undefined().optional(),
});

const comparisonStatementSchema = z.object({
  id: nonEmpty,
  label: z.enum([
    "code_fact",
    "recorded_design_rationale",
    "engineering_analysis",
    "teaching_example",
  ]),
  text: nonEmpty,
  evidenceIds: sourceIds,
  side: z.enum(["base", "head", "both"]),
});

const diagramNodeSchema = z.object({
  id: nonEmpty,
  label: nonEmpty,
  evidenceIds: sourceIds,
  status: z.enum(["observed", "inferred", "planned", "demo"]),
});

const diagramEdgeSchema = z.object({
  from: nonEmpty,
  to: nonEmpty,
  label: nonEmpty,
  evidenceIds: sourceIds,
  inferred: z.boolean(),
});

const diagramSchema = z.object({
  kind: z.enum(["component", "sequence", "state", "timeline"]),
  mermaid: z.string(),
  nodes: z.array(diagramNodeSchema),
  edges: z.array(diagramEdgeSchema),
});

const checksSchema = z.object({
  structural: z.enum(["pass", "failed", "skipped"]),
  evidence: z.enum(["pass", "failed", "skipped"]),
  semantic: z.enum(["pass", "failed", "skipped"]),
  semanticDetail: z.string().optional(),
});

const changeRecordShape = {
  behaviorChange: z.object({ before: z.string(), after: z.string() }),
  affectedModules: z.array(z.object({ moduleId: nonEmpty, effect: nonEmpty })),
  keyTechnologies: z.array(z.string()),
  alternatives: z.array(alternativeSchema),
  unverifiedEffects: z.array(z.string()),
};

const changeRecordKeys = z.enum([
  "behaviorChange",
  "affectedModules",
  "keyTechnologies",
  "alternatives",
  "evidence",
  "unverifiedEffects",
]);

/** Fields every lesson kind carries; `kind`, `context` and statements vary. */
function sharedShape<K extends LessonKind>(kind: K) {
  return {
    kind: z.literal(kind),
    lessonId: brandedId<LessonId>(),
    generationId: brandedId<GenerationId>(),
    scenario: scenarioSchema,
    overview: z.array(moduleOverviewSchema),
    plainExplanation: z.array(plainExplanationSchema),
    technicalExplanation: z.array(technicalExplanationSchema),
    choices: z.array(choiceSchema),
    choicesOmittedReason: z.string().nullable(),
    boundaries: z.array(boundarySchema),
    evidence: sourceIds,
    diagram: diagramSchema,
    coverageGaps: z.array(z.string()),
    checks: checksSchema,
  };
}

interface CommonFields {
  choices: unknown[];
  choicesOmittedReason: string | null;
  diagram: {
    nodes?: { id?: unknown }[];
    edges?: { from?: unknown; to?: unknown }[];
  };
}

/**
 * Invariants shared by every kind: an empty `choices` array needs a reason,
 * and every edge endpoint must name a node the diagram declares.
 *
 * Both guards are deliberately conditional: a missing group is already
 * reported by the object schema, and adding a second issue here would violate
 * AC-LES-02's "deleting one field yields exactly one failure".
 */
function commonRefinements(value: CommonFields, ctx: z.RefinementCtx): void {
  if (Array.isArray(value.choices) && value.choices.length === 0) {
    const reason = value.choicesOmittedReason;
    if (typeof reason !== "string" || reason.trim() === "") {
      ctx.addIssue({
        code: "custom",
        path: ["choicesOmittedReason"],
        message: "required when choices is empty",
      });
    }
  }

  const diagram = value.diagram;
  if (
    diagram !== undefined &&
    diagram !== null &&
    Array.isArray(diagram.nodes) &&
    Array.isArray(diagram.edges)
  ) {
    const declared = new Set(diagram.nodes.map((node) => node?.id));
    diagram.edges.forEach((edge, index) => {
      for (const endpoint of ["from", "to"] as const) {
        if (!declared.has(edge?.[endpoint])) {
          ctx.addIssue({
            code: "custom",
            path: ["diagram", "edges", index, endpoint],
            message: `references undeclared node id ${JSON.stringify(
              edge?.[endpoint] ?? null,
            )}`,
          });
        }
      }
    });
  }
}

// ── the three kind-specific schemas ─────────────────────────────────────────

const researchLessonSchema = z
  .object({
    ...sharedShape("research"),
    context: plainContextSchema,
    statements: z.array(plainStatementSchema),
  })
  .superRefine(commonRefinements);

const changeLessonSchema = z
  .object({
    ...sharedShape("change"),
    context: plainContextSchema,
    statements: z.array(plainStatementSchema),
    eventId: brandedId<ChangeEventId>(),
    omittedReasons: z.partialRecord(changeRecordKeys, z.string()),
    ...changeRecordShape,
  })
  .superRefine(commonRefinements);

const comparisonLessonSchema = z
  .object({
    ...sharedShape("comparison"),
    context: comparisonContextSchema,
    statements: z.array(comparisonStatementSchema),
    baseGenerationId: brandedId<GenerationId>().nullable(),
    headGenerationId: brandedId<GenerationId>().nullable(),
  })
  .superRefine((value, ctx) => {
    commonRefinements(value, ctx);
    const comparison = value.context.comparison;
    if (comparison.base.commitSha === comparison.head.commitSha) {
      ctx.addIssue({
        code: "custom",
        path: ["context", "comparison", "head", "commitSha"],
        message: "base and head must name different commits",
      });
    }
  });

/** A research lesson. */
export const LessonSchema: z.ZodType<Lesson> = researchLessonSchema;
/** A change lesson: the six `ChangeRecordFields` are required. */
export const ChangeLessonSchema: z.ZodType<ChangeLesson> = changeLessonSchema;
/** A comparison lesson: `context.comparison` and statement sides are required. */
export const ComparisonLessonSchema: z.ZodType<ComparisonLesson> =
  comparisonLessonSchema;

/** Discriminated on `kind`; this is what `parseLesson` and the gate use. */
export const AnyLessonSchema: z.ZodType<AnyLesson> = z.discriminatedUnion(
  "kind",
  [researchLessonSchema, changeLessonSchema, comparisonLessonSchema],
);

/** The schema that owns a kind; no kind is ever checked by another's schema. */
export function schemaForKind(kind: LessonKind): z.ZodTypeAny {
  switch (kind) {
    case "research":
      return LessonSchema;
    case "change":
      return ChangeLessonSchema;
    case "comparison":
      return ComparisonLessonSchema;
  }
}

// ── failure mapping ─────────────────────────────────────────────────────────

function groupForPath(path: readonly PropertyKey[]): RequiredLessonGroup {
  const first = String(path[0] ?? "");
  if (GROUP_SET.has(first)) {
    return first as RequiredLessonGroup;
  }
  // Change-record and identity/meta fields have no group of their own;
  // `context` is the group that owns the lesson's identity.
  switch (first) {
    case "choicesOmittedReason":
      return "choices";
    case "coverageGaps":
      return "evidence";
    case "behaviorChange":
    case "affectedModules":
    case "keyTechnologies":
    case "alternatives":
    case "unverifiedEffects":
    case "eventId":
    case "omittedReasons":
    case "baseGenerationId":
    case "headGenerationId":
    case "lessonId":
    case "generationId":
    case "kind":
    case "checks":
      return "context";
    default:
      return "context";
  }
}

function toStructuralFailure(issue: z.ZodIssue): StructuralFailure {
  const path = issue.path.map(String).join(".");
  const field = path === "" ? "lesson" : path;
  return {
    group: groupForPath(issue.path),
    path,
    // The message always names the field so AC-LES-02 can assert on it.
    message: `${field}: ${issue.message}`,
  };
}

// ── parsing ─────────────────────────────────────────────────────────────────

/**
 * Parses a candidate lesson. The optional second argument keeps the frozen
 * one-argument contract (`(raw) => …`) while letting the gate reject a
 * `user_flow` scenario on a project with no UI surface (AC-LES-12).
 */
export function parseLesson(
  raw: unknown,
  opts: { isUiProject?: boolean } = {},
):
  | { ok: true; lesson: AnyLesson }
  | { ok: false; failures: StructuralFailure[] } {
  const result = AnyLessonSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      failures: result.error.issues.map(toStructuralFailure),
    };
  }

  if (opts.isUiProject === false && result.data.scenario.kind === "user_flow") {
    return {
      ok: false,
      failures: [
        {
          group: "scenario",
          path: "scenario.kind",
          message:
            "scenario.kind: user_flow requires a project with a UI surface",
        },
      ],
    };
  }

  return { ok: true, lesson: result.data };
}

// ── diagram purpose mapping (architecture §9.6) ─────────────────────────────

export type DiagramPurpose =
  "module_relation" | "request_roundtrip" | "version_change";

/** The single purpose → kind table; `lessons/diagram.ts` re-exports it. */
export const DIAGRAM_KIND_BY_PURPOSE: Readonly<
  Record<DiagramPurpose, readonly DiagramKind[]>
> = Object.freeze({
  module_relation: Object.freeze(["component"] as const),
  request_roundtrip: Object.freeze(["sequence"] as const),
  version_change: Object.freeze(["state", "timeline"] as const),
});

/** Change/comparison lessons teach a version change; a research lesson's
 *  purpose follows the scenario surface it explores. */
export function diagramPurposeOf(lesson: AnyLesson): DiagramPurpose {
  if (lesson.kind === "change" || lesson.kind === "comparison") {
    return "version_change";
  }
  switch (lesson.scenario.kind) {
    case "user_flow":
    case "api_call":
    case "cli":
      return "request_roundtrip";
    case "library_interface":
      return "module_relation";
  }
}

/** Throws `invalid_input` when `kind` is outside the purpose's list. */
export function assertDiagramKind(
  purpose: DiagramPurpose,
  kind: DiagramKind,
): void {
  const allowed = DIAGRAM_KIND_BY_PURPOSE[purpose];
  if (!allowed.includes(kind)) {
    throw new LearningError(
      "invalid_input",
      `diagram kind ${kind} does not fit purpose ${purpose}`,
      { purpose, kind, allowed: [...allowed] },
    );
  }
}
