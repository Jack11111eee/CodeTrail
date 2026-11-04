/**
 * Deterministic teaching skeleton (architecture §9.2).
 *
 * These assemblers run before any model call: they turn a staged generation,
 * a snapshot, the read scope, the coverage report, the upstream claims and the
 * wiki page list into the fixed groups a lesson must have. They are pure
 * functions of their input — no clock, no database row, no model call and no
 * randomness — so identical input yields a deep-equal skeleton on every run.
 *
 * The surfaced scenario kinds depend on what the repository actually is: a
 * project with no UI surface (for example the `library-noui` fixture) never
 * gets a `user_flow` candidate (AC-LES-12).
 */

import { idSuffix } from "../contracts/index.js";
import type {
  ClaimView,
  CoverageReport,
  GenerationConfig,
  LessonContext,
  LessonDiagram,
  LessonModuleOverview,
  LessonScenario,
  NormalizedScope,
  ScenarioKind,
  SnapshotReader,
  StagedGenerationRef,
} from "../contracts/index.js";

export interface AssembleInput {
  /** Staged: nothing sealed, no DB row yet (§3.9). */
  generation: StagedGenerationRef;
  snapshot: SnapshotReader;
  scope: NormalizedScope;
  coverage: CoverageReport;
  claims: ClaimView[];
  pages: string[];
  config: GenerationConfig;
}

interface FileRef {
  path: string;
}

// A file may carry its package.json text even though the declared shape is
// path-only; tests and callers that have the bytes can pass them through.
interface FileWithContent extends FileRef {
  content?: unknown;
  text?: unknown;
  packageJson?: unknown;
}

const UI_EXTENSIONS = [
  ".vue",
  ".tsx",
  ".jsx",
  ".svelte",
  ".astro",
  ".html",
  ".htm",
] as const;

const UI_CONFIG_BASENAMES: readonly RegExp[] = [
  /^(?:vite|next|nuxt|svelte|vue|webpack|rollup|astro|parcel)\.config\.[cm]?[jt]s$/iu,
  /^angular\.json$/iu,
];

const UI_DEPENDENCIES = new Set([
  "@angular/core",
  "@sveltejs/kit",
  "astro",
  "ember-source",
  "gatsby",
  "lit",
  "next",
  "nuxt",
  "preact",
  "react",
  "react-dom",
  "solid-js",
  "svelte",
  "vue",
]);

const CLI_PATH_PATTERNS: readonly RegExp[] = [/^bin\//u, /^cli\//u, /^cmd\//u];

const CLI_BASENAMES: readonly RegExp[] = [
  /^cli\.(?:[cm]?[jt]s|py|rb|go|java|rs)$/u,
  /^__main__\.py$/u,
  /^main\.go$/u,
];

const API_PATH_PATTERNS: readonly RegExp[] = [
  /^api\//u,
  /^routes\//u,
  /^controllers?\//u,
  /^handlers?\//u,
];

const API_BASENAMES: readonly RegExp[] = [
  /^(?:server|routes?|router|api|handlers?|controllers?)\.(?:[cm]?[jt]s|py|rb|go|java|rs)$/u,
  /^(?:openapi|swagger)\.(?:ya?ml|json)$/u,
];

function normalizePath(relPath: string): string {
  return relPath
    .replace(/\\/gu, "/")
    .replace(/^\.\//u, "")
    .replace(/^\/+/u, "");
}

function baseName(relPath: string): string {
  const normalized = normalizePath(relPath).replace(/\/+$/u, "");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/** Reads UI/CLI intent out of package.json when the caller supplied its bytes. */
function packageSurfaces(file: FileRef): { ui: boolean; cli: boolean } {
  const withContent = file as FileWithContent;
  if (baseName(withContent.path) !== "package.json") {
    return { ui: false, cli: false };
  }

  let pkg: unknown =
    withContent.packageJson ?? withContent.content ?? withContent.text;
  if (typeof pkg === "string") {
    try {
      pkg = JSON.parse(pkg) as unknown;
    } catch {
      return { ui: false, cli: false };
    }
  }
  if (typeof pkg !== "object" || pkg === null) {
    // No bytes supplied: a caller may still hand the already-parsed fields on
    // the file object itself, so fall back to it rather than guessing.
    pkg = withContent;
  }

  const record = pkg as Record<string, unknown>;
  const dependencies = {
    ...asRecord(record.dependencies),
    ...asRecord(record.devDependencies),
    ...asRecord(record.peerDependencies),
  };
  const ui = [...UI_DEPENDENCIES].some((name) =>
    Object.prototype.hasOwnProperty.call(dependencies, name),
  );
  const bin = record.bin;
  const cli =
    typeof bin === "string" ||
    (typeof bin === "object" && bin !== null && Object.keys(bin).length > 0);

  return { ui, cli };
}

interface Surfaces {
  ui: boolean;
  cli: boolean;
  api: boolean;
}

function detectSurfaces(files: readonly FileRef[]): Surfaces {
  let ui = false;
  let cli = false;
  let api = false;

  for (const file of files) {
    const path = normalizePath(file.path);
    const base = baseName(path);
    const pkg = packageSurfaces(file);

    if (
      pkg.ui ||
      UI_EXTENSIONS.some((extension) =>
        base.toLowerCase().endsWith(extension),
      ) ||
      UI_CONFIG_BASENAMES.some((pattern) => pattern.test(base))
    ) {
      ui = true;
    }
    if (pkg.cli) {
      cli = true;
    }
    if (
      CLI_PATH_PATTERNS.some((pattern) => pattern.test(path)) ||
      CLI_BASENAMES.some((pattern) => pattern.test(base))
    ) {
      cli = true;
    }
    if (
      API_PATH_PATTERNS.some((pattern) => pattern.test(path)) ||
      API_BASENAMES.some((pattern) => pattern.test(base))
    ) {
      api = true;
    }
  }

  return { ui, cli, api };
}

/**
 * True when the project exposes a user-facing surface: a UI framework/file or
 * a CLI `bin` entry. `library-noui` is false on both counts (AC-LES-12).
 */
export function isUiProject(files: { path: string }[]): boolean {
  const surfaces = detectSurfaces(files);
  return surfaces.ui || surfaces.cli;
}

/** Ordered from the most specific surface to the library fallback. */
function scenarioKindsFor(files: readonly FileRef[]): ScenarioKind[] {
  const surfaces = detectSurfaces(files);
  const kinds: ScenarioKind[] = [];
  if (surfaces.ui) kinds.push("user_flow");
  if (surfaces.cli) kinds.push("cli");
  if (surfaces.api) kinds.push("api_call");
  if (!kinds.includes("library_interface")) kinds.push("library_interface");
  return kinds;
}

function analyzedPaths(i: AssembleInput): string[] {
  return i.coverage.analyzed.map((entry) => entry.path);
}

function analyzedFiles(i: AssembleInput): FileRef[] {
  return analyzedPaths(i).map((path) => ({ path }));
}

/** The scenario kind the builder should teach first for this repository. */
export function scenarioKindFor(i: AssembleInput): ScenarioKind {
  return scenarioKindsFor(analyzedFiles(i))[0] ?? "library_interface";
}

function scenarioIdFor(
  generationId: StagedGenerationRef["generationId"],
  kind: ScenarioKind,
): string {
  return `sc_${idSuffix(`${generationId}:${kind}`)}`;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Module ids come from the wiki page list the generation already produced;
 * when there are no pages, the analysed tree's top-level directories are the
 * deterministic fallback. Root-level files do not become modules.
 */
function moduleIdsFor(i: AssembleInput): string[] {
  const fromPages = sortedUnique(
    i.pages.map((page) => page.trim()).filter((page) => page !== ""),
  );
  if (fromPages.length > 0) {
    return fromPages;
  }
  const directories = sortedUnique(
    analyzedPaths(i)
      .filter((path) => path.includes("/"))
      .map((path) => normalizePath(path).split("/")[0])
      .filter((segment) => segment !== ""),
  );
  return directories;
}

export function assembleContext(i: AssembleInput): LessonContext {
  const kind = scenarioKindFor(i);
  return {
    repoId: i.generation.repoId,
    commitSha: i.generation.commitSha,
    generationId: i.generation.generationId,
    scenarioId: scenarioIdFor(i.generation.generationId, kind),
    moduleIds: moduleIdsFor(i),
  };
}

export function assembleOverview(i: AssembleInput): LessonModuleOverview[] {
  return moduleIdsFor(i).map((moduleId) => ({
    moduleId,
    responsibility: `模块 ${moduleId}`,
    inputs: [],
    outputs: [],
  }));
}

const SCENARIO_ACTION: Readonly<Record<ScenarioKind, string>> = Object.freeze({
  user_flow: "在界面上完成一次操作",
  api_call: "调用一个 HTTP 接口",
  cli: "在命令行执行一条命令",
  library_interface: "调用库的公开接口",
});

const SCENARIO_RESULT: Readonly<Record<ScenarioKind, string>> = Object.freeze({
  user_flow: "界面展示操作后的状态变化",
  api_call: "接口返回状态码与响应体",
  cli: "终端输出结果并返回退出码",
  library_interface: "函数返回结果或抛出错误",
});

function scenarioFor(i: AssembleInput, kind: ScenarioKind): LessonScenario {
  return {
    id: scenarioIdFor(i.generation.generationId, kind),
    kind,
    inputs: [],
    userAction: SCENARIO_ACTION[kind],
    observableResult: SCENARIO_RESULT[kind],
    isExample: true,
  };
}

/** Candidate scenarios, primary surface first; never a `user_flow` without UI. */
export function assembleScenarioCandidates(i: AssembleInput): LessonScenario[] {
  return scenarioKindsFor(analyzedFiles(i)).map((kind) => scenarioFor(i, kind));
}

function mermaidLabel(label: string): string {
  return label.replace(/"/gu, "&quot;");
}

/**
 * Always a `component` diagram (AC-LES-09). Nodes mirror the module list, in
 * sorted order; no edge is invented, so there is nothing to render that the
 * model did not ask for.
 */
export function assembleComponentDiagram(i: AssembleInput): LessonDiagram {
  const modules = moduleIdsFor(i);
  const nodes = modules.map((moduleId, index) => ({
    id: `n${index + 1}`,
    label: moduleId,
    evidenceIds: [],
    status: "observed" as const,
  }));

  const lines = ["flowchart LR"];
  for (const node of nodes) {
    lines.push(`  ${node.id}["${mermaidLabel(node.label)}"]`);
  }

  return {
    kind: "component",
    mermaid: lines.join("\n"),
    nodes,
    edges: [],
  };
}
