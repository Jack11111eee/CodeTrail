/* eslint-disable @typescript-eslint/require-await -- test doubles implement async ports */
/**
 * AC-R14-02: rate limiting and credentials fail explicitly and distinguishably.
 * A 429 with `Retry-After` is retried up to the configured attempt count and
 * then surfaces `rate_limited`; missing credentials are `github_auth_failed`
 * and an unconfigured model is `model_not_configured`; the four failure classes
 * (network, model, auth, rate limit) have different codes, statuses and copy,
 * and none of them is ever recorded as a success.
 */
import { afterEach, describe, expect, test } from "vitest";

import {
  errorMessageFor,
  HTTP_STATUS_BY_CODE,
  LearningError,
  toErrorBody,
  type HttpErrorCode,
} from "../../../src/learning/contracts/index.ts";
import { createGithubClient } from "../../../src/learning/updates/github-client.ts";
import { fetchWithResilience } from "../../../src/connectors/http.ts";
import { startFakeGithub, type FakeGithub } from "../helpers/fake-github.ts";
import { fixedClock } from "../projects/harness.ts";
import {
  cleanupHarness,
  createRealRunner,
  createUpdateHarness,
  type UpdateHarness,
} from "../updates/harness.ts";

let fake: FakeGithub | undefined;
let harness: UpdateHarness | undefined;

afterEach(async () => {
  cleanupHarness(harness);
  harness = undefined;
  await fake?.close();
  fake = undefined;
});

async function rejection(promise: Promise<unknown>): Promise<LearningError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LearningError);
    return error as LearningError;
  }
  throw new Error("expected the call to reject");
}

describe("AC-R14-02 — rate limits and credentials", () => {
  test("429 with Retry-After retries up to the configured count then fails", async () => {
    fake = await startFakeGithub({
      ownerRepo: "acme/widgets",
      pages: 1,
      perPage: 1,
      failFirst: 5,
      retryAfter: 7,
    });
    const sleep = async (): Promise<void> => undefined;

    const exhausted = await fetchWithResilience(
      `${fake.baseUrl}/repos/acme/widgets`,
      {},
      { maxRetries: 2, sleep, random: () => 0 },
    );
    expect(exhausted.status).toBe(429);
    // First attempt + two retries, then it gives up.
    expect(fake.requests).toHaveLength(3);

    // The final 429 maps to the documented `rate_limited` code.
    const client = createGithubClient({
      baseUrl: fake.baseUrl,
      credential: null,
      clock: fixedClock(),
    });
    const rateError = await rejection(client.defaultBranch("acme/widgets"));
    expect(rateError.code).toBe("rate_limited");
    expect(rateError.status).toBe(429);
    expect(rateError.message).toBe(errorMessageFor("rate_limited", "zh"));
  });

  test("a transient 429 that clears within the retry budget succeeds", async () => {
    fake = await startFakeGithub({
      ownerRepo: "acme/widgets",
      pages: 1,
      perPage: 1,
      failFirst: 2,
      retryAfter: 1,
    });
    const response = await fetchWithResilience(
      `${fake.baseUrl}/repos/acme/widgets`,
      {},
      {
        maxRetries: 3,
        sleep: async () => undefined,
        random: () => 0,
      },
    );
    expect(response.status).toBe(200);
    expect(fake.requests).toHaveLength(3);
  });

  test("missing credentials are github_auth_failed, never a silent success", async () => {
    fake = await startFakeGithub({
      ownerRepo: "acme/widgets",
      pages: 1,
      perPage: 1,
      token: "s3cret",
    });
    const clock = fixedClock();

    const anonymous = createGithubClient({
      baseUrl: fake.baseUrl,
      credential: null,
      clock,
    });
    const authError = await rejection(anonymous.defaultBranch("acme/widgets"));
    expect(authError.code).toBe("github_auth_failed");
    expect(authError.status).toBe(401);
    expect(authError.message).toBe(errorMessageFor("github_auth_failed", "zh"));

    const authorised = createGithubClient({
      baseUrl: fake.baseUrl,
      credential: { kind: "token", token: "s3cret", login: null },
      clock,
    });
    await expect(authorised.defaultBranch("acme/widgets")).resolves.toBe(
      "main",
    );
  });

  test("the four failure classes differ in code, status and copy", async () => {
    // Network: an unreachable loopback port.
    const offlineClient = createGithubClient({
      baseUrl: "http://127.0.0.1:1",
      credential: null,
      clock: fixedClock(),
    });
    const networkError = await rejection(
      offlineClient.defaultBranch("acme/widgets"),
    );
    expect(networkError.code).toBe("internal_error");
    expect(networkError.status).toBe(500);

    // Rate limit / auth against the fake server.
    fake = await startFakeGithub({
      ownerRepo: "acme/widgets",
      pages: 1,
      perPage: 1,
      failFirst: 1,
      retryAfter: 7,
    });
    const rateClient = createGithubClient({
      baseUrl: fake.baseUrl,
      credential: null,
      clock: fixedClock(),
    });
    const rateError = await rejection(rateClient.defaultBranch("acme/widgets"));
    await fake.close();
    fake = await startFakeGithub({
      ownerRepo: "acme/widgets",
      pages: 1,
      perPage: 1,
      token: "s3cret",
    });
    const authClient = createGithubClient({
      baseUrl: fake.baseUrl,
      credential: null,
      clock: fixedClock(),
    });
    const authError = await rejection(authClient.defaultBranch("acme/widgets"));

    // Model: a discovered change job run with no configured model.
    harness = await createUpdateHarness();
    await harness.tick();
    harness.git.write("src/model.ts", "export const model = 1;\n");
    harness.git.commit("feat: model");
    await harness.tick();
    const job = harness.jobs()[0];
    harness.repos.jobs.transition(job.jobId, ["queued"], "interrupted", {
      errorCode: "interrupted",
      finishedAt: harness.clock.now().toISOString(),
    });
    const { runner } = createRealRunner(harness);
    await runner.retry(job.jobId);
    await runner.drain();
    const failed = await runner.get(job.jobId);
    expect(failed?.state).toBe("failed");
    expect(failed?.errorCode).toBe("model_not_configured");

    const codes: HttpErrorCode[] = [
      networkError.code,
      "model_not_configured",
      authError.code,
      rateError.code,
    ];
    expect(new Set(codes).size).toBe(4);
    expect(codes.map((code) => HTTP_STATUS_BY_CODE[code])).toEqual([
      500, 400, 401, 429,
    ]);
    const messages = codes.map((code) => errorMessageFor(code, "zh"));
    expect(new Set(messages).size).toBe(4);
    for (const code of codes) {
      const body = toErrorBody(
        new LearningError(code, errorMessageFor(code, "zh")),
      );
      expect(body.error.code).toBe(code);
      expect(body.error.message).toBe(errorMessageFor(code, "zh"));
    }
  });
});
