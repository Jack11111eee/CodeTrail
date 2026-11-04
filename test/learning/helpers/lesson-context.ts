/**
 * Shared doubles for the lesson-builder and validator tests.
 *
 * Everything here is in-memory: a fake `SnapshotReader`, a `SourceRegistry`
 * that keeps refs in a map, and scripted-model helpers. No Git, no SQLite and
 * no network, so a rule test can fail for exactly one reason.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  Clock,
  CoverageReport,
  ExternalDocService,
  ExternalSourceRef,
  GenerationConfig,
  GenerationId,
  ModelHandle,
  ModelRole,
  ModelSettings,
  NormalizedScope,
  RepoId,
  RepoSourceRef,
  SnapshotReader,
  SourceId,
  SourceRef,
  SourceRegistry,
  TeachingExampleRef,
  UpstreamClaimsPort,
  UpstreamMermaidPort,
  ValidationContext,
} from "../../../src/learning/contracts/index.ts";
import {
  LearningError,
  sliceHash,
  sliceLines,
  sourceIdOf,
} from "../../../src/learning/contracts/index.ts";
import { repoSourceId } from "../../../src/learning/evidence/registry.ts";
import { normalizeScope } from "../../../src/learning/projects/scope.ts";
import { parseLesson, type AnyLesson } from "../../../src/learning/lessons/schema.ts";
import {
  createScriptedModel,
  SCRIPT_FILE_NAME,
  type ScriptEntry,
  type ScriptedModelOptions,
} from "../../../src/learning/testing/scripted-model.ts";
import {
  BASE_SHA,
  GENERATION_CONFIG,
  HEAD_SHA,
  changeLesson,
  comparisonLesson,
  defaultGeneration,
  emptyCoverage,
  researchLesson,
} from "./lesson-sample.ts";

export const PROMPT_VERSION = GENERATION_CONFIG.promptTemplateVersion;

// ── snapshots and sources ───────────────────────────────────────────────────

export interface FakeSnapshotOptions {
  commitSha?: string;
  repoId?: string;
}

/** In-memory `SnapshotReader`; every operation is async like the real one. */
export function fakeSnapshot(
  files: Record<string, string>,
  options: FakeSnapshotOptions = {},
): SnapshotReader {
  const commitSha = options.commitSha ?? HEAD_SHA;
  const repoId = (options.repoId ?? "r_0123456789abcdef") as RepoId;

  const textOf = (relPath: string): string => {
    const text = files[relPath];
    if (text === undefined) {
      throw new LearningError("not_found", "文件不存在", { path: relPath });
    }
    return text;
  };

  return {
    repoId,
    commitSha,
    treeHash: `tree-${commitSha.slice(0, 8)}`,
    read: (relPath) => Promise.resolve(textOf(relPath)),
    exists: (relPath) => Promise.resolve(relPath in files),
    slice: (relPath, lines) => Promise.resolve(sliceLines(textOf(relPath), lines)),
    list: () =>
      Promise.resolve(
        Object.entries(files).map(([relPath, text]) => ({
          path: relPath,
          bytes: Buffer.byteLength(text, "utf8"),
        })),
      ),
  };
}

export interface FakeRegistry extends SourceRegistry {
  add(generationId: GenerationId, ref: SourceRef): void;
}

/** A registry that only supports the operations the builders/validators need. */
export function fakeRegistry(): FakeRegistry {
  const buckets = new Map<GenerationId, Map<SourceId, SourceRef>>();

  function bucket(generationId: GenerationId): Map<SourceId, SourceRef> {
    let existing = buckets.get(generationId);
    if (existing === undefined) {
      existing = new Map();
      buckets.set(generationId, existing);
    }
    return existing;
  }

  return {
    add(generationId, ref) {
      bucket(generationId).set(ref.sourceId, ref);
    },

    async registerRepo(input) {
      const text = await input.snapshot.read(input.path);
      const content =
        input.lines === null ? text : sliceLines(text, input.lines);
      const ref: RepoSourceRef = {
        sourceId: repoSourceId(input.path, input.commitSha, input.lines),
        kind: "repo",
        generationId: input.generationId,
        repoId: input.repoId,
        commitSha: input.commitSha,
        path: input.path,
        lines: input.lines,
        contentHash: sliceHash(content),
      };
      bucket(input.generationId).set(ref.sourceId, ref);
      return ref;
    },

    registerExternal(input) {
      if (!input.ok) {
        throw new LearningError("external_source_unavailable", "外部资料暂不可用", {
          reason: input.reason,
        });
      }
      const ref: ExternalSourceRef = {
        sourceId: sourceIdOf(
          "external",
          `${input.canonicalUrl}\0${input.locator}`,
        ),
        kind: "external",
        canonicalUrl: input.canonicalUrl,
        versionOrRetrievedAt: input.versionOrRetrievedAt,
        locator: input.locator,
        contentHash: input.contentHash,
        title: input.title,
      };
      const generationId = [...buckets.keys()][0];
      if (generationId !== undefined) bucket(generationId).set(ref.sourceId, ref);
      return ref;
    },

    registerTeachingExample(input): TeachingExampleRef {
      const ref: TeachingExampleRef = {
        sourceId: sourceIdOf("teaching_example", input.exampleId),
        kind: "teaching_example",
        exampleId: input.exampleId,
        label: input.label,
      };
      const generationId = [...buckets.keys()][0];
      if (generationId !== undefined) bucket(generationId).set(ref.sourceId, ref);
      return ref;
    },

    get(generationId, sourceId) {
      return buckets.get(generationId)?.get(sourceId) ?? null;
    },

    all(generationId) {
      return [...(buckets.get(generationId)?.values() ?? [])].sort((left, right) =>
        left.sourceId.localeCompare(right.sourceId),
      );
    },

    gaps() {
      return [];
    },
  };
}

export interface RepoRefOptions {
  path: string;
  text: string;
  lines?: { start: number; end: number } | null;
  commitSha?: string;
  generationId?: GenerationId;
  repoId?: RepoId;
  /** Override the computed hash to simulate drift. */
  contentHash?: string;
}

export function repoRef(options: RepoRefOptions): RepoSourceRef {
  const generation = defaultGeneration();
  const lines = options.lines ?? null;
  const content =
    lines === null ? options.text : sliceLines(options.text, lines);
  const commitSha = options.commitSha ?? HEAD_SHA;
  return {
    sourceId: repoSourceId(options.path, commitSha, lines),
    kind: "repo",
    generationId: options.generationId ?? generation.generationId,
    repoId: options.repoId ?? generation.repoId,
    commitSha,
    path: options.path,
    lines,
    contentHash: options.contentHash ?? sliceHash(content),
  };
}

export function externalRef(input: {
  url?: string;
  locator?: string;
  title: string;
  version?: string;
}): ExternalSourceRef {
  const canonicalUrl = input.url ?? "https://example.test/design";
  const locator = input.locator ?? "";
  return {
    sourceId: sourceIdOf("external", `${canonicalUrl}\0${locator}`),
    kind: "external",
    canonicalUrl,
    versionOrRetrievedAt: input.version ?? "v1.0.0",
    locator,
    contentHash: sliceHash(input.title),
    title: input.title,
  };
}

export function teachingExampleRef(exampleId = "ex1"): TeachingExampleRef {
  return {
    sourceId: sourceIdOf("teaching_example", exampleId),
    kind: "teaching_example",
    exampleId,
    label: "示例：slugify",
  };
}

// ── validation context ──────────────────────────────────────────────────────

const OK_MERMAID: UpstreamMermaidPort = {
  validate: () => Promise.resolve({ ok: true, mode: "heuristic" }),
};

export function okMermaid(): UpstreamMermaidPort {
  return OK_MERMAID;
}

export function failingMermaid(
  message = "Parse error: unexpected token",
): UpstreamMermaidPort {
  return { validate: () => Promise.resolve({ ok: false, message }) };
}

export interface ContextOptions {
  mode?: ValidationContext["mode"];
  generation?: ReturnType<typeof defaultGeneration>;
  registry?: SourceRegistry;
  snapshot?: SnapshotReader;
  baseSnapshot?: SnapshotReader | null;
  scope?: NormalizedScope;
  coverage?: CoverageReport;
  mermaid?: UpstreamMermaidPort;
  isUiProject?: boolean;
  allowedCommitShas?: readonly string[];
}

export function makeContext(options: ContextOptions = {}): ValidationContext {
  const generation = options.generation ?? defaultGeneration();
  const snapshot =
    options.snapshot ??
    fakeSnapshot({}, {
      commitSha: generation.commitSha,
      repoId: generation.repoId,
    });

  return {
    mode: options.mode ?? "research",
    generation,
    registry: options.registry ?? fakeRegistry(),
    snapshot,
    baseSnapshot: options.baseSnapshot ?? null,
    scope: options.scope ?? normalizeScope(),
    coverage: options.coverage ?? emptyCoverage(),
    mermaid: options.mermaid ?? okMermaid(),
    isUiProject: options.isUiProject ?? false,
    allowedCommitShas: options.allowedCommitShas ?? [generation.commitSha],
  };
}

// ── canonical valid fixtures ────────────────────────────────────────────────

const SAMPLE_ID = "s_0123456789abcdef";
const INDEX_TEXT = [
  "export function slugify(value: string): string {",
  "  return value.trim().toLowerCase();",
  "}",
].join("\n");

function replaceSampleId(value: unknown, replacement: SourceId): unknown {
  return JSON.parse(
    JSON.stringify(value).replaceAll(SAMPLE_ID, replacement),
  ) as unknown;
}

function parseOrThrow(raw: unknown): AnyLesson {
  const parsed = parseLesson(raw);
  if (!parsed.ok) {
    throw new Error(
      `fixture does not parse: ${parsed.failures
        .map((failure) => failure.message)
        .join("; ")}`,
    );
  }
  return parsed.lesson;
}

export interface ResearchFixture {
  lesson: AnyLesson;
  ctx: ValidationContext;
  registry: FakeRegistry;
  ref: RepoSourceRef;
  files: Record<string, string>;
}

/** A research lesson whose every citation is a real registered repo source. */
export function researchFixture(
  options: ContextOptions & { lesson?: unknown } = {},
): ResearchFixture {
  const generation = options.generation ?? defaultGeneration();
  const registry = (options.registry as FakeRegistry | undefined) ?? fakeRegistry();
  const files = { "src/index.ts": INDEX_TEXT };
  const snapshot =
    options.snapshot ??
    fakeSnapshot(files, {
      commitSha: generation.commitSha,
      repoId: generation.repoId,
    });

  const ref = repoRef({
    path: "src/index.ts",
    text: INDEX_TEXT,
    lines: { start: 1, end: 2 },
    commitSha: generation.commitSha,
    generationId: generation.generationId,
    repoId: generation.repoId,
  });
  registry.add(generation.generationId, ref);

  const ctx = makeContext({
    ...options,
    generation,
    registry,
    snapshot,
  });

  const raw = replaceSampleId(options.lesson ?? researchLesson(), ref.sourceId);
  return { lesson: parseOrThrow(raw), ctx, registry, ref, files };
}

export interface ComparisonFixture {
  lesson: AnyLesson;
  ctx: ValidationContext;
  registry: FakeRegistry;
  baseRef: RepoSourceRef;
  headRef: RepoSourceRef;
}

/** A comparison lesson with separate base and head source ids. */
export function comparisonFixture(): ComparisonFixture {
  const generation = defaultGeneration();
  const registry = fakeRegistry();
  const baseSnapshot = fakeSnapshot(
    { "src/index.ts": `${INDEX_TEXT}\n// base side` },
    { commitSha: BASE_SHA, repoId: generation.repoId },
  );
  const headSnapshot = fakeSnapshot(
    { "src/index.ts": `${INDEX_TEXT}\n// head side` },
    { commitSha: generation.commitSha, repoId: generation.repoId },
  );

  const baseRef = repoRef({
    path: "src/index.ts",
    text: `${INDEX_TEXT}\n// base side`,
    lines: { start: 1, end: 1 },
    commitSha: BASE_SHA,
    generationId: generation.generationId,
    repoId: generation.repoId,
  });
  const headRef = repoRef({
    path: "src/index.ts",
    text: `${INDEX_TEXT}\n// head side`,
    lines: { start: 1, end: 1 },
    commitSha: generation.commitSha,
    generationId: generation.generationId,
    repoId: generation.repoId,
  });
  registry.add(generation.generationId, baseRef);
  registry.add(generation.generationId, headRef);

  const raw = replaceSampleId(
    comparisonLesson(),
    headRef.sourceId,
  ) as Record<string, unknown>;
  const context = raw.context as Record<string, unknown>;
  raw.context = {
    ...context,
    commitSha: HEAD_SHA,
    comparison: {
      base: {
        repoId: generation.repoId,
        commitSha: BASE_SHA,
        generationId: "g_base0123456789ab",
      },
      head: {
        repoId: generation.repoId,
        commitSha: HEAD_SHA,
        generationId: generation.generationId,
      },
    },
  };
  raw.statements = [
    {
      id: "st1",
      label: "code_fact",
      text: "字段在第一行导出。",
      evidenceIds: [headRef.sourceId],
      side: "head",
    },
    {
      id: "st2",
      label: "code_fact",
      text: "旧版本同样在第一行导出。",
      evidenceIds: [baseRef.sourceId],
      side: "base",
    },
  ];
  raw.diagram = {
    kind: "state",
    mermaid: "stateDiagram-v2\n  [*] --> copies",
    nodes: [
      {
        id: "n1",
        label: "copies",
        evidenceIds: [headRef.sourceId],
        status: "observed",
      },
    ],
    edges: [],
  };

  const ctx = makeContext({
    mode: "comparison",
    generation,
    registry,
    snapshot: headSnapshot,
    baseSnapshot,
    allowedCommitShas: [HEAD_SHA, BASE_SHA],
    coverage: emptyCoverage(["src/index.ts"]),
  });

  return {
    lesson: parseOrThrow(raw),
    ctx,
    registry,
    baseRef,
    headRef,
  };
}

export interface ChangeFixture {
  lesson: AnyLesson;
  ctx: ValidationContext;
  registry: FakeRegistry;
  ref: RepoSourceRef;
}

export function changeFixture(): ChangeFixture {
  const generation = defaultGeneration();
  const registry = fakeRegistry();
  const snapshot = fakeSnapshot(
    { "src/index.ts": INDEX_TEXT },
    { commitSha: generation.commitSha, repoId: generation.repoId },
  );
  const ref = repoRef({
    path: "src/index.ts",
    text: INDEX_TEXT,
    lines: { start: 1, end: 1 },
    commitSha: generation.commitSha,
    generationId: generation.generationId,
    repoId: generation.repoId,
  });
  registry.add(generation.generationId, ref);

  const raw = replaceSampleId(changeLesson(), ref.sourceId) as Record<
    string,
    unknown
  >;
  // AC-UPD-27: the canonical change lesson has no unverified effects, so the
  // fixture explains the empty field itself instead of every test patching it.
  raw.omittedReasons = { unverifiedEffects: "没有观察到未验证的影响" };
  raw.diagram = {
    kind: "timeline",
    mermaid: "timeline\n  section 版本\n  旧字段 -> 新字段",
    nodes: [
      {
        id: "n1",
        label: "旧字段",
        evidenceIds: [ref.sourceId],
        status: "observed",
      },
    ],
    edges: [],
  };

  const ctx = makeContext({
    mode: "change",
    generation,
    registry,
    snapshot,
    coverage: emptyCoverage(["src/index.ts"]),
  });

  return { lesson: parseOrThrow(raw), ctx, registry, ref };
}

// ── scripted model and builder inputs ───────────────────────────────────────

const temporaryDirs: string[] = [];

/** Writes a script fixture and returns its directory. */
export function scriptDir(scripts: ScriptEntry[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-lesson-scripts-"));
  temporaryDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, SCRIPT_FILE_NAME),
    JSON.stringify({ scripts }, null, 2),
    "utf8",
  );
  return dir;
}

/** A `ScriptEntry` whose single step returns `payload` as JSON. */
export function lessonEntry(
  payload: unknown,
  occurrence = 1,
  workerKind: ScriptEntry["workerKind"] = "lesson",
): ScriptEntry {
  return {
    workerKind,
    occurrence,
    steps: [{ content: JSON.stringify(payload) }],
  };
}

export function cleanupScripts(): void {
  for (const dir of temporaryDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SCRIPTED_SETTINGS: ModelSettings = {
  provider: "scripted",
  model: "scripted",
  maxOutputTokens: 1024,
  temperature: 0,
  pricing: null,
  quota: { maxCalls: 100, maxInputTokens: 100_000, maxOutputTokens: 20_000 },
};

export function scriptedHandle(
  dir: string,
  role: ModelRole = "lesson",
  onCall?: ScriptedModelOptions["onCall"],
): ModelHandle {
  const chatModel = createScriptedModel({
    dir,
    role,
    promptTemplateVersion: PROMPT_VERSION,
    onCall,
  });
  return {
    modelId: "scripted",
    settings: SCRIPTED_SETTINGS,
    chat: () => chatModel,
    estimate: () => ({ calls: 1, tokens: 0 }),
  };
}

export function fixedClock(): Clock {
  let current = new Date("2026-01-01T00:00:00.000Z");
  return {
    now: () => new Date(current),
    set(value: string) {
      current = new Date(value);
    },
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}

export function stubExternal(): ExternalDocService {
  return {
    fetchExact: () =>
      Promise.resolve({ ok: false, status: "source_missing", reason: "not_found" }),
    cached: () => Promise.resolve(null),
  };
}

export const EMPTY_CLAIMS: UpstreamClaimsPort = {
  pages: () => Promise.resolve([]),
  claimsFor: () => Promise.resolve([]),
  markdown: () => Promise.resolve(""),
};

export const CONFIG: GenerationConfig = GENERATION_CONFIG;
