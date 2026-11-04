import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { GITHUB_ALLOWED_METHODS } from "../../../src/learning/contracts/index.ts";
import { createGithubClient } from "../../../src/learning/updates/github-client.ts";
import { startFakeGithub, type FakeGithub } from "../helpers/fake-github.ts";
import { fixedClock } from "../projects/harness.ts";

/**
 * AC-UPD-25: the fake server records no POST/PATCH/PUT/DELETE, and the client
 * surface contains no comment/commit/PR-creation path.
 */
describe("no GitHub writes", () => {
  let fake: FakeGithub | undefined;

  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  it("issues only GET/HEAD requests", async () => {
    fake = await startFakeGithub({
      ownerRepo: "acme/widgets",
      pages: 2,
      perPage: 2,
      states: ["open", "closed", "merged"],
    });
    const client = createGithubClient({
      baseUrl: fake.baseUrl,
      credential: null,
      clock: fixedClock(),
    });

    await client.defaultBranch("acme/widgets");
    await client.commitsSince("acme/widgets", "main", "2024-01-01T00:00:00Z", {
      page: 1,
      perPage: 10,
    });
    await client.pullRequests("acme/widgets", {
      state: "all",
      sort: "updated",
      direction: "desc",
      page: 1,
      perPage: 2,
    });
    await client.pullRequest("acme/widgets", 1);
    await client.rateLimit();

    expect(fake.requests.length).toBeGreaterThan(0);
    for (const request of fake.requests) {
      expect(["GET", "HEAD"]).toContain(request.method);
    }
    expect(fake.requests.some((request) => request.method === "POST")).toBe(
      false,
    );
    expect(GITHUB_ALLOWED_METHODS).toEqual(["GET"]);
  });

  it("has no write or comment surface in the client module", () => {
    const source = fs.readFileSync(
      fileURLToPath(
        new URL(
          "../../../src/learning/updates/github-client.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(source).not.toMatch(/\b(POST|PATCH|DELETE)\b/u);
    expect(source).not.toMatch(/\bPUT\b/u);
    expect(source).not.toMatch(/\/comments/u);
    expect(source).not.toMatch(/\/merges?/u);

    const client = createGithubClient({
      baseUrl: "http://127.0.0.1:1",
      credential: null,
      clock: fixedClock(),
    });
    expect(Object.keys(client).sort()).toEqual([
      "commitsSince",
      "defaultBranch",
      "pullRequest",
      "pullRequests",
      "rateLimit",
    ]);
  });

  it("reports an unknown rate limit when the header is absent", async () => {
    fake = await startFakeGithub({
      ownerRepo: "acme/widgets",
      pages: 1,
      perPage: 1,
      omitRateLimitHeaders: true,
    });
    const client = createGithubClient({
      baseUrl: fake.baseUrl,
      credential: null,
      clock: fixedClock(),
    });

    // A missing `X-RateLimit-Remaining` is unknown, never "0 remaining".
    await expect(client.rateLimit()).resolves.toBeNull();
  });
});
