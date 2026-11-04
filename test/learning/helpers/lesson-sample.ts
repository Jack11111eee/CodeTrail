/**
 * Canonical lesson samples and a deterministic `AssembleInput`.
 *
 * Every test mutates a fresh copy of one of these samples, so a deletion case
 * can remove exactly one field without any other case observing it.
 */

import { stagedRef } from "../../../src/learning/contracts/index.ts";
import type {
  CoverageReport,
  GenerationConfig,
  GenerationId,
  JobId,
  RepoId,
  SnapshotReader,
  StagedGenerationRef,
} from "../../../src/learning/contracts/index.ts";
import type { AssembleInput } from "../../../src/learning/lessons/assemble.ts";
import {
  normalizeScope,
  languageOf,
} from "../../../src/learning/projects/scope.ts";

export const HEAD_SHA = "a".repeat(40);
export const BASE_SHA = "b".repeat(40);
export const OTHER_HEAD_SHA = "c".repeat(40);

const GENERATION_ID = "g_0123456789abcdef" as GenerationId;
const REPO_ID = "r_0123456789abcdef" as RepoId;
const JOB_ID = "j_0123456789abcdef" as JobId;

export function clone<T>(value: T): T {
  return structuredClone(value);
}

/** A valid research lesson; the shape every canonical sample starts from. */
export function researchLesson(): Record<string, unknown> {
  return {
    lessonId: "l_0123456789abcdef",
    generationId: GENERATION_ID,
    kind: "research",
    context: {
      repoId: REPO_ID,
      commitSha: HEAD_SHA,
      generationId: GENERATION_ID,
      scenarioId: "sc_0123456789abcdef",
      moduleIds: ["src"],
    },
    scenario: {
      id: "sc_0123456789abcdef",
      kind: "library_interface",
      inputs: ["label"],
      userAction: "调用公开接口",
      observableResult: "返回 slug",
      isExample: true,
    },
    overview: [
      {
        moduleId: "src",
        responsibility: "把标签转换成 URL 安全的 slug",
        inputs: ["label"],
        outputs: ["slug"],
      },
    ],
    plainExplanation: [{ mechanismId: "m1", text: "先去空格，再统一小写。" }],
    technicalExplanation: [
      {
        mechanismId: "m1",
        terms: [{ zh: "slug", en: "slug", symbol: "slugify" }],
        text: "用正则把非字母数字字符折叠成连字符。",
      },
    ],
    choices: [
      {
        decision: "用正则而不是手写循环",
        current: "正则",
        alternatives: [
          {
            option: "手写循环",
            whenItFits: "需要逐字符记录状态时",
            cost: "代码更长且更容易出错",
            evidenceIds: ["s_0123456789abcdef"],
          },
        ],
        evidenceIds: ["s_0123456789abcdef"],
      },
    ],
    choicesOmittedReason: null,
    boundaries: [
      {
        item: "只处理 ASCII",
        status: "implemented",
        limits: "非 ASCII 字符会被折叠掉",
        evidenceIds: ["s_0123456789abcdef"],
      },
    ],
    statements: [
      {
        id: "st1",
        label: "code_fact",
        text: "slugify 会先 trim 再小写。",
        evidenceIds: ["s_0123456789abcdef"],
      },
    ],
    evidence: ["s_0123456789abcdef"],
    diagram: {
      kind: "component",
      mermaid: 'flowchart LR\n  n1["src/index.ts"]',
      nodes: [
        {
          id: "n1",
          label: "src/index.ts",
          evidenceIds: ["s_0123456789abcdef"],
          status: "observed",
        },
      ],
      edges: [],
    },
    coverageGaps: [],
    checks: { structural: "pass", evidence: "pass", semantic: "pass" },
  };
}

/** A valid change lesson: all six `ChangeRecordFields` are present. */
export function changeLesson(): Record<string, unknown> {
  return {
    ...researchLesson(),
    kind: "change",
    eventId: "e_0123456789abcdef",
    omittedReasons: {},
    behaviorChange: { before: "使用 copies", after: "使用 quantity" },
    affectedModules: [{ moduleId: "src", effect: "库存字段改名" }],
    keyTechnologies: ["TypeScript"],
    alternatives: [
      {
        option: "保留旧字段",
        whenItFits: "有外部消费者时",
        cost: "需要长期维护兼容层",
        evidenceIds: ["s_0123456789abcdef"],
      },
    ],
    unverifiedEffects: [],
    diagram: {
      kind: "timeline",
      mermaid: "timeline\n  section 版本\n  旧字段 -> 新字段",
      nodes: [
        {
          id: "n1",
          label: "旧字段",
          evidenceIds: ["s_0123456789abcdef"],
          status: "observed",
        },
      ],
      edges: [],
    },
  };
}

/** A valid comparison lesson: distinct sides and a `side` on every statement. */
export function comparisonLesson(): Record<string, unknown> {
  const base = researchLesson();
  const context = base.context as Record<string, unknown>;
  return {
    ...base,
    kind: "comparison",
    context: {
      ...context,
      comparison: {
        base: {
          repoId: REPO_ID,
          commitSha: BASE_SHA,
          generationId: "g_base0123456789ab",
        },
        head: {
          repoId: REPO_ID,
          commitSha: OTHER_HEAD_SHA,
          generationId: GENERATION_ID,
        },
      },
    },
    statements: [
      {
        id: "st1",
        label: "code_fact",
        text: "字段从 copies 改成了 quantity。",
        evidenceIds: ["s_0123456789abcdef"],
        side: "both",
      },
    ],
    baseGenerationId: null,
    headGenerationId: null,
    diagram: {
      kind: "state",
      mermaid: "stateDiagram-v2\n  [*] --> copies",
      nodes: [
        {
          id: "n1",
          label: "copies",
          evidenceIds: ["s_0123456789abcdef"],
          status: "observed",
        },
      ],
      edges: [],
    },
  };
}

// ── deterministic AssembleInput ─────────────────────────────────────────────

export const GENERATION_CONFIG: GenerationConfig = {
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
};

export function emptyCoverage(paths: string[] = []): CoverageReport {
  const analyzed = paths.map((path) => ({
    path,
    bytes: 0,
    language: languageOf(path),
  }));
  return {
    generationId: GENERATION_ID,
    commitSha: HEAD_SHA,
    complete: true,
    analyzed,
    gaps: [],
    counts: {
      totalFiles: analyzed.length,
      analyzedFiles: analyzed.length,
      excludedFiles: 0,
    },
    languages: { byLanguage: [], preferredCoverageOk: false },
  };
}

export function defaultGeneration(
  overrides: Partial<StagedGenerationRef> = {},
): StagedGenerationRef {
  return stagedRef({
    generationId: overrides.generationId ?? GENERATION_ID,
    repoId: overrides.repoId ?? REPO_ID,
    commitSha: overrides.commitSha ?? HEAD_SHA,
    knowledgeDir: overrides.knowledgeDir ?? "/tmp/knowledge",
    jobId: overrides.jobId ?? JOB_ID,
    baseContextSha: overrides.baseContextSha ?? null,
  });
}

/**
 * A reader that fails on any access. The assemblers are pure functions of the
 * coverage/page/claim inputs and must never touch the snapshot.
 */
export function unusedSnapshot(
  repoId: RepoId = REPO_ID,
  commitSha: string = HEAD_SHA,
): SnapshotReader {
  return {
    repoId,
    commitSha,
    treeHash: "t_0123456789abcdef",
    read: () => Promise.reject(new Error("snapshot read")),
    exists: () => Promise.reject(new Error("snapshot exists")),
    slice: () => Promise.reject(new Error("snapshot slice")),
    list: () => Promise.reject(new Error("snapshot list")),
  };
}

export function assembleInput(
  overrides: Partial<AssembleInput> = {},
): AssembleInput {
  const generation = overrides.generation ?? defaultGeneration();
  return {
    generation,
    snapshot:
      overrides.snapshot ??
      unusedSnapshot(generation.repoId, generation.commitSha),
    scope: overrides.scope ?? normalizeScope(),
    coverage: overrides.coverage ?? emptyCoverage(),
    claims: overrides.claims ?? [],
    pages: overrides.pages ?? [],
    config: overrides.config ?? GENERATION_CONFIG,
  };
}
