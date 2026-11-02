/**
 * Shared doubles for the retrieval tests: temporary knowledge directories, a
 * published wiki ref, and bound snapshot contexts.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  Binding,
  GenerationId,
  PublishedWikiRef,
  RepoId,
  SnapshotReader,
} from "../../../src/learning/contracts/index.js";
import type { RetrievalContext } from "../../../src/learning/retrieval/search.js";
import {
  DEFAULT_SCOPE,
  HEAD_SHA,
  fakeSnapshot,
} from "./evidence-harness.js";

export const REPO_ID = "r_1" as RepoId;
export const GENERATION_ID = "g_1" as GenerationId;

export function makeBinding(overrides: Partial<Binding> = {}): Binding {
  return {
    generationId: GENERATION_ID,
    repoId: REPO_ID,
    commitSha: HEAD_SHA,
    ...overrides,
  };
}

const temporaryDirectories: string[] = [];

/** `root/openwiki/<page>.md` for each entry; returns the root. */
export async function makeKnowledgeDir(
  pages: Record<string, string>,
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codetrail-retrieval-"));
  temporaryDirectories.push(root);
  const wiki = path.join(root, "openwiki");
  await mkdir(wiki, { recursive: true });
  for (const [page, markdown] of Object.entries(pages)) {
    await writeFile(path.join(wiki, page), markdown, "utf8");
  }
  return root;
}

export async function cleanupKnowledgeDirs(): Promise<void> {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
}

export function publishedRefOf(
  knowledgeDir: string,
  binding: Binding,
): PublishedWikiRef {
  return {
    state: "published",
    generationId: binding.generationId,
    commitSha: binding.commitSha,
    knowledgeDir,
    sealedTreeHash: `sha256:${"0".repeat(64)}`,
  };
}

export interface ContextOptions {
  knowledgeDir?: string | null;
  binding?: Binding;
  snapshot?: SnapshotReader;
  baseSnapshot?: SnapshotReader | null;
}

export function contextFor(
  files: Record<string, string>,
  options: ContextOptions = {},
): RetrievalContext {
  const binding = options.binding ?? makeBinding();
  const wikiDir = options.knowledgeDir ?? null;
  const context: RetrievalContext = {
    wiki: wikiDir === null ? null : publishedRefOf(wikiDir, binding),
    snapshot:
      options.snapshot ??
      fakeSnapshot(files, {
        commitSha: binding.commitSha,
        repoId: binding.repoId,
      }),
    scope: DEFAULT_SCOPE,
  };
  if (options.baseSnapshot !== undefined) {
    context.baseSnapshot = options.baseSnapshot;
  }
  return context;
}
