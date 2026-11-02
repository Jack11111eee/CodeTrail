import fs from "node:fs";
import path from "node:path";

import type {
  CoverageReport,
  GenerationId,
  NormalizedScope,
} from "../../../src/learning/contracts/index.ts";
import {
  buildCoverageReport,
  type CoverageStatus,
} from "../../../src/learning/projects/coverage.ts";
import {
  listTreeEntries,
  type TreeEntry,
} from "../../../src/learning/projects/worktree.ts";
import { fixturePath, fixtureSha } from "../helpers/git-fixture.ts";

/**
 * Builds a coverage report straight from a fixture commit, recording every
 * blob the builder asked to inspect. The recorder is what proves secrets and
 * weights are classified (and rejected) before any content read.
 */
export interface FixtureReport {
  root: string;
  sha: string;
  entries: TreeEntry[];
  report: CoverageReport;
  readCalls: string[];
}

export async function reportForFixture(
  name: string,
  scope: NormalizedScope,
  status?: CoverageStatus,
): Promise<FixtureReport> {
  const root = fixturePath(name);
  const sha = fixtureSha(name);
  const entries = await listTreeEntries(root, sha);
  const readCalls: string[] = [];
  const report = await buildCoverageReport({
    generationId: "g_test" as GenerationId,
    commitSha: sha,
    scope,
    entries,
    readBlob: (relPath: string) => {
      readCalls.push(relPath);
      return Promise.resolve(
        fs.readFileSync(path.join(root, relPath), "utf8").slice(0, 512),
      );
    },
    ...(status === undefined ? {} : { status }),
  });
  return { root, sha, entries, report, readCalls };
}

/** A tiny committed-blob row for synthetic reports. */
export function blob(
  relPath: string,
  bytes = 10,
  overrides: { mode?: string; type?: string } = {},
): { path: string; bytes: number; mode: string; type: string } {
  return {
    path: relPath,
    bytes,
    mode: overrides.mode ?? "100644",
    type: overrides.type ?? "blob",
  };
}
