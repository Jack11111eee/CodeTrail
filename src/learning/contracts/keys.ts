import type { ChangeEventKind } from "./change.js";
import type { RepoId } from "./ids.js";
import { sha256Hex } from "./ids.js";
import type { SealedFile } from "./ports.js";
import type { GenerationConfig } from "./refs.js";
import type { NormalizedScope, ScopeConfig } from "./scope.js";

export const DEDUPE_KEY_VERSION = "dk2";
export const CACHE_KEY_VERSION = "ck2";
export const SCOPE_HASH_VERSION = "sc1";
export const CONFIG_HASH_VERSION = "cf1";
export const EVENT_KEY_VERSION = "ek1";

function digest(parts: readonly string[]): string {
  return `sha256:${sha256Hex(parts.join("\u0000"))}`;
}

export function computeDedupeKey(i: {
  repoId: RepoId;
  streamId: string | null;
  comparisonBaseSha: string | null;
  headSha: string;
  baseContextSha: string | null;
  scopeHash: string;
  analysisConfigHash: string;
}): string {
  return digest([
    DEDUPE_KEY_VERSION,
    i.repoId,
    i.streamId ?? "",
    i.comparisonBaseSha ?? "",
    i.headSha,
    i.baseContextSha ?? "",
    i.scopeHash,
    i.analysisConfigHash,
  ]);
}

export function computeCacheKey(i: {
  kind?: "research" | "comparison" | "change";
  comparisonBaseSha?: string | null;
  repoIdentity: string;
  targetCommitSha: string;
  baseContextSha: string | null;
  scopeHash: string;
  generationConfigHash: string;
  promptTemplateVersion: string;
  preferencesVersion: number;
  upstreamVersion: string;
}): string {
  return digest([
    CACHE_KEY_VERSION,
    i.kind ?? "research",
    i.comparisonBaseSha ?? "",
    i.repoIdentity,
    i.targetCommitSha,
    i.baseContextSha ?? "",
    i.scopeHash,
    i.generationConfigHash,
    i.promptTemplateVersion,
    String(i.preferencesVersion),
    i.upstreamVersion,
  ]);
}

export function computeScopeHash(scope: ScopeConfig | NormalizedScope): string {
  const payload = {
    include: [...scope.include].sort(),
    exclude: [...scope.exclude].sort(),
    maxFiles: scope.maxFiles,
    maxFileBytes: scope.maxFileBytes,
  };
  return digest([SCOPE_HASH_VERSION, JSON.stringify(payload)]);
}

export function computeConfigHash(c: GenerationConfig): string {
  const payload = {
    language: c.language,
    model: {
      provider: c.model.provider,
      model: c.model.model,
      ...(c.model.baseUrl ? { baseUrl: c.model.baseUrl } : {}),
      maxOutputTokens: c.model.maxOutputTokens,
      temperature: c.model.temperature,
    },
    pageConcurrency: c.pageConcurrency,
    promptTemplateVersion: c.promptTemplateVersion,
    lessonPipelineVersion: c.lessonPipelineVersion,
    includeTests: c.includeTests,
    externalDocs: {
      enabled: c.externalDocs.enabled,
      maxPerLesson: c.externalDocs.maxPerLesson,
    },
  };
  return digest([CONFIG_HASH_VERSION, JSON.stringify(payload)]);
}

export function computeEventKey(i: {
  repoId: RepoId;
  streamId: string;
  kind: ChangeEventKind;
  baseSha: string | null;
  headSha: string | null;
  mergeBaseSha: string | null;
  baseContextSha: string | null;
}): string {
  return digest([
    EVENT_KEY_VERSION,
    i.repoId,
    i.streamId,
    i.kind,
    i.baseSha ?? "",
    i.headSha ?? "",
    i.mergeBaseSha ?? "",
    i.baseContextSha ?? "",
  ]);
}

/**
 * Seal `treeHash` recipe (§7.3):
 * `"sha256:" + hex(sha256(files.sortedBy(path).map(f => `${f.path}\0${f.sha256}\n`).join("")))`.
 */
export function computeSealTreeHash(files: readonly SealedFile[]): string {
  const sorted = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const payload = sorted.map((f) => `${f.path}\u0000${f.sha256}\n`).join("");
  return `sha256:${sha256Hex(payload)}`;
}

export interface ComparisonFingerprintInput {
  treeHash: string;
  mergeBaseSha: string | null;
  scopeHash: string;
  configHash: string;
}

/** The `lf1` comparison fingerprint (§12.7). */
export function computeComparisonFingerprint(
  i: ComparisonFingerprintInput,
): string {
  return digest([
    "lf1",
    i.treeHash,
    i.mergeBaseSha ?? "",
    i.scopeHash,
    i.configHash,
  ]);
}
