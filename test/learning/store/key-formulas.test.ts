import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ALLOWED_JOB_TRANSITIONS,
  CURSOR_VERSION,
  HTTP_STATUS_BY_CODE,
  LearningError,
  RETRYABLE_JOB_STATES,
  changeEventIdFromKey,
  computeCacheKey,
  computeComparisonFingerprint,
  computeConfigHash,
  computeDedupeKey,
  computeEventKey,
  computeSealTreeHash,
  computeScopeHash,
  decodeCursor,
  emptyCursor,
  encodeCursor,
  generationIdFromCacheKey,
  idSuffix,
  jobIdFromDedupeKey,
  linesOf,
  newLessonId,
  newProjectId,
  normalizeScope,
  repoIdFromIdentity,
  sliceHash,
  sliceLines,
  sourceIdOf,
  toErrorBody,
  toPullRequestPayload,
  windowStart,
  type GenerationConfig,
  type NormalizedScope,
  type RepoId,
  type ScopeConfig,
} from "../../../src/learning/contracts/index.ts";

/**
 * Contract-level formula tests (AC-GEN-07, AC-GEN-09, AC-API-07 table half).
 *
 * Every expected value below is recomputed from the architecture recipe with
 * Node's own SHA-256 — never by calling the implementation under test — and the
 * canonical cases additionally pin a hand-written golden digest so a change to
 * either side is caught.
 */

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function digest(parts: readonly (string | null | undefined)[]): string {
  return `sha256:${sha256(parts.map((part) => part ?? "").join("\u0000"))}`;
}

const REPO_ID = "r_0123456789abcdef" as RepoId;
const SCOPE_HASH = `sha256:${"1".repeat(64)}`;
const CONFIG_HASH = `sha256:${"2".repeat(64)}`;

const SCOPE: ScopeConfig = {
  include: ["src/**", "README.md"],
  exclude: ["node_modules"],
  maxFiles: 5000,
  maxFileBytes: 5 * 1024 * 1024,
};

const GENERATION_CONFIG: GenerationConfig = {
  language: "zh",
  model: {
    provider: "anthropic",
    model: "claude",
    maxOutputTokens: 4000,
    temperature: 0.2,
  },
  pageConcurrency: 1,
  promptTemplateVersion: "codetrail-lesson-v1",
  lessonPipelineVersion: "lp1",
  includeTests: true,
  externalDocs: { enabled: true, maxPerLesson: 2 },
};

function expectedScopeHash(scope: ScopeConfig | NormalizedScope): string {
  return digest([
    "sc1",
    JSON.stringify({
      include: [...scope.include].sort(),
      exclude: [...scope.exclude].sort(),
      maxFiles: scope.maxFiles,
      maxFileBytes: scope.maxFileBytes,
    }),
  ]);
}

function expectedConfigHash(config: GenerationConfig): string {
  return digest([
    "cf1",
    JSON.stringify({
      language: config.language,
      model: {
        provider: config.model.provider,
        model: config.model.model,
        maxOutputTokens: config.model.maxOutputTokens,
        temperature: config.model.temperature,
      },
      pageConcurrency: config.pageConcurrency,
      promptTemplateVersion: config.promptTemplateVersion,
      lessonPipelineVersion: config.lessonPipelineVersion,
      includeTests: config.includeTests,
      externalDocs: {
        enabled: config.externalDocs.enabled,
        maxPerLesson: config.externalDocs.maxPerLesson,
      },
    }),
  ]);
}

describe("dedupe_key (dk1)", () => {
  const input = {
    repoId: REPO_ID,
    streamId: null,
    comparisonBaseSha: null,
    headSha: "a".repeat(40),
    baseContextSha: null,
    scopeHash: SCOPE_HASH,
    analysisConfigHash: CONFIG_HASH,
  };

  it("matches an independent recomputation and the golden digest", () => {
    const expected = digest([
      "dk1",
      REPO_ID,
      "",
      "",
      "a".repeat(40),
      "",
      SCOPE_HASH,
      CONFIG_HASH,
    ]);
    expect(computeDedupeKey(input)).toBe(expected);
    expect(computeDedupeKey(input)).toBe(
      "sha256:b26cad0913b5046ac47a0a0781549945f42edc58b799794b993ad8faa3803557",
    );
  });

  it("changes when any scope/config/head input changes", () => {
    expect(computeDedupeKey({ ...input, streamId: "main" })).not.toBe(
      computeDedupeKey(input),
    );
    expect(
      computeDedupeKey({ ...input, baseContextSha: "c".repeat(40) }),
    ).not.toBe(computeDedupeKey(input));
    expect(
      computeDedupeKey({ ...input, scopeHash: `sha256:${"9".repeat(64)}` }),
    ).not.toBe(computeDedupeKey(input));
  });
});

describe("cache_key (ck1)", () => {
  const input = {
    repoIdentity: "local:/tmp/repo",
    targetCommitSha: "a".repeat(40),
    baseContextSha: null,
    scopeHash: SCOPE_HASH,
    generationConfigHash: CONFIG_HASH,
    promptTemplateVersion: "codetrail-lesson-v1",
    preferencesVersion: 3,
    upstreamVersion: "0.7.2+7bb583d664f2",
  };

  it("matches an independent recomputation and the golden digest", () => {
    const expected = digest([
      "ck1",
      "local:/tmp/repo",
      "a".repeat(40),
      "",
      SCOPE_HASH,
      CONFIG_HASH,
      "codetrail-lesson-v1",
      "3",
      "0.7.2+7bb583d664f2",
    ]);
    expect(computeCacheKey(input)).toBe(expected);
    expect(computeCacheKey(input)).toBe(
      "sha256:b45b7fe1b7ce21155c92f8a90ce94a51547f54e1fe5f9e9ceecfe75994912a28",
    );
  });

  it("carries the PR base context and the preferences version", () => {
    const withBase = computeCacheKey({
      ...input,
      baseContextSha: "b".repeat(40),
    });
    expect(withBase).toBe(
      digest([
        "ck1",
        "local:/tmp/repo",
        "a".repeat(40),
        "b".repeat(40),
        SCOPE_HASH,
        CONFIG_HASH,
        "codetrail-lesson-v1",
        "3",
        "0.7.2+7bb583d664f2",
      ]),
    );
    expect(computeCacheKey({ ...input, preferencesVersion: 4 })).not.toBe(
      computeCacheKey(input),
    );
  });
});

describe("scope_hash (sc1)", () => {
  it("sorts include/exclude and matches the golden digest", () => {
    const expected = expectedScopeHash(SCOPE);
    expect(computeScopeHash(SCOPE)).toBe(expected);
    expect(computeScopeHash(SCOPE)).toBe(
      "sha256:e87db3c80455c1628eef3faff6cee2031640d1265e495f58b4f20bf4df041cae",
    );
  });

  it("is independent of input order and of the hash field", () => {
    const unsorted: ScopeConfig = {
      include: ["README.md", "src/**"],
      exclude: ["node_modules"],
      maxFiles: 5000,
      maxFileBytes: 5 * 1024 * 1024,
    };
    expect(computeScopeHash(unsorted)).toBe(computeScopeHash(SCOPE));
    const normalized = normalizeScope({
      include: ["README.md", "src/**"],
      exclude: ["node_modules"],
    });
    expect(normalized.hash).toBe(computeScopeHash(unsorted));
  });

  it("handles empty include/exclude arrays", () => {
    const empty: ScopeConfig = {
      include: [],
      exclude: [],
      maxFiles: 1,
      maxFileBytes: 2,
    };
    expect(computeScopeHash(empty)).toBe(expectedScopeHash(empty));
  });
});

describe("config_hash (cf1)", () => {
  it("matches an independent recomputation and the golden digest", () => {
    const expected = expectedConfigHash(GENERATION_CONFIG);
    expect(computeConfigHash(GENERATION_CONFIG)).toBe(expected);
    expect(computeConfigHash(GENERATION_CONFIG)).toBe(
      "sha256:eb4fc2ddb54f6cc0b1e034d2044600fe5ae99e9d6faf9ace074b7a602c97323a",
    );
  });

  it("changes when model identity changes", () => {
    const changed: GenerationConfig = {
      ...GENERATION_CONFIG,
      model: { ...GENERATION_CONFIG.model, model: "other" },
    };
    expect(computeConfigHash(changed)).not.toBe(
      computeConfigHash(GENERATION_CONFIG),
    );
  });
});

describe("event_key (ek1)", () => {
  const input = {
    repoId: REPO_ID,
    streamId: "main",
    kind: "commit" as const,
    baseSha: "b".repeat(40),
    headSha: "a".repeat(40),
    mergeBaseSha: null,
    baseContextSha: null,
  };

  it("matches an independent recomputation and the golden digest", () => {
    const expected = digest([
      "ek1",
      REPO_ID,
      "main",
      "commit",
      "b".repeat(40),
      "a".repeat(40),
      "",
      "",
    ]);
    expect(computeEventKey(input)).toBe(expected);
    expect(computeEventKey(input)).toBe(
      "sha256:b6b4114a135f9acb52cda74183f4e375e9f27bda27554e691ec3b7d2af29100f",
    );
  });

  it("distinguishes null from empty strings only by position, never by coercion", () => {
    const withMergeBase = computeEventKey({
      ...input,
      mergeBaseSha: "c".repeat(40),
    });
    expect(withMergeBase).toBe(
      digest([
        "ek1",
        REPO_ID,
        "main",
        "commit",
        "b".repeat(40),
        "a".repeat(40),
        "c".repeat(40),
        "",
      ]),
    );
    expect(withMergeBase).not.toBe(computeEventKey(input));
  });
});

describe("seal treeHash (AC-GEN-09)", () => {
  const files = [
    { path: "b.md", sha256: "sha256:2", bytes: 2 },
    { path: "a.md", sha256: "sha256:1", bytes: 1 },
  ];

  it("sorts by path and matches the golden digest", () => {
    const expected = `sha256:${sha256("a.md\u0000sha256:1\nb.md\u0000sha256:2\n")}`;
    expect(computeSealTreeHash(files)).toBe(expected);
    expect(computeSealTreeHash(files)).toBe(
      "sha256:cf680da05835bdc50fd252dba4f096a4f3c1f0b85eadf589a4a53fc16666638e",
    );
  });

  it("is independent of input order and hashes the empty list", () => {
    expect(computeSealTreeHash([...files].reverse())).toBe(
      computeSealTreeHash(files),
    );
    expect(computeSealTreeHash([])).toBe(`sha256:${sha256("")}`);
  });
});

describe("comparison fingerprint (lf1)", () => {
  it("matches an independent recomputation and the golden digest", () => {
    const treeHash = computeSealTreeHash([
      { path: "b.md", sha256: "sha256:2", bytes: 2 },
      { path: "a.md", sha256: "sha256:1", bytes: 1 },
    ]);
    const scopeHash = computeScopeHash(SCOPE);
    const configHash = computeConfigHash(GENERATION_CONFIG);
    const expected = digest(["lf1", treeHash, "", scopeHash, configHash]);
    expect(
      computeComparisonFingerprint({
        treeHash,
        mergeBaseSha: null,
        scopeHash,
        configHash,
      }),
    ).toBe(expected);
    expect(
      computeComparisonFingerprint({
        treeHash,
        mergeBaseSha: null,
        scopeHash,
        configHash,
      }),
    ).toBe(
      "sha256:c6dd2ea099c45799db0b07f3fcb77a2dcf13a2940b6222af1b556082156bdcf6",
    );
  });

  it("distinguishes a present merge base from a null one", () => {
    const base = {
      treeHash: "sha256:tree",
      scopeHash: SCOPE_HASH,
      configHash: CONFIG_HASH,
    };
    expect(
      computeComparisonFingerprint({ ...base, mergeBaseSha: "c".repeat(40) }),
    ).not.toBe(computeComparisonFingerprint({ ...base, mergeBaseSha: null }));
  });
});

describe("deterministic ids", () => {
  it("derives every suffix from sha256(input) and the documented prefix", () => {
    expect(idSuffix("abc")).toBe(sha256("abc").slice(0, 16));
    expect(idSuffix("")).toBe("e3b0c44298fc1c14");
    expect(repoIdFromIdentity("local:/tmp/repo")).toBe(
      `r_${sha256("local:/tmp/repo").slice(0, 16)}`,
    );
    expect(generationIdFromCacheKey("cache-key")).toBe(
      `g_${sha256("cache-key").slice(0, 16)}`,
    );
    expect(jobIdFromDedupeKey("dedupe-key")).toBe(
      `j_${sha256("dedupe-key").slice(0, 16)}`,
    );
    expect(changeEventIdFromKey("event-key")).toBe(
      `e_${sha256("event-key").slice(0, 16)}`,
    );
    expect(newLessonId("seed")).toBe(`l_${sha256("seed").slice(0, 16)}`);
  });

  it("source ids embed kind and identity, so two commits never share an id", () => {
    const identity = `src/a.ts\u0000${"a".repeat(40)}\u00005-9`;
    expect(sourceIdOf("repo", identity)).toBe(
      `s_${sha256(`repo:${identity}`).slice(0, 16)}`,
    );
    const otherCommit = `src/a.ts\u0000${"b".repeat(40)}\u00005-9`;
    expect(sourceIdOf("repo", otherCommit)).not.toBe(
      sourceIdOf("repo", identity),
    );
  });

  it("newProjectId is a 16-hex random suffix and differs across calls", () => {
    const first = newProjectId();
    const second = newProjectId();
    expect(first).toMatch(/^p_[0-9a-f]{16}$/);
    expect(second).toMatch(/^p_[0-9a-f]{16}$/);
    expect(first).not.toBe(second);
  });
});

describe("sources helpers", () => {
  it("sliceHash is sha256 of the exact UTF-8 text", () => {
    expect(sliceHash("abc")).toBe(`sha256:${sha256("abc")}`);
    expect(sliceHash("中文")).toBe(`sha256:${sha256("中文")}`);
  });

  it("linesOf is 1-based by index and sliceLines is inclusive", () => {
    const text = "a\nb\nc\nd";
    expect(linesOf(text)).toEqual(["a", "b", "c", "d"]);
    expect(sliceLines(text, { start: 2, end: 3 })).toBe("b\nc");
    expect(sliceLines(text, { start: 1, end: 1 })).toBe("a");
    expect(sliceLines(text, { start: 0, end: 1 })).toBe("a");
    expect(sliceLines(text, { start: 4, end: 99 })).toBe("d");
    expect(sliceLines(text, { start: 3, end: 2 })).toBe("");
  });
});

describe("watch cursor", () => {
  it("round-trips through encode/decode", () => {
    const cursor = emptyCursor("pull_request");
    cursor.updatedAt = "2026-01-01T00:00:00.000Z";
    cursor.page = 2;
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(cursor.v).toBe(CURSOR_VERSION);
  });

  it("rejects malformed JSON and unknown versions", () => {
    expect(decodeCursor("not json")).toBeNull();
    expect(
      decodeCursor(JSON.stringify({ ...emptyCursor("default_branch"), v: 2 })),
    ).toBeNull();
    expect(decodeCursor(JSON.stringify({ v: 1 }))).toBeNull();
  });

  it("windowStart uses the watermark minus the overlap, or the lookback when absent", () => {
    const now = new Date("2026-01-10T00:00:00.000Z");
    const maxLookbackMs = 7 * 24 * 60 * 60 * 1000;
    const empty = emptyCursor("pull_request");
    expect(windowStart(empty, now, maxLookbackMs).toISOString()).toBe(
      new Date(now.getTime() - maxLookbackMs - 120_000).toISOString(),
    );
    const withWatermark = { ...empty, updatedAt: "2026-01-09T00:00:00.000Z" };
    expect(windowStart(withWatermark, now, maxLookbackMs).toISOString()).toBe(
      new Date(Date.parse("2026-01-09T00:00:00.000Z") - 120_000).toISOString(),
    );
  });
});

describe("job state machine", () => {
  it("declares the exact transition table", () => {
    expect(ALLOWED_JOB_TRANSITIONS).toEqual({
      queued: ["running", "cancelling", "cancelled"],
      running: ["completed", "failed", "cancelling", "interrupted"],
      cancelling: ["cancelled"],
      completed: [],
      failed: ["queued"],
      cancelled: ["queued"],
      interrupted: ["queued"],
    });
  });

  it("only failed/cancelled/interrupted are retryable", () => {
    expect(RETRYABLE_JOB_STATES).toEqual([
      "failed",
      "cancelled",
      "interrupted",
    ]);
  });
});

describe("scope normalization", () => {
  it("applies the documented defaults and a stable hash", () => {
    const scope = normalizeScope();
    expect(scope.include).toEqual(["**/*"]);
    expect(scope.exclude).toEqual([]);
    expect(scope.maxFiles).toBe(5000);
    expect(scope.maxFileBytes).toBe(5 * 1024 * 1024);
    expect(scope.hash).toBe(
      computeScopeHash({
        include: ["**/*"],
        exclude: [],
        maxFiles: 5000,
        maxFileBytes: 5 * 1024 * 1024,
      }),
    );
    expect(normalizeScope().hash).toBe(scope.hash);
  });

  it("keeps explicitly empty arrays instead of replacing them with defaults", () => {
    const scope = normalizeScope({ include: [], exclude: [] });
    expect(scope.include).toEqual([]);
    expect(scope.exclude).toEqual([]);
  });
});

describe("toPullRequestPayload is total", () => {
  it("maps every wire field to its stored name", () => {
    expect(
      toPullRequestPayload(
        {
          number: 42,
          state: "closed",
          merged: true,
          title: "Fix things",
          headRef: "feature/x",
          headSha: "a".repeat(40),
          baseRef: "main",
          baseHeadSha: "b".repeat(40),
          updatedAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2025-12-01T00:00:00.000Z",
        },
        "c".repeat(40),
      ),
    ).toEqual({
      number: 42,
      state: "closed",
      merged: true,
      title: "Fix things",
      headSha: "a".repeat(40),
      baseHeadSha: "b".repeat(40),
      mergeBaseSha: "c".repeat(40),
      updatedAt: "2026-01-01T00:00:00.000Z",
      branch: "feature/x",
      baseBranch: "main",
    });
  });
});

describe("LearningError", () => {
  it("derives its status from the single table", () => {
    expect(new LearningError("invalid_path", "nope").status).toBe(400);
    expect(new LearningError("source_removed", "gone").status).toBe(410);
    expect(new LearningError("internal_error", "boom").status).toBe(
      HTTP_STATUS_BY_CODE.internal_error,
    );
  });

  it("toErrorBody preserves code/message/details and hides unknown errors", () => {
    expect(
      toErrorBody(
        new LearningError("conflict", "conflict", { reason: "blank_teaching" }),
      ),
    ).toEqual({
      error: {
        code: "conflict",
        message: "conflict",
        details: { reason: "blank_teaching" },
      },
    });
    const unknownBody = toErrorBody(new Error("secret /Users/me/.codetrail"));
    expect(unknownBody.error.code).toBe("internal_error");
    expect(typeof unknownBody.error.message).toBe("string");
  });
});
