/**
 * The upstream generation port (architecture §6.2).
 *
 * This is the only module allowed to reach `src/agent/**` and
 * `src/generation/**`. It converts upstream results into the contract views in
 * `contracts/upstream.ts` and converts every upstream failure into a
 * `LearningError`, so no upstream error type ever escapes this directory.
 *
 * `writeRepoFiles` is hard-wired to `false`: generation writes only its own
 * `openwiki/` output, never the analysed checkout's workflow or agent files.
 */

import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { OpenWikiIgnore } from "../../agent/openwiki-ignore.js";
import { runNativeRepositoryGeneration } from "../../agent/repository-runner.js";
import type { NativeRepositoryGenerationOptions } from "../../agent/repository-runner.js";
import type { OpenWikiRunEvent } from "../../agent/types.js";
import { createRepositorySourceSnapshot } from "../../agent/utils.js";
import {
  ClaimsError,
  ClaimsPageMissingError,
  ClaimsPersistenceSecurityError,
  EvidenceSecurityError,
} from "../../claims/core/errors.js";
import {
  PAGE_MANIFEST_PATH,
  UPDATE_METADATA_PATH,
} from "../../config/constants.js";
import { PAGE_CONCURRENCY } from "../config/defaults.js";
import { RepositoryRunError } from "../../generation/errors.js";
import { readRepositoryPageManifest } from "../../generation/page-manifest.js";
import { WikiRetrievalError } from "../../retrieval/wiki.js";
import { LearningError } from "../contracts/index.js";
import type {
  GenerationRunRequest,
  PageManifestView,
  UpstreamGenerationPort,
  UpstreamRunEvent,
} from "../contracts/index.js";
import { git } from "../projects/git.js";
import {
  snapshotProtectedHashes,
  verifyProtectedHashes,
  workingTreeHash,
} from "./guard.js";

// Declared in contracts/upstream.ts (§3.15); re-export only.
export type { GenerationRunRequest, UpstreamRunEvent, UpstreamGenerationPort };

/** Structural result of one native repository run. */
export interface NativeRepositoryRunResult {
  skipped: boolean;
  sourceChanged?: true;
}

/** Locally injectable seam around the upstream runner (tests supply a fake). */
export type NativeRepositoryRun = (
  options: NativeRepositoryGenerationOptions,
) => Promise<NativeRepositoryRunResult>;

export interface UpstreamGenerationDeps {
  /** Overrides `runNativeRepositoryGeneration`; never used in production. */
  run?: NativeRepositoryRun;
}

/**
 * Converts any upstream error into the closed `LearningError` vocabulary.
 * `RepositoryRunError("invalid_state")` is the one documented code remap:
 * a broken upstream lifecycle state is the caller's `invalid_input`, tagged
 * with `details.reason = "upstream_state"` (§6.2, §3.2).
 */
export function mapUpstreamError(error: unknown): never {
  if (error instanceof LearningError) throw error;

  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof RepositoryRunError) {
    if (error.code === "invalid_state") {
      throw new LearningError("invalid_input", message, {
        reason: "upstream_state",
      });
    }
    throw new LearningError(error.code, message);
  }
  if (error instanceof ClaimsPageMissingError) {
    throw new LearningError("not_found", message);
  }
  if (
    error instanceof ClaimsPersistenceSecurityError ||
    error instanceof EvidenceSecurityError
  ) {
    throw new LearningError("out_of_scope_path", message, {
      reason: "symlink_escape",
    });
  }
  if (error instanceof ClaimsError || error instanceof WikiRetrievalError) {
    throw new LearningError("invalid_input", message);
  }
  throw new LearningError("internal_error", message);
}

/** Narrows one upstream run event to the contract's display shape. */
function displayPath(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > 240 ||
    /[?:\\]/u.test(value) ||
    [...value].some((char) => char.charCodeAt(0) < 32)
  )
    return undefined;
  // Agent filesystem paths are rooted at the repository's virtual '/'.
  const relative = value.replace(/^\/+|^\.\//gu, "");
  if (relative.split("/").includes("..")) return undefined;
  return relative || ".";
}

function toUpstreamEvent(event: OpenWikiRunEvent): UpstreamRunEvent {
  switch (event.type) {
    case "repository_progress":
      return {
        type: "repository_progress",
        stage: event.stage,
        ...(event.message === undefined ? {} : { message: event.message }),
        ...(event.failure === undefined ? {} : { failure: event.failure }),
        ...(event.page === undefined ? {} : { page: displayPath(event.page) }),
        ...(event.pageIndex === undefined
          ? {}
          : { pageIndex: event.pageIndex }),
        ...(event.pageCount === undefined
          ? {}
          : { pageCount: event.pageCount }),
        ...(event.completedCount === undefined
          ? {}
          : { completedCount: event.completedCount }),
        ...(event.successfulCount === undefined
          ? {}
          : { successfulCount: event.successfulCount }),
        ...(event.skippedCount === undefined
          ? {}
          : { skippedCount: event.skippedCount }),
      };
    case "tool_start": {
      const input =
        typeof event.input === "object" && event.input !== null
          ? (event.input as Record<string, unknown>)
          : {};
      const filePath = displayPath(
        input.file_path ?? input.path ?? input.directory,
      );
      return {
        type: event.type,
        name: event.name,
        ...(event.page === undefined ? {} : { page: displayPath(event.page) }),
        ...(filePath ? { path: filePath } : {}),
      };
    }
    case "tool_end":
      return {
        type: event.type,
        name: event.name,
        status: event.status,
        ...(event.page === undefined ? {} : { page: displayPath(event.page) }),
      };
    case "text":
      return { type: "text", message: event.text };
    case "debug":
      return { type: "text", message: event.message };
  }
}

async function isRegularFile(candidate: string): Promise<boolean> {
  try {
    return (await lstat(candidate)).isFile();
  } catch {
    return false;
  }
}

/** Implements `UpstreamGenerationPort` (§3.15, §6.2). */
export function createUpstreamGenerationPort(
  deps: UpstreamGenerationDeps = {},
): UpstreamGenerationPort {
  const runNative = deps.run ?? runNativeRepositoryGeneration;

  return {
    async run(
      request: GenerationRunRequest,
    ): Promise<{ skipped: boolean; sourceChanged: boolean }> {
      if ((request as { writeRepoFiles?: unknown }).writeRepoFiles !== false) {
        throw new LearningError(
          "invalid_input",
          "生成任务必须关闭仓库文件写入",
          { field: "writeRepoFiles" },
        );
      }

      const protectedBefore = await snapshotProtectedHashes(
        request.worktreePath,
      );
      let result: NativeRepositoryRunResult | undefined;
      let failure: unknown;
      try {
        result = await runNative({
          root: request.worktreePath,
          mode: request.mode,
          language: request.language,
          modelId: request.modelId,
          model: request.model,
          pageConcurrency: PAGE_CONCURRENCY,
          retainIncompleteRun: true,
          ...(request.onDocumentsReady
            ? {
                onDocumentsReady: async () => {
                  const violation = await verifyProtectedHashes(
                    protectedBefore,
                    request.worktreePath,
                  );
                  if (violation.blocked !== null)
                    throw new LearningError(
                      "protected_write_blocked",
                      "上游尝试写入受保护路径",
                      { path: violation.blocked },
                    );
                  await request.onDocumentsReady?.();
                },
              }
            : {}),
          writeRepoFiles: false,
          ...(request.planningContext === undefined
            ? {}
            : { planningContext: request.planningContext }),
          ...(request.force === undefined ? {} : { force: request.force }),
          ...(request.onEvent === undefined
            ? {}
            : {
                onEvent: (event: OpenWikiRunEvent) =>
                  request.onEvent?.(toUpstreamEvent(event)),
              }),
        });
      } catch (error) {
        failure = error;
      }

      // Verify even when the upstream run failed: a failed attempt may still
      // have written a protected file, and that is the error the caller needs.
      const violation = await verifyProtectedHashes(
        protectedBefore,
        request.worktreePath,
      );
      if (violation.blocked !== null) {
        throw new LearningError(
          "protected_write_blocked",
          "上游尝试写入受保护路径",
          { path: violation.blocked },
        );
      }
      if (failure !== undefined) mapUpstreamError(failure);
      return {
        skipped: result?.skipped ?? false,
        sourceChanged: result?.sourceChanged === true,
      };
    },

    async sourceFingerprint(worktreePath: string): Promise<string> {
      try {
        const ignore = await OpenWikiIgnore.load(worktreePath);
        const snapshot = await createRepositorySourceSnapshot(
          worktreePath,
          ignore,
        );
        return snapshot.fingerprint;
      } catch (error) {
        mapUpstreamError(error);
      }
    },

    async treeHashOfWorktree(worktreePath: string): Promise<string> {
      return workingTreeHash(worktreePath);
    },

    async changedPaths(
      worktreePath: string,
      baseGitHead: string | undefined,
    ): Promise<string[]> {
      const base = baseGitHead?.trim() ?? "";
      // Only a full commit id can be interpolated safely; anything else is
      // treated as "no usable baseline" rather than reaching Git's argv.
      if (!/^[0-9a-f]{40}$/iu.test(base)) return [];
      const result = await git(worktreePath, [
        "diff",
        "--name-only",
        `${base}..HEAD`,
      ]);
      if (result.code !== 0) return [];
      return [
        ...new Set(
          result.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== ""),
        ),
      ].sort((left, right) => left.localeCompare(right));
    },

    async lastUpdate(worktreePath: string): Promise<{
      gitHead?: string;
      status?: string;
      language?: string;
    } | null> {
      const metadataFile = path.join(worktreePath, UPDATE_METADATA_PATH);
      try {
        const parsed: unknown = JSON.parse(
          await readFile(metadataFile, "utf8"),
        );
        if (parsed === null || typeof parsed !== "object") return null;
        const record = parsed as Record<string, unknown>;
        if (
          typeof record.updatedAt !== "string" ||
          typeof record.command !== "string" ||
          typeof record.model !== "string"
        ) {
          return null;
        }
        return {
          ...(typeof record.gitHead === "string"
            ? { gitHead: record.gitHead }
            : {}),
          status: record.status === "interrupted" ? "interrupted" : "complete",
          ...(typeof record.language === "string"
            ? { language: record.language }
            : {}),
        };
      } catch {
        return null;
      }
    },

    async pageManifest(worktreePath: string): Promise<PageManifestView | null> {
      const manifestFile = path.join(worktreePath, PAGE_MANIFEST_PATH);
      if (!(await isRegularFile(manifestFile))) return null;
      try {
        const manifest = await readRepositoryPageManifest(worktreePath);
        return { schemaVersion: 1, pages: manifest.pages };
      } catch (error) {
        mapUpstreamError(error);
      }
    },
  };
}
