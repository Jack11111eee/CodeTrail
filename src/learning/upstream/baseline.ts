/**
 * Cross-version baseline planning and materialisation (architecture §6.4).
 *
 * An update may seed its build worktree from the previous published generation,
 * but only after proving that generation is intact and compatible: the seal
 * hashes must match, the page manifest and `.claims` sidecars must be schema 1,
 * the prompt template and upstream pin must be current, the wiki language must
 * be Chinese, and the baseline commit must be an ancestor of the target. Any
 * failure yields `usable: false` with the matching internal reason, which the
 * pipeline persists as `generations.fallback_reason`; these labels never become
 * HTTP bodies (§3.2).
 *
 * The previous run's `.run.json` is recovery state, not content: it is never
 * copied and its absence is asserted after materialisation (PRD §6.1 item 5).
 */

import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import path from "node:path";

import { CODE_CLAIMS_SCHEMA_VERSION } from "../../claims/brains/code/types.js";
import {
  PAGE_MANIFEST_PATH,
  UPDATE_METADATA_PATH,
} from "../../config/constants.js";
import { PROMPT_TEMPLATE_VERSION, UPSTREAM_VERSION } from "../config/defaults.js";
import { knowledgePath, mirrorPath, resolveDataPaths } from "../config/paths.js";
import type { DataPaths, GenerationId, RepoId } from "../contracts/index.js";
import { LearningError } from "../contracts/index.js";
import { git } from "../projects/git.js";

/** Location of the codetrail generation metadata inside a knowledge directory. */
export const BASELINE_METADATA_BASENAME = "generation.json";
/** Location of the seal manifest at the knowledge root. */
export const SEAL_BASENAME = "seal.json";
/** Upstream's durable-run checkpoint; never part of a baseline. */
const RUN_STATE_BASENAME = ".run.json";

export interface BaselineSource {
  generationId: GenerationId;
  knowledgeDir: string;
  commitSha: string;
}

/** Internal planning labels; persisted to `generations.fallback_reason` only. */
export type BaselineReason =
  | "no_baseline"
  | "manifest_schema"
  | "claims_schema"
  | "upstream_version"
  | "prompt_template"
  | "language"
  | "not_ancestor"
  | "seal_mismatch";

export interface BaselinePlan {
  usable: boolean;
  reason?: BaselineReason;
  source?: BaselineSource;
}

export interface PlanBaselineInput {
  candidate: GenerationId | null;
  targetSha: string;
  language: "zh";
  /**
   * Repository containing both commits. Production derives it from
   * `metadata.repoId` (a mirror) or the data directory's mirrors; tests pass a
   * temporary fixture repository directly.
   */
  repoPath?: string;
}

/** Identity persisted with every published generation for baseline checks. */
export interface BaselineMetadata {
  commitSha: string;
  repoId?: string;
  upstreamVersion: string;
  promptTemplateVersion: string;
  language: string;
}

interface SealEntry {
  path: string;
  sha256: string;
  bytes?: number;
}

function toPosix(value: string): string {
  return value.replace(/\\/gu, "/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(candidate: string): Promise<boolean> {
  try {
    return (await lstat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function readJson(candidate: string): Promise<unknown> {
  return JSON.parse(await readFile(candidate, "utf8")) as unknown;
}

/** True when a seal entry names a file strictly below its knowledge root. */
function isSafeRelativePath(relativePath: string): boolean {
  if (relativePath === "" || relativePath.includes("\0")) return false;
  if (path.isAbsolute(relativePath) || /^[a-z]:\//iu.test(relativePath)) {
    return false;
  }
  const normalized = toPosix(relativePath);
  return !normalized
    .split("/")
    .some((segment) => segment === ".." || segment === ".");
}

function sealMismatch(detail: string): LearningError {
  return new LearningError("internal_error", "基线封存校验失败", {
    reason: "seal_mismatch",
    detail,
  });
}

/** Parses and structurally validates `seal.json`; throws on anything unusual. */
async function readSealFiles(knowledgeDir: string): Promise<SealEntry[]> {
  let raw: unknown;
  try {
    raw = await readJson(path.join(knowledgeDir, SEAL_BASENAME));
  } catch (error) {
    throw sealMismatch(
      error instanceof Error ? error.message : "seal.json 不可读",
    );
  }
  if (!isRecord(raw) || !Array.isArray(raw.files)) {
    throw sealMismatch("seal.json 缺少 files 列表");
  }
  const entries: SealEntry[] = [];
  for (const candidate of raw.files) {
    if (!isRecord(candidate)) throw sealMismatch("seal 记录不是对象");
    const { path: relativePath, sha256, bytes } = candidate;
    if (typeof relativePath !== "string" || !isSafeRelativePath(relativePath)) {
      throw sealMismatch("seal 记录包含非法路径");
    }
    if (typeof sha256 !== "string" || sha256 === "") {
      throw sealMismatch("seal 记录缺少 sha256");
    }
    entries.push({
      path: relativePath,
      sha256,
      ...(typeof bytes === "number" ? { bytes } : {}),
    });
  }
  return entries;
}

function normalizeDigest(digest: string): string {
  return digest.replace(/^sha256:/iu, "").toLowerCase();
}

async function digestFile(absolutePath: string): Promise<string | null> {
  try {
    const content = await readFile(absolutePath);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

/** Recomputes every sealed file hash in `knowledgeDir`. */
async function verifySeal(knowledgeDir: string): Promise<void> {
  for (const entry of await readSealFiles(knowledgeDir)) {
    const absolutePath = path.join(knowledgeDir, entry.path);
    const actual = await digestFile(absolutePath);
    if (actual === null) {
      throw sealMismatch(`缺少封存文件 ${entry.path}`);
    }
    if (actual !== normalizeDigest(entry.sha256)) {
      throw sealMismatch(`封存哈希不匹配 ${entry.path}`);
    }
    if (entry.bytes !== undefined) {
      const size = (await lstat(absolutePath)).size;
      if (size !== entry.bytes) {
        throw sealMismatch(`封存字节数不匹配 ${entry.path}`);
      }
    }
  }
}

async function readBaselineMetadata(
  knowledgeDir: string,
): Promise<BaselineMetadata | null> {
  let raw: unknown;
  try {
    raw = await readJson(path.join(knowledgeDir, BASELINE_METADATA_BASENAME));
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (typeof raw.commitSha !== "string" || raw.commitSha.trim() === "") {
    return null;
  }
  return {
    commitSha: raw.commitSha.trim(),
    ...(typeof raw.repoId === "string" ? { repoId: raw.repoId } : {}),
    upstreamVersion:
      typeof raw.upstreamVersion === "string" ? raw.upstreamVersion : "",
    promptTemplateVersion:
      typeof raw.promptTemplateVersion === "string"
        ? raw.promptTemplateVersion
        : "",
    language: typeof raw.language === "string" ? raw.language : "",
  };
}

/** `.page-manifest.json` must exist with schemaVersion 1 and a pages object. */
async function manifestIsCompatible(knowledgeDir: string): Promise<boolean> {
  const manifestPath = path.join(knowledgeDir, PAGE_MANIFEST_PATH);
  try {
    const raw = await readJson(manifestPath);
    return (
      isRecord(raw) && raw.schemaVersion === 1 && isRecord(raw.pages)
    );
  } catch {
    return false;
  }
}

/** Recursively collects `.json` files below `directory`, sorted. */
async function listJsonFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonFiles(absolute)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(absolute);
    }
  }
  return files;
}

/** Every `.claims` sidecar must carry the current schema version. */
async function claimsAreCompatible(knowledgeDir: string): Promise<boolean> {
  const claimsDir = path.join(knowledgeDir, "openwiki", ".claims");
  for (const file of await listJsonFiles(claimsDir)) {
    try {
      const raw = await readJson(file);
      if (
        !isRecord(raw) ||
        raw.schemaVersion !== CODE_CLAIMS_SCHEMA_VERSION ||
        !Array.isArray(raw.claims)
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

async function readLastUpdateLanguage(
  knowledgeDir: string,
): Promise<string> {
  try {
    const raw = await readJson(path.join(knowledgeDir, UPDATE_METADATA_PATH));
    return isRecord(raw) && typeof raw.language === "string"
      ? raw.language
      : "";
  } catch {
    return "";
  }
}

async function listMirrors(mirrorsRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(mirrorsRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(".git"))
      .map((entry) => path.join(mirrorsRoot, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

async function isAncestor(
  input: PlanBaselineInput,
  paths: DataPaths,
  metadata: BaselineMetadata,
): Promise<boolean> {
  const candidates: string[] = [];
  if (input.repoPath !== undefined) {
    // A caller-supplied repository is authoritative: never fall through to
    // another mirror and accidentally prove ancestry in a different clone.
    const result = await git(input.repoPath, [
      "merge-base",
      "--is-ancestor",
      metadata.commitSha,
      input.targetSha,
    ]);
    return result.code === 0;
  }
  if (metadata.repoId !== undefined) {
    candidates.push(mirrorPath(paths, metadata.repoId as RepoId));
  }
  candidates.push(...(await listMirrors(paths.mirrors)));

  for (const candidate of [...new Set(candidates)]) {
    if (!(await directoryExists(candidate))) continue;
    const result = await git(candidate, [
      "merge-base",
      "--is-ancestor",
      metadata.commitSha,
      input.targetSha,
    ]);
    if (result.code === 0) return true;
  }
  return false;
}

/**
 * Builds a complete plan for seeding `targetSha` from the previous published
 * generation. Returns `usable:false` instead of throwing for every check.
 */
export async function planBaseline(
  input: PlanBaselineInput,
): Promise<BaselinePlan> {
  if (input.candidate === null) {
    return { usable: false, reason: "no_baseline" };
  }

  const paths = resolveDataPaths(process.env);
  let knowledgeDir: string;
  try {
    knowledgeDir = knowledgePath(paths, input.candidate);
  } catch {
    return { usable: false, reason: "no_baseline" };
  }
  if (!(await directoryExists(knowledgeDir))) {
    return { usable: false, reason: "no_baseline" };
  }

  const metadata = await readBaselineMetadata(knowledgeDir);
  if (metadata === null) {
    return { usable: false, reason: "no_baseline" };
  }

  try {
    await verifySeal(knowledgeDir);
  } catch {
    return { usable: false, reason: "seal_mismatch" };
  }
  if (!(await manifestIsCompatible(knowledgeDir))) {
    return { usable: false, reason: "manifest_schema" };
  }
  if (!(await claimsAreCompatible(knowledgeDir))) {
    return { usable: false, reason: "claims_schema" };
  }
  if (metadata.promptTemplateVersion !== PROMPT_TEMPLATE_VERSION) {
    return { usable: false, reason: "prompt_template" };
  }
  if (metadata.upstreamVersion !== UPSTREAM_VERSION) {
    return { usable: false, reason: "upstream_version" };
  }
  const language =
    metadata.language !== ""
      ? metadata.language
      : await readLastUpdateLanguage(knowledgeDir);
  if (language !== input.language) {
    return { usable: false, reason: "language" };
  }
  if (!(await isAncestor(input, paths, metadata))) {
    return { usable: false, reason: "not_ancestor" };
  }

  return {
    usable: true,
    source: {
      generationId: input.candidate,
      knowledgeDir,
      commitSha: metadata.commitSha,
    },
  };
}

/** Copies a directory tree, skipping the upstream run checkpoint everywhere. */
async function copyWikiTree(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === RUN_STATE_BASENAME) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await copyWikiTree(from, to);
    } else if (entry.isFile()) {
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(from, to);
    }
  }
}

/** Confirms every copied wiki file still matches its sealed digest. */
async function verifyCopiedWiki(
  knowledgeDir: string,
  buildWorktree: string,
): Promise<void> {
  for (const entry of await readSealFiles(knowledgeDir)) {
    const normalized = toPosix(entry.path);
    if (!normalized.startsWith("openwiki/")) continue;
    if (path.posix.basename(normalized) === RUN_STATE_BASENAME) continue;
    const actual = await digestFile(path.join(buildWorktree, normalized));
    if (actual === null || actual !== normalizeDigest(entry.sha256)) {
      throw sealMismatch(`复制后的基线哈希不匹配 ${entry.path}`);
    }
  }
}

/**
 * Copies a verified baseline's `openwiki/**` into the build worktree. The
 * previous run's `.run.json` is removed if the target checkout carries one and
 * is never copied; its absence is asserted afterwards.
 */
export async function materializeBaseline(input: {
  source: BaselineSource;
  buildWorktree: string;
}): Promise<void> {
  const { source, buildWorktree } = input;
  await verifySeal(source.knowledgeDir);

  const sourceWiki = path.join(source.knowledgeDir, "openwiki");
  if (!(await directoryExists(sourceWiki))) {
    throw new LearningError("not_found", "基线缺少 openwiki 目录", {
      generationId: source.generationId,
    });
  }

  const targetWiki = path.join(buildWorktree, "openwiki");
  const staleRunState = path.join(targetWiki, RUN_STATE_BASENAME);
  await rm(staleRunState, { force: true });

  await copyWikiTree(sourceWiki, targetWiki);

  if (await pathExists(staleRunState)) {
    throw new LearningError("internal_error", "基线复制不应包含 .run.json", {
      path: staleRunState,
    });
  }
  await verifyCopiedWiki(source.knowledgeDir, buildWorktree);
}
