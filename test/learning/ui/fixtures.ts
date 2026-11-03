/**
 * Hand-written page-model fixtures for the server-rendered UI suites.
 *
 * Every suite mutates a fresh copy, so one test can remove a field without
 * another observing it. The values are deliberately literal: the tests assert
 * the rendered HTML strings, not a DOM.
 */

import type {
  AppDeps,
  ChangeSummary,
  CitationView,
  ConversationView,
  CoverageReport,
  DataPaths,
  GenerationId,
  InboxPageModel,
  Lesson,
  LessonDetailView,
  LessonId,
  LessonSummary,
  MessageView,
  ProjectId,
  ProjectSummary,
  ProjectsPageModel,
  ReaderPageModel,
  RenderDiagram,
  RepoId,
  Repositories,
  SettingsPageModel,
  SourceId,
  TermView,
  TermsPageModel,
  UsageView,
} from "../../../src/learning/contracts/index.ts";
import type { PageContext } from "../../../src/learning/ui/pages/layout.ts";
import { POLLING_NOTE } from "../../../src/learning/ui/pages/layout.ts";

export const HEAD_SHA = "a".repeat(40);
export const OTHER_SHA = "b".repeat(40);
export const GENERATION_ID = "g_0123456789abcdef" as GenerationId;
export const LESSON_ID = "l_0123456789abcdef" as LessonId;
export const PROJECT_ID = "p_0123456789abcdef" as ProjectId;
export const REPO_ID = "r_0123456789abcdef" as RepoId;
export const SOURCE_ID = "s_0123456789abcdef" as SourceId;

export const pageContext: PageContext = {
  dataRoot: "/tmp/codetrail-test",
  assetBase: "/assets",
};

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function projectSummary(
  overrides: Partial<ProjectSummary> = {},
): ProjectSummary {
  return {
    projectId: PROJECT_ID,
    repoId: REPO_ID,
    kind: "local",
    displayName: "example-repo",
    defaultBranch: "main",
    analyzedCommitSha: HEAD_SHA,
    lastSuccessAt: "2026-01-01T00:00:00.000Z",
    latestJobState: "completed",
    watchEnabled: false,
    ...overrides,
  };
}

export function projectsModel(
  overrides: Partial<ProjectsPageModel> = {},
): ProjectsPageModel {
  return {
    projects: [projectSummary()],
    modelConfigured: true,
    pollingNote: POLLING_NOTE,
    ...overrides,
  };
}

export function researchLesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    lessonId: LESSON_ID,
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
            evidenceIds: [SOURCE_ID],
          },
        ],
        evidenceIds: [SOURCE_ID],
      },
    ],
    choicesOmittedReason: null,
    boundaries: [
      {
        item: "只处理 ASCII",
        status: "implemented",
        limits: "非 ASCII 字符会被折叠掉",
        evidenceIds: [SOURCE_ID],
      },
    ],
    statements: [
      {
        id: "st1",
        label: "code_fact",
        text: "slugify 会先 trim 再小写。",
        evidenceIds: [SOURCE_ID],
      },
    ],
    evidence: [SOURCE_ID],
    diagram: {
      kind: "component",
      mermaid: 'flowchart LR\n  n1["src/index.ts"] --> n2["slugify"]',
      nodes: [
        {
          id: "n1",
          label: "src/index.ts",
          evidenceIds: [SOURCE_ID],
          status: "observed",
        },
        {
          id: "n2",
          label: "slugify",
          evidenceIds: ["s_second"],
          status: "planned",
        },
      ],
      edges: [
        {
          from: "n1",
          to: "n2",
          label: "调用",
          evidenceIds: [SOURCE_ID],
          inferred: true,
        },
      ],
    },
    coverageGaps: [],
    checks: { structural: "pass", evidence: "pass", semantic: "pass" },
    ...overrides,
  };
}

export function diagram(
  kind: RenderDiagram["kind"],
  overrides: Partial<RenderDiagram> = {},
): RenderDiagram {
  const lesson = researchLesson();
  return {
    kind,
    commitSha: HEAD_SHA,
    nodes: lesson.diagram.nodes,
    edges: lesson.diagram.edges,
    mermaid: lesson.diagram.mermaid,
    inferredEdgeIds: ["n1->n2"],
    plannedNodeIds: ["n2"],
    demoNodeIds: [],
    ...overrides,
  };
}

export function lessonDetail(
  kind: RenderDiagram["kind"] = "component",
  overrides: Partial<LessonDetailView> = {},
): LessonDetailView {
  const lesson = researchLesson();
  return {
    lesson: { ...lesson, diagram: { ...lesson.diagram, kind } },
    diagram: diagram(kind),
    html: "",
    ...overrides,
  };
}

export function coverage(
  overrides: Partial<CoverageReport> = {},
): CoverageReport {
  return {
    generationId: GENERATION_ID,
    commitSha: HEAD_SHA,
    complete: true,
    analyzed: [{ path: "src/index.ts", bytes: 120, language: "typescript" }],
    gaps: [],
    counts: { totalFiles: 1, analyzedFiles: 1, excludedFiles: 0 },
    languages: {
      byLanguage: [
        { language: "typescript", files: 1, bytes: 120, bestEffort: false },
      ],
      preferredCoverageOk: false,
    },
    ...overrides,
  };
}

export function lessonSummary(
  overrides: Partial<LessonSummary> = {},
): LessonSummary {
  return {
    lessonId: LESSON_ID,
    kind: "research",
    title: "slugify 的场景",
    moduleIds: ["src"],
    hasCoverageGaps: false,
    ...overrides,
  };
}

export function message(overrides: Partial<MessageView> = {}): MessageView {
  return {
    messageId: "m_0123456789abcdef" as MessageView["messageId"],
    role: "assistant",
    content: "回答：slugify 先 trim。",
    status: "complete",
    answerPhase: "complete",
    citations: [],
    selection: null,
    unknownReason: null,
    incomplete: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function citation(overrides: Partial<CitationView> = {}): CitationView {
  return {
    sourceId: SOURCE_ID,
    generationId: GENERATION_ID,
    commitSha: HEAD_SHA,
    label: "src/index.ts:1-10",
    availability: "available",
    ...overrides,
  };
}

export function conversation(
  overrides: Partial<ConversationView> = {},
): ConversationView {
  return {
    conversationId: "c_0123456789abcdef" as ConversationView["conversationId"],
    generationIds: [GENERATION_ID],
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:00:00.000Z",
    messages: [
      message({ role: "user", content: "slugify 做了什么？", citations: [] }),
      message({ citations: [citation()] }),
    ],
    selections: [],
    readingPosition: null,
    ...overrides,
  };
}

export function readerModel(
  overrides: Partial<ReaderPageModel> = {},
): ReaderPageModel {
  return {
    generationId: GENERATION_ID,
    commitSha: HEAD_SHA,
    repoDisplayName: "example-repo",
    lessons: [lessonSummary()],
    activeLesson: lessonDetail("component"),
    coverage: coverage(),
    conversation: conversation(),
    readingPosition: {
      generationId: GENERATION_ID,
      lessonId: LESSON_ID,
      conversationId: null,
      offset: 42,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    pollingNote: POLLING_NOTE,
    ...overrides,
  };
}

export function changeSummary(
  overrides: Partial<ChangeSummary> = {},
): ChangeSummary {
  return {
    changeId: "e_0123456789abcdef" as ChangeSummary["changeId"],
    kind: "commit",
    streamKind: "default_branch",
    state: "published",
    significance: "full",
    headSha: HEAD_SHA,
    baseSha: OTHER_SHA,
    hasGap: false,
    linkedChangeId: null,
    discoveredAt: "2026-01-01T00:00:00.000Z",
    publishedAt: "2026-01-01T01:00:00.000Z",
    title: "更新 slugify 的边界",
    ...overrides,
  };
}

export function inboxModel(
  overrides: Partial<InboxPageModel> = {},
): InboxPageModel {
  return {
    projectId: PROJECT_ID,
    items: [changeSummary()],
    next: null,
    pollingNote: POLLING_NOTE,
    ...overrides,
  };
}

export function termView(overrides: Partial<TermView> = {}): TermView {
  return {
    termId: "t_0123456789abcdef" as TermView["termId"],
    zh: "快照",
    en: "snapshot",
    symbols: ["SnapshotRecord"],
    links: [
      {
        generationId: GENERATION_ID,
        repoId: REPO_ID,
        projectId: PROJECT_ID,
        sourceId: SOURCE_ID,
      },
    ],
    ...overrides,
  };
}

export function termsModel(
  overrides: Partial<TermsPageModel> = {},
): TermsPageModel {
  return { terms: [termView()], ...overrides };
}

export function usageView(overrides: Partial<UsageView> = {}): UsageView {
  return {
    groups: [
      {
        kind: "initial",
        inputTokens: 100,
        outputTokens: 40,
        calls: 2,
        costCents: null,
      },
      {
        kind: "qa",
        inputTokens: 20,
        outputTokens: 10,
        calls: 1,
        costCents: null,
      },
    ],
    totals: {
      inputTokens: 120,
      outputTokens: 50,
      calls: 3,
      costCents: null,
      pricingConfigured: false,
    },
    ...overrides,
  };
}

export function settingsModel(
  overrides: Partial<SettingsPageModel> = {},
): SettingsPageModel {
  return {
    projectId: PROJECT_ID,
    model: {
      provider: "anthropic",
      model: "claude-test",
      pricingConfigured: false,
      quota: { maxCalls: 10, maxInputTokens: 1000, maxOutputTokens: 200 },
      dataSent: [
        "选中代码片段",
        "页面文本",
        "你的问题",
        "偏好摘要",
        "外部资料片段",
      ],
    },
    usage: usageView(),
    storage: {
      totalBytes: 4096,
      byProject: [{ projectId: PROJECT_ID, bytes: 1024 }],
      byGeneration: [{ generationId: GENERATION_ID, bytes: 2048 }],
      bySnapshot: [{ repoId: REPO_ID, commitSha: HEAD_SHA, bytes: 512 }],
      byConversation: [
        {
          conversationId:
            "c_0123456789abcdef" as SettingsPageModel["storage"]["byConversation"][number]["conversationId"],
          bytes: 512,
        },
      ],
    },
    preferences: {
      preferences: {
        explainLevel: "plain_first",
        background: "会一点 Python",
        language: "zh",
        version: 3,
      },
      readingPositions: [
        {
          generationId: GENERATION_ID,
          lessonId: LESSON_ID,
          conversationId: null,
          offset: 42,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
    watch: {
      enabled: false,
      available: false,
      reason: "本地项目没有远端可轮询，请使用手动刷新。",
      lastPollAt: null,
    },
    pollingNote: POLLING_NOTE,
    ...overrides,
  };
}

/**
 * A dependency bag with empty repositories, enough for the static-UI seam to
 * render every page without a database. Functional tests start a real listener
 * around this seam.
 */
export function staticDeps(paths: DataPaths): AppDeps {
  const repos = {
    projects: {
      list: () => [],
      byId: () => null,
    },
    repos: { byId: () => null },
    generations: {
      latestPublished: () => null,
      byId: () => null,
      listByProject: () => [],
    },
    jobs: { listByProject: () => [] },
    settings: { model: () => null },
    usage: { groupByKind: () => [] },
    prefs: {
      get: () => ({
        explainLevel: "plain_first",
        background: null,
        language: "zh",
        version: 0,
      }),
      readingPositions: () => [],
    },
    terms: { list: () => [] },
    changes: { page: () => ({ items: [], next: null }) },
    lessons: { listByGeneration: () => [] },
    conversations: {
      byId: () => null,
      messages: () => [],
      selections: () => [],
    },
  } as unknown as Repositories;
  return { paths, repos } as unknown as AppDeps;
}
