import { describe, expect, it } from "vitest";

import {
  LearningError,
  sliceHash,
  sliceLines,
  type ExternalSourceRef,
  type GenerationId,
  type RegisterRepoSourceInput,
  type RepoId,
  type RepoSourceRef,
  type SourceReader,
  type TeachingExampleRef,
} from "../../../src/learning/contracts/index.js";
import { buildCatalog } from "../../../src/learning/evidence/catalog.js";
import {
  createSourceReader,
  createSourceRegistry,
  sourceRowFromRef,
} from "../../../src/learning/evidence/registry.js";
import {
  createRepositories,
  openDatabase,
} from "../../../src/learning/store/index.js";
import {
  DEFAULT_SCOPE,
  HEAD_SHA,
  createEvidenceHarness,
  fakeSnapshot,
  fixedClock,
  makeGeneration,
  type EvidenceHarness,
} from "./evidence-harness.js";

function thrownBy(fn: () => unknown): LearningError {
  try {
    fn();
  } catch (error) {
    if (error instanceof LearningError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a LearningError");
}

async function thrownByAsync(
  fn: () => Promise<unknown>,
): Promise<LearningError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof LearningError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a LearningError");
}

const OK_EXTERNAL = {
  ok: true as const,
  canonicalUrl: "https://docs.python.org/3/library/asyncio-task.html",
  versionOrRetrievedAt: "v3.12.0",
  locator: "coroutines-and-tasks",
  contentHash: `sha256:${"1".repeat(64)}`,
  title: "Coroutines and Tasks",
  text: "body",
};

function repoInput(
  harness: EvidenceHarness,
  overrides: Partial<{
    generationId: GenerationId;
    commitSha: string;
    path: string;
    lines: { start: number; end: number } | null;
    files: Record<string, string>;
  }> = {},
): RegisterRepoSourceInput {
  const commitSha = overrides.commitSha ?? HEAD_SHA;
  const files = overrides.files ?? { "src/index.ts": "one\ntwo\nthree\n" };
  return {
    generationId: (overrides.generationId ?? "g_1") as GenerationId,
    repoId: "r_1" as RepoId,
    commitSha,
    path: overrides.path ?? "src/index.ts",
    lines: overrides.lines ?? null,
    snapshot: fakeSnapshot(files, { commitSha }),
    scope: DEFAULT_SCOPE,
  };
}

describe("external source refs", () => {
  it("carries canonical_url, version, locator and content_hash; examples carry none", async () => {
    const harness = await createEvidenceHarness();
    try {
      harness.registry.bindGeneration("g_1" as GenerationId);
      const external = harness.registry.registerExternal(OK_EXTERNAL);
      expect(external).toEqual({
        sourceId: external.sourceId,
        kind: "external",
        canonicalUrl: OK_EXTERNAL.canonicalUrl,
        versionOrRetrievedAt: OK_EXTERNAL.versionOrRetrievedAt,
        locator: OK_EXTERNAL.locator,
        contentHash: OK_EXTERNAL.contentHash,
        title: OK_EXTERNAL.title,
      });
      expect(external.sourceId.startsWith("s_")).toBe(true);

      const teaching = harness.registry.registerTeachingExample({
        exampleId: "ex-1",
        label: "示例：一个最小任务",
      });
      expect(teaching.kind).toBe("teaching_example");
      for (const field of [
        "canonicalUrl",
        "versionOrRetrievedAt",
        "locator",
        "contentHash",
        "commitSha",
      ]) {
        expect(field in teaching).toBe(false);
      }
    } finally {
      harness.close();
    }
  });

  it("rejects an external result missing a required field", async () => {
    const harness = await createEvidenceHarness();
    try {
      harness.registry.bindGeneration("g_1" as GenerationId);

      for (const field of [
        "canonicalUrl",
        "versionOrRetrievedAt",
        "contentHash",
      ] as const) {
        const broken = { ...OK_EXTERNAL, [field]: "" };
        const error = thrownBy(() => harness.registry.registerExternal(broken));
        expect(error.code).toBe("invalid_input");
        expect(error.details?.field).toBe(field);
      }

      expect(
        thrownBy(() =>
          harness.registry.registerExternal({
            ...OK_EXTERNAL,
            canonicalUrl: "ftp://docs.python.org/x",
          }),
        ).code,
      ).toBe("invalid_input");

      expect(
        thrownBy(() =>
          harness.registry.registerExternal({
            ...OK_EXTERNAL,
            locator: undefined as unknown as string,
          }),
        ).code,
      ).toBe("invalid_input");
    } finally {
      harness.close();
    }
  });

  it("derives deterministic ids per (kind, path, commit, lines)", async () => {
    const harness = await createEvidenceHarness();
    try {
      const first = harness.registry;
      const second = createSourceRegistry({
        clock: fixedClock(),
        sources: harness.repos.sources,
        generations: harness.repos.generations,
      });

      const a = await first.registerRepo(
        repoInput(harness, { lines: { start: 1, end: 2 } }),
      );
      const b = await second.registerRepo(
        repoInput(harness, { lines: { start: 1, end: 2 } }),
      );
      expect(b.sourceId).toBe(a.sourceId);

      const otherCommit = await second.registerRepo(
        repoInput(harness, {
          commitSha: "c".repeat(40),
          lines: { start: 1, end: 2 },
        }),
      );
      expect(otherCommit.sourceId).not.toBe(a.sourceId);

      const otherLines = await second.registerRepo(
        repoInput(harness, { lines: null }),
      );
      expect(otherLines.sourceId).not.toBe(a.sourceId);

      first.bindGeneration("g_1" as GenerationId);
      second.bindGeneration("g_1" as GenerationId);
      const extA = first.registerExternal(OK_EXTERNAL);
      const extB = second.registerExternal(OK_EXTERNAL);
      expect(extB.sourceId).toBe(extA.sourceId);
      const extOther = second.registerExternal({
        ...OK_EXTERNAL,
        locator: "another-section",
      });
      expect(extOther.sourceId).not.toBe(extA.sourceId);
    } finally {
      harness.close();
    }
  });

  it("validates existence, line range and hash at registration time", async () => {
    const harness = await createEvidenceHarness();
    try {
      const missing = await thrownByAsync(() =>
        harness.registry.registerRepo(
          repoInput(harness, { path: "src/missing.ts" }),
        ),
      );
      expect(missing.code).toBe("not_found");

      const pastEnd = await thrownByAsync(() =>
        harness.registry.registerRepo(
          repoInput(harness, { lines: { start: 1, end: 99 } }),
        ),
      );
      expect(pastEnd.code).toBe("invalid_input");

      const inverted = await thrownByAsync(() =>
        harness.registry.registerRepo(
          repoInput(harness, { lines: { start: 3, end: 2 } }),
        ),
      );
      expect(inverted.code).toBe("invalid_input");

      const wrongCommit = await thrownByAsync(() =>
        harness.registry.registerRepo({
          ...repoInput(harness),
          commitSha: "d".repeat(40),
        }),
      );
      expect(wrongCommit.code).toBe("version_mismatch");
    } finally {
      harness.close();
    }
  });

  it("hashes the exact slice, including CRLF line endings", async () => {
    const harness = await createEvidenceHarness();
    try {
      const text = "alpha\r\nbeta\r\ngamma";
      const whole = await harness.registry.registerRepo(
        repoInput(harness, {
          files: { "crlf.txt": text },
          path: "crlf.txt",
          lines: null,
        }),
      );
      expect(whole.contentHash).toBe(sliceHash(text));

      const middle = await harness.registry.registerRepo(
        repoInput(harness, {
          files: { "crlf.txt": text },
          path: "crlf.txt",
          lines: { start: 2, end: 2 },
        }),
      );
      expect(middle.contentHash).toBe(
        sliceHash(sliceLines(text, { start: 2, end: 2 })),
      );
      expect(middle.contentHash).not.toBe(whole.contentHash);
    } finally {
      harness.close();
    }
  });
});

describe("persisted read side", () => {
  it("returns identical refs from rows after a restart", async () => {
    const harness = await createEvidenceHarness();
    const generationId = "g_1" as GenerationId;
    const generation = makeGeneration({ generationId });
    let reopened: ReturnType<typeof openDatabase> | null = null;
    try {
      harness.registry.bindGeneration(generationId);
      const repo = await harness.registry.registerRepo(repoInput(harness));
      const external = harness.registry.registerExternal(OK_EXTERNAL);
      const teaching = harness.registry.registerTeachingExample({
        exampleId: "ex-1",
        label: "示例：最小任务",
      });

      const staged = harness.registry.all(generationId);
      expect(staged).toHaveLength(3);

      harness.db.transaction(() => {
        harness.repos.generations.insertPublished(generation);
        harness.repos.sources.insertMany([
          sourceRowFromRef(repo),
          sourceRowFromRef(external, generationId, HEAD_SHA),
          sourceRowFromRef(teaching, generationId, HEAD_SHA),
        ]);
      });

      harness.db.close();
      reopened = openDatabase({ file: harness.paths.db, clock: fixedClock() });
      const repos = createRepositories(reopened);
      const registry = createSourceRegistry({
        clock: fixedClock(),
        sources: repos.sources,
        generations: repos.generations,
      });

      expect(registry.all(generationId)).toEqual(staged);
      for (const ref of staged) {
        expect(registry.get(generationId, ref.sourceId)).toEqual(ref);
      }
    } finally {
      reopened?.close();
      try {
        harness.close();
      } catch {
        // already closed above
      }
    }
  });

  it("does not let another registry instance read staged refs before publish", async () => {
    const harness = await createEvidenceHarness();
    const generationId = "g_2" as GenerationId;
    try {
      await harness.registry.registerRepo(repoInput(harness, { generationId }));

      const fresh = createSourceRegistry({
        clock: fixedClock(),
        sources: harness.repos.sources,
        generations: harness.repos.generations,
      });

      expect(thrownBy(() => fresh.all(generationId)).code).toBe(
        "unpublished_generation",
      );
      expect(thrownBy(() => fresh.get(generationId, "s_x" as never)).code).toBe(
        "unpublished_generation",
      );
      expect(harness.repos.sources.all(generationId)).toEqual([]);
    } finally {
      harness.close();
    }
  });
});

describe("evidence catalog and reader", () => {
  it("trims excerpts to 40 lines and honors the character budget", async () => {
    const longText = Array.from(
      { length: 100 },
      (_, index) => `line ${index + 1}`,
    ).join("\n");
    const refs: RepoSourceRef[] = [
      {
        sourceId: "s_1" as never,
        kind: "repo",
        generationId: "g_1" as GenerationId,
        repoId: "r_1" as never,
        commitSha: HEAD_SHA,
        path: "src/index.ts",
        lines: { start: 1, end: 100 },
        contentHash: sliceHash(longText),
      },
    ];
    const reader: SourceReader = {
      readRepo: () => Promise.resolve(longText),
      readExternal: () => Promise.resolve(""),
    };

    const untrimmed = await buildCatalog(refs, reader, 100_000);
    expect(untrimmed).toHaveLength(1);
    expect(untrimmed[0].label).toBe("src/index.ts:1-100");
    expect(untrimmed[0].excerpt.split("\n")).toHaveLength(40);

    const budgeted = await buildCatalog(refs, reader, 25);
    expect(budgeted[0].excerpt.length).toBeLessThanOrEqual(25);
    const total = budgeted.reduce(
      (sum, entry) => sum + entry.excerpt.length,
      0,
    );
    expect(total).toBeLessThanOrEqual(25);
  });

  it("skips unreadable refs instead of inventing content", async () => {
    const ref: ExternalSourceRef = {
      sourceId: "s_ext" as never,
      kind: "external",
      canonicalUrl: "https://docs.python.org/x",
      versionOrRetrievedAt: "v1",
      locator: "x",
      contentHash: `sha256:${"2".repeat(64)}`,
      title: "X",
    };
    const reader: SourceReader = {
      readRepo: () => Promise.resolve(""),
      readExternal: () =>
        Promise.reject(
          new LearningError("external_source_unavailable", "missing"),
        ),
    };
    expect(await buildCatalog([ref], reader, 100)).toEqual([]);
  });

  it("re-verifies content hashes when reading repo and external refs", async () => {
    const text = "one\ntwo\nthree\n";
    const repo: RepoSourceRef = {
      sourceId: "s_repo" as never,
      kind: "repo",
      generationId: "g_1" as GenerationId,
      repoId: "r_1" as never,
      commitSha: HEAD_SHA,
      path: "src/index.ts",
      lines: { start: 2, end: 2 },
      contentHash: sliceHash(sliceLines(text, { start: 2, end: 2 })),
    };
    const externalText = "external body";
    const external: ExternalSourceRef = {
      sourceId: "s_ext" as never,
      kind: "external",
      canonicalUrl: "https://docs.python.org/x",
      versionOrRetrievedAt: "v1",
      locator: "x",
      contentHash: sliceHash(externalText),
      title: "X",
    };

    const reader = createSourceReader({
      snapshotFor: () => fakeSnapshot({ "src/index.ts": text }),
      external: {
        fetchExact: () =>
          Promise.resolve({
            ok: false,
            status: "source_missing",
            reason: "network",
          } as const),
        cached: (hash) =>
          Promise.resolve(hash === external.contentHash ? externalText : null),
      },
    });

    expect(await reader.readRepo(repo, DEFAULT_SCOPE)).toBe("two");
    expect(await reader.readExternal(external)).toBe(externalText);

    const drifted = { ...repo, contentHash: sliceHash("something else") };
    await expect(reader.readRepo(drifted, DEFAULT_SCOPE)).rejects.toMatchObject(
      {
        code: "source_drift",
      },
    );

    const missing = { ...external, contentHash: `sha256:${"3".repeat(64)}` };
    await expect(reader.readExternal(missing)).rejects.toMatchObject({
      code: "external_source_unavailable",
    });
  });

  it("registers a teaching example with a non-empty label only", async () => {
    const harness = await createEvidenceHarness();
    try {
      harness.registry.bindGeneration("g_1" as GenerationId);
      expect(
        thrownBy(() =>
          harness.registry.registerTeachingExample({
            exampleId: "ex",
            label: "",
          }),
        ).code,
      ).toBe("invalid_input");
      const teaching: TeachingExampleRef =
        harness.registry.registerTeachingExample({
          exampleId: "ex",
          label: "示例：调用顺序",
        });
      expect(teaching.label).toContain("示例");
    } finally {
      harness.close();
    }
  });
});
