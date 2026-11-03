import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CreateProjectResponse } from "../../../src/learning/contracts/index.ts";
import { startFakeGithub, type FakeGithub } from "../helpers/fake-github.ts";
import { fixturePath } from "../helpers/git-fixture.ts";
import { httpRequest, jsonBody } from "../helpers/stub-server.ts";
import {
  createBareRemote,
  startRoutesHarness,
  type RoutesHarness,
} from "./routes-harness.ts";

/**
 * AC-PRJ-04: a public GitHub import succeeds without a token against the fake
 * server, stores the canonical `github:owner/repo` identity, and really clones
 * the repository (the same origin serves Git smart HTTP).
 */

let server: RoutesHarness | undefined;
let github: FakeGithub | undefined;
let previousBase: string | undefined;
let previousToken: string | undefined;

beforeEach(async () => {
  previousBase = process.env.CODETRAIL_GITHUB_API_BASE_URL;
  previousToken = process.env.CODETRAIL_GITHUB_TOKEN;
  delete process.env.CODETRAIL_GITHUB_TOKEN;

  server = await startRoutesHarness();
  const gitRepoPath = createBareRemote(
    fixturePath("last-mile-mini"),
    server.paths.root + "/fake-remote",
  );
  github = await startFakeGithub({
    ownerRepo: "acme/widgets",
    pages: 1,
    perPage: 1,
    gitRepoPath,
  });
  process.env.CODETRAIL_GITHUB_API_BASE_URL = github.baseUrl;
});

afterEach(async () => {
  await github?.close();
  github = undefined;
  await server?.close();
  server = undefined;
  if (previousBase === undefined) delete process.env.CODETRAIL_GITHUB_API_BASE_URL;
  else process.env.CODETRAIL_GITHUB_API_BASE_URL = previousBase;
  if (previousToken === undefined) delete process.env.CODETRAIL_GITHUB_TOKEN;
  else process.env.CODETRAIL_GITHUB_TOKEN = previousToken;
});

describe("public GitHub import", () => {
  it("clones the public repository without a token", async () => {
    const response = await httpRequest(server!.port, {
      method: "POST",
      path: "/api/projects",
      headers: { ...server!.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ githubUrl: "https://github.com/acme/widgets" }),
    });

    expect(response.status).toBe(201);
    const ids = jsonBody(response) as CreateProjectResponse;
    const repo = server!.repos.repos.byId(ids.repoId);
    expect(repo?.identity).toBe("github:acme/widgets");
    expect(repo?.kind).toBe("github");
    expect(repo?.remoteUrl).toBe("https://github.com/acme/widgets.git");

    // The real clone hit the fake server's Git endpoints.
    expect(
      github!.requests.some((request) =>
        request.path.startsWith("/acme/widgets.git/info/refs"),
      ),
    ).toBe(true);

    const detail = await httpRequest(server!.port, {
      path: `/api/projects/${ids.projectId}`,
      headers: { ...server!.cookie },
    });
    expect(detail.status).toBe(200);
    const body = jsonBody(detail) as {
      kind: string;
      defaultBranch: string | null;
      displayName: string;
    };
    expect(body.kind).toBe("github");
    expect(body.defaultBranch).toBe("main");
    expect(body.displayName).toBe("acme/widgets");
  });
});
