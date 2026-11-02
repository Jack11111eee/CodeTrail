import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { RepositoryRunError } from "../../../src/generation/errors.js";
import { ClaimsPageMissingError } from "../../../src/claims/core/errors.js";
import { WikiRetrievalError } from "../../../src/retrieval/wiki.js";
import type { ChatModelLike } from "../../../src/learning/contracts/index.js";
import {
  LearningError,
} from "../../../src/learning/contracts/index.js";
import {
  createUpstreamGenerationPort,
  mapUpstreamError,
} from "../../../src/learning/upstream/generation.js";
import type { NativeRepositoryRun } from "../../../src/learning/upstream/generation.js";

/**
 * Upstream error conversion (architecture §6.2, AC boundary rule).
 *
 * Every `RepositoryRunError` code has one documented target: `invalid_state`
 * is the only remap (`invalid_input` + `details.reason = "upstream_state"`).
 * Read-side upstream errors and unknown failures must also become
 * `LearningError`, so no upstream error type reaches the domain.
 */

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "codetrail-error-map-"));
  temporaryDirectories.push(root);
  return root;
}

async function runWith(
  run: NativeRepositoryRun,
): Promise<{ error: unknown }> {
  const port = createUpstreamGenerationPort({ run });
  const worktreePath = await temporaryDirectory();
  const error = await port
    .run({
      worktreePath,
      mode: "init",
      language: "zh",
      modelId: "test-model",
      model: {} as unknown as ChatModelLike,
      writeRepoFiles: false,
    })
    .then(
      () => null,
      (failure: unknown) => failure,
    );
  return { error };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("RepositoryRunError mapping", () => {
  test.each([
    { upstream: "invalid_input" as const, expected: "invalid_input" },
    { upstream: "conflict" as const, expected: "conflict" },
    { upstream: "not_found" as const, expected: "not_found" },
  ])(
    "maps $upstream to $expected unchanged",
    async ({ upstream, expected }) => {
      const { error } = await runWith(() =>
        Promise.reject(new RepositoryRunError(upstream, "upstream said no")),
      );

      expect(error).toBeInstanceOf(LearningError);
      const learning = error as LearningError;
      expect(learning.code).toBe(expected);
      expect(learning.message).toBe("upstream said no");
      expect(learning.details?.reason).toBeUndefined();
    },
  );

  test("maps invalid_state to invalid_input with details.reason upstream_state", async () => {
    const { error } = await runWith(() =>
      Promise.reject(new RepositoryRunError("invalid_state", "run is corrupt")),
    );

    expect(error).toBeInstanceOf(LearningError);
    const learning = error as LearningError;
    expect(learning.code).toBe("invalid_input");
    expect(learning.details).toEqual({ reason: "upstream_state" });
  });
});

function captureThrow(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected the action to throw");
}

describe("other upstream errors", () => {
  test("keeps a LearningError thrown by upstream unchanged", async () => {
    const original = new LearningError("conflict", "already published");
    const { error } = await runWith(() => Promise.reject(original));

    expect(error).toBe(original);
  });

  test("maps a missing claims page to not_found", () => {
    expect(
      captureThrow(() => mapUpstreamError(new ClaimsPageMissingError("gone"))),
    ).toMatchObject({ code: "not_found" });
  });

  test("maps an invalid retrieval request to invalid_input", () => {
    expect(
      captureThrow(() => mapUpstreamError(new WikiRetrievalError("bad query"))),
    ).toMatchObject({ code: "invalid_input" });
  });

  test("maps an unknown failure to internal_error", () => {
    expect(
      captureThrow(() => mapUpstreamError(new Error("socket closed"))),
    ).toMatchObject({ code: "internal_error" });
  });
});

describe("write guard", () => {
  test("refuses a request that would allow repository writes", async () => {
    const port = createUpstreamGenerationPort({
      run: () => Promise.resolve({ skipped: false }),
    });
    const worktreePath = await temporaryDirectory();

    await expect(
      port.run({
        worktreePath,
        mode: "init",
        language: "zh",
        modelId: "test-model",
        model: {} as unknown as ChatModelLike,
        // A hand-written caller bypassing the literal type must still fail.
        writeRepoFiles: true as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  test("forwards writeRepoFiles:false and pageConcurrency:1 to upstream", async () => {
    let captured: Parameters<NativeRepositoryRun>[0] | undefined;
    const port = createUpstreamGenerationPort({
      run: (options) => {
        captured = options;
        return Promise.resolve({ skipped: true });
      },
    });
    const worktreePath = await temporaryDirectory();

    await expect(
      port.run({
        worktreePath,
        mode: "update",
        language: "zh",
        modelId: "test-model",
        model: {} as unknown as ChatModelLike,
        writeRepoFiles: false,
      }),
    ).resolves.toEqual({ skipped: true, sourceChanged: false });

    expect(captured).toMatchObject({
      root: worktreePath,
      mode: "update",
      language: "zh",
      writeRepoFiles: false,
      pageConcurrency: 1,
    });
  });
});
