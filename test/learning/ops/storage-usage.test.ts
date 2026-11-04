import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeStorageReport,
  opsModule,
} from "../../../src/learning/api/routes/ops.ts";
import { resolveDataPaths } from "../../../src/learning/config/paths.ts";
import type {
  GenerationId,
  ProjectId,
  RepoId,
  Repositories,
  StorageView,
} from "../../../src/learning/contracts/index.ts";
import { startHarness } from "../helpers/http-client.ts";
import type { Harness, HarnessResponse } from "../helpers/http-client.ts";
import { startRoutesServer } from "../helpers/routes-server.ts";
import type { RoutesServer } from "../helpers/routes-server.ts";
import { createTempDataDir } from "../setup/tmp-data-dir.ts";
import { makeGeneration, makeProject, makeRepo } from "../store/helpers.ts";

/**
 * AC-OPS-09.
 *
 * `GET /api/storage` must agree with an independent directory walk, still see
 * the bytes of a removed project, and perform no write: the data directory is
 * hashed before and after the request.
 */

const AT = "2026-01-01T00:00:00.000Z";

let server: RoutesServer | null = null;
let harness: Harness | null = null;

function writeFile(absolute: string, size: number, byte: string): void {
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, Buffer.alloc(size, byte));
}

function walkFiles(
  root: string,
): Map<string, { size: number; sha256: string }> {
  const out = new Map<string, { size: number; sha256: string }>();
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile()) {
        const bytes = fs.readFileSync(full);
        out.set(path.relative(root, full), {
          size: bytes.byteLength,
          sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  };
  visit(root);
  return out;
}

function walkedBytes(root: string): number {
  let total = 0;
  for (const entry of walkFiles(root).values()) total += entry.size;
  return total;
}

function hashOf(files: Map<string, { sha256: string }>): string {
  const lines = [...files.entries()]
    // SQLite's shared-memory index (`-shm`) is a memory-mapped read mark, not
    // data: a read-only query may touch it. Every byte of data is hashed.
    .filter(([name]) => !name.endsWith("-shm") && !name.endsWith("-wal"))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => `${name}\u0000${entry.sha256}`);
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

function seedProject(i: {
  projectId: string;
  repoId: string;
  generationId: string;
  deleted?: boolean;
  commitSha: string;
}): void {
  const repoId = i.repoId as RepoId;
  const projectId = i.projectId as ProjectId;
  server!.repos.repos.upsert(
    makeRepo({
      repoId,
      identity: `local:/tmp/${i.repoId}`,
      mirrorPath: path.join(server!.paths.mirrors, `${i.repoId}.git`),
    }),
  );
  server!.repos.projects.insert(
    makeProject({
      projectId,
      repoId,
      deletedAt: i.deleted === true ? AT : null,
    }),
  );
  server!.repos.generations.insertPublished(
    makeGeneration({
      generationId: i.generationId as GenerationId,
      repoId,
      projectId,
      cacheKey: `ck_${i.generationId}`,
      commitSha: i.commitSha,
      contentDir: path.join(server!.paths.knowledge, i.generationId),
      jobId: null,
    }),
  );
}

function seedTree(): void {
  seedProject({
    projectId: "p_live",
    repoId: "r_live",
    generationId: "g_live",
    commitSha: "a".repeat(40),
  });
  seedProject({
    projectId: "p_removed",
    repoId: "r_removed",
    generationId: "g_removed",
    deleted: true,
    commitSha: "b".repeat(40),
  });

  writeFile(
    path.join(server!.paths.knowledge, "g_live", "openwiki", "page.json"),
    1_000,
    "x",
  );
  writeFile(
    path.join(server!.paths.knowledge, "g_removed", "openwiki", "page.json"),
    2_000,
    "y",
  );
  writeFile(
    path.join(server!.paths.work, "r_live", "a".repeat(40), "src", "index.ts"),
    3_000,
    "z",
  );
  writeFile(
    path.join(server!.paths.mirrors, "r_live.git", "objects", "pack"),
    4_000,
    "m",
  );
  writeFile(
    path.join(
      server!.paths.external,
      "conversations",
      "c_1",
      "transcript.json",
    ),
    500,
    "c",
  );
}

beforeEach(async () => {
  server = await startRoutesServer([opsModule]);
  harness = await startHarness({ start: () => server! });
});

afterEach(async () => {
  await harness?.close();
  harness = null;
  server = null;
});

describe("computeStorageReport", () => {
  it("reports zero on an empty data tree", () => {
    const temp = createTempDataDir("codetrail-storage-empty-");
    try {
      const paths = resolveDataPaths(temp.env);
      const repos = {
        projects: { list: () => [] },
      } as unknown as Repositories;

      expect(computeStorageReport(paths, repos)).toEqual({
        totalBytes: 0,
        byProject: [],
        byGeneration: [],
        bySnapshot: [],
        byConversation: [],
      });
    } finally {
      temp.cleanup();
    }
  });

  it("matches an independent walk and breaks bytes down per category", () => {
    seedTree();

    const report = computeStorageReport(server!.paths, server!.repos);
    expect(report.totalBytes).toBe(walkedBytes(server!.paths.root));

    expect(report.byGeneration).toEqual([
      { generationId: "g_live", bytes: 1_000 },
      { generationId: "g_removed", bytes: 2_000 },
    ]);
    expect(report.bySnapshot).toEqual([
      { repoId: "r_live", commitSha: "a".repeat(40), bytes: 3_000 },
    ]);
    expect(report.byConversation).toEqual([
      { conversationId: "c_1", bytes: 500 },
    ]);

    const byProject = new Map(
      report.byProject.map((entry) => [entry.projectId, entry.bytes]),
    );
    // mirror 4000 + worktree 3000 + published content 1000
    expect(byProject.get("p_live" as ProjectId)).toBe(8_000);
    // removed projects stay visible: their knowledge bytes are still reported
    expect(byProject.get("p_removed" as ProjectId)).toBe(2_000);
  });

  it("tolerates a missing knowledge directory", () => {
    seedTree();
    fs.rmSync(server!.paths.knowledge, { recursive: true, force: true });

    const report = computeStorageReport(server!.paths, server!.repos);
    expect(report.byGeneration).toEqual([]);
  });
});

describe("GET /api/storage", () => {
  it("reports within 5% of disk and writes nothing", async () => {
    seedTree();
    // A cookie is minted before the hash so bootstrap's own write is excluded.
    await harness!.bootstrap();

    const before = walkFiles(server!.paths.root);
    const response: HarnessResponse = await harness!.request("/api/storage");
    expect(response.status).toBe(200);
    const after = walkFiles(server!.paths.root);

    expect(hashOf(after)).toBe(hashOf(before));

    const report = response.json as StorageView;
    const disk = walkedBytes(server!.paths.root);
    expect(
      Math.abs(report.totalBytes - disk) / Math.max(1, disk),
    ).toBeLessThanOrEqual(0.05);

    const generationBytes = report.byGeneration.reduce(
      (sum, entry) => sum + entry.bytes,
      0,
    );
    expect(generationBytes).toBeLessThanOrEqual(disk);
    expect(report.byGeneration.map((entry) => entry.generationId)).toContain(
      "g_removed",
    );
    expect(report.byProject.map((entry) => entry.projectId)).toContain(
      "p_removed",
    );
    expect(report.bySnapshot).toHaveLength(1);
    expect(report.byConversation).toHaveLength(1);
  });
});

describe("storage report with the real database", () => {
  it("counts a sqlite file created by the store", () => {
    const report = computeStorageReport(server!.paths, server!.repos);
    expect(report.totalBytes).toBe(walkedBytes(server!.paths.root));
    expect(report.totalBytes).toBeGreaterThan(0);
  });
});
