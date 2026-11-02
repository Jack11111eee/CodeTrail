/**
 * Lesson builders and the publish-gating decision (architecture §9.3/§9.5).
 *
 * A builder runs against a `StagedGenerationRef`: nothing is sealed, no
 * `generations` row exists and no `assertPublished` guard is on this path.
 * The flow per lesson is exactly the architecture's:
 *
 *   assemble* skeleton → one model call with the evidence catalog →
 *   parseLesson → validateEvidence → validateLabels → validateDiagram →
 *   validateSemantic (≤1 targeted repair) → set `checks`.
 *
 * A lesson whose structural or evidence check fails is dropped. If that leaves
 * zero lessons, `blankTeaching` is true and `assertPublishable` throws
 * `conflict` with `details.reason = "blank_teaching"`; nothing is published.
 * Partial coverage is publishable, provided `coverageGaps` is non-empty.
 */

import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import { LearningError, newLessonId } from "../contracts/index.js";
import type {
  BuildChangeLessonInput,
  BuildComparisonLessonInput,
  BuildLessonsInput,
  BuildLessonsResult,
  CheckStatus,
  ClaimView,
  CoverageReport,
  EvidenceCatalogEntry,
  GenerationConfig,
  Lesson,
  LessonChecks,
  ModelHandle,
  SemanticRepairFn,
  SourceRef,
  SourceRegistry,
  StagedGenerationRef,
  UpstreamClaimsPort,
  UpstreamMermaidPort,
  ValidationContext,
  ValidationIssue,
  WikiRef,
} from "../contracts/index.js";
import { buildCatalog, createSourceReader } from "../evidence/index.js";
import type { SourceRegistryInternals } from "../evidence/index.js";
import { createUpstreamClaimsPort } from "../upstream/claims.js";
import { createUpstreamMermaidPort } from "../upstream/mermaid.js";
import { languageOf } from "../projects/scope.js";
import {
  assembleComponentDiagram,
  assembleContext,
  assembleOverview,
  assembleScenarioCandidates,
  scenarioKindFor,
  isUiProject,
  type AssembleInput,
} from "./assemble.js";
import type { AnyLesson } from "./schema.js";
import { parseLesson } from "./schema.js";
import { validateDiagram } from "./validate/diagram.js";
import { validateEvidence } from "./validate/evidence.js";
import { validateLabels } from "./validate/labels.js";
import { validateSemantic } from "./validate/semantic.js";
import { validateStructural } from "./validate/structural.js";

// Keep the re-export surface stable (architecture §9.3/§9.4).
export type {
  BuildChangeLessonInput,
  BuildComparisonLessonInput,
  BuildLessonsInput,
  BuildLessonsResult,
};
export type {
  SemanticRepairFn,
  ValidationContext,
  ValidationIssue,
  ValidationResult,
} from "../contracts/index.js";

/** Optional seams. Production callers omit them; tests inject doubles. */
export interface BuildLessonServices {
  claims?: UpstreamClaimsPort;
  mermaid?: UpstreamMermaidPort;
  catalogBudgetChars?: number;
}

const DEFAULT_CONFIG: GenerationConfig = Object.freeze({
  language: "zh",
  model: {
    provider: "scripted",
    model: "scripted",
    maxOutputTokens: 1024,
    temperature: 0,
  },
  pageConcurrency: 1,
  promptTemplateVersion: "codetrail-lesson-v1",
  lessonPipelineVersion: "lp1",
  includeTests: false,
  externalDocs: { enabled: false, maxPerLesson: 0 },
});

const DEFAULT_CATALOG_BUDGET = 24_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coverageGapsOf(coverage: CoverageReport): string[] {
  return [...new Set(
    coverage.gaps.map((gap) =>
      gap.detail === undefined
        ? `${gap.path}: ${gap.reason}`
        : `${gap.path}: ${gap.reason} (${gap.detail})`,
    ),
  )];
}

function syntheticCoverage(
  generation: StagedGenerationRef,
  paths: readonly string[],
  gaps: readonly string[],
): CoverageReport {
  const analyzed = paths.map((path) => ({
    path,
    bytes: 0,
    language: languageOf(path),
  }));
  return {
    generationId: generation.generationId,
    commitSha: generation.commitSha,
    complete: gaps.length === 0,
    analyzed,
    gaps: gaps.map((path) => ({
      path,
      reason: "excluded_by_scope" as const,
      bytes: 0,
    })),
    counts: {
      totalFiles: analyzed.length + gaps.length,
      analyzedFiles: analyzed.length,
      excludedFiles: gaps.length,
    },
    languages: { byLanguage: [], preferredCoverageOk: false },
  };
}

function wikiRef(generation: StagedGenerationRef): WikiRef {
  return {
    state: "staged",
    generationId: generation.generationId,
    commitSha: generation.commitSha,
    knowledgeDir: generation.knowledgeDir,
  };
}

function parseRepoResource(
  resource: string,
): { path: string; lines: { start: number; end: number } | null } | null {
  const match = /^repo:\/\/([^#]+)(?:#L(\d+)(?:-L?(\d+))?)?$/u.exec(resource);
  if (match === null) return null;
  const path = match[1];
  if (match[2] === undefined) return { path, lines: null };
  const start = Number(match[2]);
  const end = match[3] === undefined ? start : Number(match[3]);
  return { path, lines: { start, end } };
}

function isRegistryInternals(
  registry: SourceRegistry,
): registry is SourceRegistryInternals {
  return typeof (registry as Partial<SourceRegistryInternals>).recordGap === "function";
}

/** Registers every `repo://` resource a claim cites, reading the snapshot. */
async function registerClaimSources(
  claims: readonly ClaimView[],
  input: BuildLessonsInput,
): Promise<void> {
  const seen = new Set<string>();

  for (const claim of claims) {
    for (const evidence of claim.evidence) {
      const parsed = parseRepoResource(evidence.resource);
      if (parsed === null) continue;
      const key = `${parsed.path}\0${JSON.stringify(parsed.lines)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      try {
        await input.registry.registerRepo({
          generationId: input.generation.generationId,
          repoId: input.generation.repoId,
          commitSha: input.generation.commitSha,
          path: parsed.path,
          lines: parsed.lines,
          snapshot: input.snapshot,
          scope: input.scope,
        });
      } catch (error) {
        if (isRegistryInternals(input.registry)) {
          input.registry.recordGap(input.generation.generationId, {
            kind: "repo",
            status: "source_missing",
            subject: parsed.path,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
}

function safeAll(registry: SourceRegistry, generationId: string): SourceRef[] {
  try {
    return registry.all(generationId as Parameters<typeof registry.all>[0]);
  } catch {
    return [];
  }
}

async function catalogFor(
  input: BuildLessonsInput,
  services: BuildLessonServices,
): Promise<EvidenceCatalogEntry[]> {
  const refs = safeAll(input.registry, input.generation.generationId);
  if (refs.length === 0) return [];

  const reader = createSourceReader({
    snapshotFor: () => input.snapshot,
    external: input.external,
  });

  return buildCatalog(
    refs,
    reader,
    services.catalogBudgetChars ?? DEFAULT_CATALOG_BUDGET,
  );
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (isRecord(block) && typeof block.text === "string") return block.text;
      return "";
    })
    .join("");
}

async function invokeModel(
  model: ModelHandle,
  system: string,
  human: string,
): Promise<string> {
  const output = await model.chat().invoke([
    new SystemMessage(system),
    new HumanMessage(human),
  ]);
  return contentText(output.content);
}

function parseLessonJson(text: string): Record<string, unknown> | null {
  let body = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(body);
  if (fenced !== null) body = fenced[1].trim();

  const tryParse = (candidate: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed) && isRecord(parsed.lesson)) return parsed.lesson;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const direct = tryParse(body);
  if (direct !== null) return direct;

  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return tryParse(body.slice(start, end + 1));
  }
  return null;
}

interface DraftIdentity {
  lessonId: string;
  generationId: string;
  kind: "research" | "change" | "comparison";
  context: Record<string, unknown>;
  scenario: unknown;
  overview: unknown;
  diagram: unknown;
  coverageGaps: string[];
}

/** Merges the model's teaching text with the deterministic skeleton. */
function mergeDraft(
  raw: Record<string, unknown>,
  identity: DraftIdentity,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const modelGaps = Array.isArray(raw.coverageGaps)
    ? raw.coverageGaps.filter((gap): gap is string => typeof gap === "string")
    : [];

  return {
    ...raw,
    lessonId:
      typeof raw.lessonId === "string" && raw.lessonId !== ""
        ? raw.lessonId
        : identity.lessonId,
    generationId: identity.generationId,
    kind: identity.kind,
    context: identity.context,
    scenario: isRecord(raw.scenario) ? raw.scenario : identity.scenario,
    overview: Array.isArray(raw.overview) ? raw.overview : identity.overview,
    choicesOmittedReason: raw.choicesOmittedReason ?? null,
    diagram: isRecord(raw.diagram) ? raw.diagram : identity.diagram,
    coverageGaps: [...new Set([...identity.coverageGaps, ...modelGaps])],
    checks: { structural: "pass", evidence: "pass", semantic: "pass" },
    ...extra,
  };
}

function draftIdentity(
  input: BuildLessonsInput,
  skeleton: AssembleInput,
  kind: DraftIdentity["kind"],
  lessonId: string,
  coverage: CoverageReport,
): DraftIdentity {
  return {
    lessonId,
    generationId: input.generation.generationId,
    kind,
    context: assembleContext(skeleton) as unknown as Record<string, unknown>,
    scenario: assembleScenarioCandidates(skeleton)[0],
    overview: assembleOverview(skeleton),
    diagram: assembleComponentDiagram(skeleton),
    coverageGaps: coverageGapsOf(coverage),
  };
}

/** The mutable teaching fields a targeted repair may replace. */
const REPAIRABLE_FIELDS = [
  "overview",
  "plainExplanation",
  "technicalExplanation",
  "choices",
  "choicesOmittedReason",
  "boundaries",
  "statements",
  "evidence",
  "diagram",
  "coverageGaps",
] as const;

function mergeRepair(
  current: AnyLesson,
  raw: Record<string, unknown>,
): AnyLesson {
  const merged: Record<string, unknown> = { ...current };
  for (const field of REPAIRABLE_FIELDS) {
    if (field in raw) merged[field] = raw[field];
  }
  return merged as unknown as AnyLesson;
}

function repairSystem(catalog: unknown): string {
  return [
    "You repair a lesson whose claims are not fully supported by evidence.",
    "Return one JSON lesson object with corrected teaching fields only.",
    `Evidence catalog: ${JSON.stringify(catalog)}`,
  ].join("\n");
}

function makeRepair(
  model: ModelHandle,
  catalog: unknown,
): SemanticRepairFn {
  return async ({ lesson, issues }) => {
    const text = await invokeModel(
      model,
      repairSystem(catalog),
      `Fix these issues: ${JSON.stringify(issues)}`,
    );
    const raw = parseLessonJson(text);
    if (raw === null) return lesson;
    return mergeRepair(lesson, raw) as Lesson;
  };
}

function systemPrompt(catalog: unknown, subject: string): string {
  return [
    "You write one publication-grade lesson as JSON only.",
    `Subject: ${subject}`,
    `Evidence catalog: ${JSON.stringify(catalog)}`,
  ].join("\n");
}

type MutableLessonList = AnyLesson[];

export interface EvaluatedLesson {
  lesson: AnyLesson;
  checks: LessonChecks;
  issues: ValidationIssue[];
}

const DIAGRAM_STRUCTURAL_CODES: ReadonlySet<string> = new Set([
  "diagram_mermaid",
  "diagram_kind",
]);
const DIAGRAM_EVIDENCE_CODES: ReadonlySet<string> = new Set([
  "diagram_evidence",
]);

function statusOf(ok: boolean): CheckStatus {
  return ok ? "pass" : "failed";
}

/**
 * Runs the full validator chain over one lesson. Exported so tests and the
 * publish gate can inspect `checks` before a failed lesson is dropped.
 */
export async function evaluateLesson(
  lesson: AnyLesson,
  ctx: ValidationContext,
  repair: SemanticRepairFn,
): Promise<EvaluatedLesson> {
  const structural = validateStructural(lesson, ctx);
  const evidence = await validateEvidence(lesson, ctx);
  const labels = validateLabels(lesson, ctx);
  const diagram = await validateDiagram(lesson, ctx);
  const semantic = await validateSemantic(lesson, ctx, repair);

  const diagramStructural = diagram.issues.filter((entry) =>
    DIAGRAM_STRUCTURAL_CODES.has(entry.code),
  );
  const diagramEvidence = diagram.issues.filter((entry) =>
    DIAGRAM_EVIDENCE_CODES.has(entry.code),
  );

  const checks: LessonChecks = {
    structural: statusOf(
      structural.ok && diagramStructural.length === 0,
    ),
    evidence: statusOf(evidence.ok && labels.ok && diagramEvidence.length === 0),
    semantic: statusOf(semantic.result.ok),
    ...(semantic.result.ok
      ? {}
      : {
          semanticDetail: semantic.result.issues
            .map((entry) => entry.message)
            .join("; "),
        }),
  };

  return {
    lesson: semantic.lesson,
    checks,
    issues: [
      ...structural.issues,
      ...evidence.issues,
      ...labels.issues,
      ...diagram.issues,
      ...semantic.result.issues,
    ],
  };
}

/** True when every check passed; a failed lesson is never published. */
export function lessonPublishable(checks: LessonChecks): boolean {
  return (
    checks.structural === "pass" &&
    checks.evidence === "pass" &&
    checks.semantic === "pass"
  );
}

function finish(
  lessons: MutableLessonList,
  failures: BuildLessonsResult["failures"],
): BuildLessonsResult {
  return {
    lessons: lessons as unknown as Lesson[],
    failures,
    blankTeaching: lessons.length === 0,
  };
}

interface BuildFlow {
  input: BuildLessonsInput;
  coverage: CoverageReport;
  ctx: ValidationContext;
  catalog: unknown;
  identity: (lessonId: string) => DraftIdentity;
  extra: Record<string, unknown>;
  kind: "research" | "change" | "comparison";
}

async function runFlow(flow: BuildFlow): Promise<BuildLessonsResult> {
  const model = flow.input.model;
  const lessons: MutableLessonList = [];
  const failures: BuildLessonsResult["failures"] = [];

  const subject =
    flow.kind === "research"
      ? "research lesson"
      : flow.kind === "change"
        ? "change lesson"
        : "comparison lesson";

  const text = await invokeModel(
    model,
    systemPrompt(flow.catalog, subject),
    `Return the ${subject} JSON.`,
  );

  const raw = parseLessonJson(text);
  if (raw === null) {
    failures.push({
      lessonIdHint: flow.identity("").lessonId,
      failures: [
        {
          group: "statements",
          path: "",
          message: "model returned no lesson JSON",
        },
      ],
    });
    return finish(lessons, failures);
  }

  const draft = mergeDraft(raw, flow.identity(""), flow.extra);
  const parsed = parseLesson(draft, { isUiProject: flow.ctx.isUiProject });
  if (!parsed.ok) {
    failures.push({
      lessonIdHint: flow.identity("").lessonId,
      failures: parsed.failures,
    });
    return finish(lessons, failures);
  }

  const repair = makeRepair(model, flow.catalog);
  const evaluated = await evaluateLesson(parsed.lesson, flow.ctx, repair);
  if (lessonPublishable(evaluated.checks)) {
    lessons.push(evaluated.lesson);
  }

  return finish(lessons, failures);
}

function researchInput(
  input: BuildLessonsInput,
  claims: ClaimView[],
  pages: string[],
  coverage: CoverageReport,
  services: BuildLessonServices,
): BuildFlow {
  const skeleton: AssembleInput = {
    generation: input.generation,
    snapshot: input.snapshot,
    scope: input.scope,
    coverage,
    claims,
    pages,
    config: DEFAULT_CONFIG,
  };
  const scenarioKind = scenarioKindFor(skeleton);
  const subject = pages[0] ?? "main";

  return {
    input,
    coverage,
    kind: "research",
    ctx: {
      mode: "research",
      generation: input.generation,
      registry: input.registry,
      snapshot: input.snapshot,
      baseSnapshot: null,
      scope: input.scope,
      coverage,
      mermaid: services.mermaid ?? createUpstreamMermaidPort(),
      isUiProject: isUiProject(coverage.analyzed),
      allowedCommitShas: [input.generation.commitSha],
    },
    catalog: [],
    identity: (lessonIdHint: string) =>
      draftIdentity(
        input,
        skeleton,
        "research",
        lessonIdHint === ""
          ? newLessonId(
              `${input.generation.generationId}:${subject}:${scenarioKind}`,
            )
          : lessonIdHint,
        coverage,
      ),
    extra: {},
  };
}

async function runResearch(
  input: BuildLessonsInput,
  services: BuildLessonServices,
): Promise<BuildLessonsResult> {
  const claimsPort = services.claims ?? createUpstreamClaimsPort();
  const ref = wikiRef(input.generation);
  let pages: string[];
  const claims: ClaimView[] = [];

  try {
    pages = await claimsPort.pages(ref);
  } catch {
    pages = [];
  }
  for (const page of pages) {
    try {
      claims.push(...(await claimsPort.claimsFor(ref, page)));
    } catch {
      // A page without claims contributes no evidence; never invent one.
    }
  }

  await registerClaimSources(claims, input);

  const skeletonInput = researchInput(
    input,
    claims,
    pages,
    input.coverage,
    services,
  );
  const catalog = await catalogFor(input, services);
  skeletonInput.catalog = catalog;

  return runFlow(skeletonInput);
}

/** Builds research lessons from a staged generation's wiki and claims. */
export function buildResearchLessons(
  input: BuildLessonsInput,
  services: BuildLessonServices = {},
): Promise<BuildLessonsResult> {
  return runResearch(input, services);
}

function changeFlow(
  input: BuildChangeLessonInput,
  services: BuildLessonServices,
): BuildFlow {
  const paths = input.diff.entries.map((entry) => entry.path);
  const gaps = [
    ...input.diff.gaps,
    ...(input.baseSnapshot === null
      ? input.diff.entries
          .filter((entry) => entry.status === "D")
          .map((entry) => entry.oldPath ?? entry.path)
      : []),
  ];
  const coverage = syntheticCoverage(input.generation, paths, gaps);
  const skeleton: AssembleInput = {
    generation: input.generation,
    snapshot: input.headSnapshot,
    scope: input.scope,
    coverage,
    claims: [],
    pages: [],
    config: DEFAULT_CONFIG,
  };
  const baseInput: BuildLessonsInput = {
    generation: input.generation,
    snapshot: input.headSnapshot,
    scope: input.scope,
    coverage,
    model: input.model,
    registry: input.registry,
    external: input.external,
    clock: input.clock,
  };

  return {
    input: baseInput,
    coverage,
    kind: "change",
    ctx: {
      mode: "change",
      generation: input.generation,
      registry: input.registry,
      snapshot: input.headSnapshot,
      baseSnapshot: input.baseSnapshot,
      scope: input.scope,
      coverage,
      mermaid: services.mermaid ?? createUpstreamMermaidPort(),
      isUiProject: isUiProject(coverage.analyzed),
      allowedCommitShas: [input.generation.commitSha],
    },
    catalog: [],
    identity: (lessonIdHint: string) =>
      draftIdentity(
        baseInput,
        skeleton,
        "change",
        lessonIdHint === ""
          ? newLessonId(`${input.generation.generationId}:change:${input.event.eventId}`)
          : lessonIdHint,
        coverage,
      ),
    extra: {
      eventId: input.event.eventId,
    },
  };
}

/** Builds the single change lesson for a change generation. */
export async function buildChangeLesson(
  input: BuildChangeLessonInput,
  services: BuildLessonServices = {},
): Promise<BuildLessonsResult> {
  const flow = changeFlow(input, services);
  flow.catalog = await catalogFor(flow.input, services);
  return runFlow(flow);
}

function comparisonFlow(
  input: BuildComparisonLessonInput,
  services: BuildLessonServices,
): BuildFlow {
  const coverage = input.coverage;
  const skeleton: AssembleInput = {
    generation: input.generation,
    snapshot: input.headSnapshot,
    scope: input.scope,
    coverage,
    claims: [],
    pages: [],
    config: DEFAULT_CONFIG,
  };
  const baseInput: BuildLessonsInput = {
    generation: input.generation,
    snapshot: input.headSnapshot,
    scope: input.scope,
    coverage,
    model: input.model,
    registry: input.registry,
    external: input.external,
    clock: input.clock,
  };
  const comparisonContext = {
    ...(assembleContext(skeleton) as unknown as Record<string, unknown>),
    commitSha: input.head.commitSha,
    comparison: {
      base: {
        repoId: input.base.repoId,
        commitSha: input.base.commitSha,
        generationId: input.base.generationId,
      },
      head: {
        repoId: input.head.repoId,
        commitSha: input.head.commitSha,
        generationId: input.head.generationId,
      },
    },
  };

  return {
    input: baseInput,
    coverage,
    kind: "comparison",
    ctx: {
      mode: "comparison",
      generation: input.generation,
      registry: input.registry,
      snapshot: input.headSnapshot,
      baseSnapshot: input.baseSnapshot,
      scope: input.scope,
      coverage,
      mermaid: services.mermaid ?? createUpstreamMermaidPort(),
      isUiProject: isUiProject(coverage.analyzed),
      allowedCommitShas: [input.head.commitSha, input.base.commitSha],
    },
    catalog: [],
    identity: (lessonIdHint: string) => ({
      lessonId:
        lessonIdHint === ""
          ? newLessonId(
              `${input.generation.generationId}:comparison:${input.base.commitSha}:${input.head.commitSha}`,
            )
          : lessonIdHint,
      generationId: input.generation.generationId,
      kind: "comparison",
      context: comparisonContext,
      scenario: assembleScenarioCandidates(skeleton)[0],
      overview: assembleOverview(skeleton),
      diagram: assembleComponentDiagram(skeleton),
      coverageGaps: coverageGapsOf(coverage),
    }),
    extra: {
      baseGenerationId: null,
      headGenerationId: null,
    },
  };
}

/** Builds the single comparison lesson for two independently versioned sides. */
export async function buildComparisonLesson(
  input: BuildComparisonLessonInput,
  services: BuildLessonServices = {},
): Promise<BuildLessonsResult> {
  const flow = comparisonFlow(input, services);
  flow.catalog = await catalogFor(flow.input, services);
  return runFlow(flow);
}

// ── publish gating (architecture §9.5) ─────────────────────────────────────

export type PublishVerdict =
  | { publishable: true }
  | { publishable: false; reason: "blank_teaching" };

/**
 * The publish decision. `blankTeaching` is true when no publishable lesson
 * remains; partial coverage is deliberately publishable.
 */
export function publishVerdict(result: BuildLessonsResult): PublishVerdict {
  if (result.blankTeaching || result.lessons.length === 0) {
    return { publishable: false, reason: "blank_teaching" };
  }
  return { publishable: true };
}

/**
 * Throws the job-level failure (§9.5): `conflict` with
 * `details.reason = "blank_teaching"`. Publishing nothing is a hard failure,
 * never an empty success.
 */
export function assertPublishable(result: BuildLessonsResult): void {
  const verdict = publishVerdict(result);
  if (!verdict.publishable) {
    throw new LearningError("conflict", "没有可发布的教学内容", {
      reason: verdict.reason,
    });
  }
}
