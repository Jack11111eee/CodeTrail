import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CreateAnalysisResponse,
  CreateProjectResponse,
  JobEvent,
} from "../../../src/learning/contracts/index.ts";
import { startFakeGithub, type FakeGithub } from "../helpers/fake-github.ts";
import { fixturePath } from "../helpers/git-fixture.ts";
import { errorCode, httpRequest, jsonBody } from "../helpers/stub-server.ts";
import {
  createBareRemote,
  startRoutesHarness,
  type RoutesHarness,
} from "./routes-harness.ts";

/**
 * AC-PRJ-05: an unauthenticated private import is `401 github_auth_failed`;
 * with the token it succeeds. The token canary never reaches the database, a
 * log, a job event or a lesson JSON.
 */

const CANARY = "ghp_private_canary_1234567890";

let server: RoutesHarness | undefined;
let github: FakeGithub | undefined;
let previousBase: string | undefined;
let previousToken: string | undefined;

beforeEach(async () => {
  previousBase = process.env.CODETRAIL_GITHUB_API_BASE_URL;
  previousToken = process.env.CODETRAIL_GITHUB_TOKEN;

  server = await startRoutesHarness();
  const gitRepoPath = createBareRemote(
    fixturePath("last-mile-mini"),
    server.paths.root + "/fake-private",
  );
  github = await startFakeGithub({
    ownerRepo: "acme/widgets",
    pages: 1,
    perPage: 1,
    token: CANARY,
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

function importBody() {
  return JSON.stringify({ githubUrl: "https://github.com/acme/widgets" });
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  visit(root);
  return files;
}

describe("private GitHub import", () => {
  it("returns github_auth_failed without a token", async () => {
    delete process.env.CODETRAIL_GITHUB_TOKEN;
    const response = await httpRequest(server!.port, {
      method: "POST",
      path: "/api/projects",
      headers: { ...server!.cookie, "Content-Type": "application/json" },
      body: importBody(),
    });
    expect(response.status).toBe(401);
    expect(errorCode(response)).toBe("github_auth_failed");
    expect(server!.repos.projects.list()).toEqual([]);
  });

  it("succeeds with a token and never leaks the canary", async () => {
    process.env.CODETRAIL_GITHUB_TOKEN = CANARY;

    const imported = await httpRequest(server!.port, {
      method: "POST",
      path: "/api/projects",
      headers: { ...server!.cookie, "Content-Type": "application/json" },
      body: importBody(),
    });
    expect(imported.status).toBe(201);
    const ids = jsonBody(imported) as CreateProjectResponse;
    expect(server!.repos.repos.byId(ids.repoId as never)?.identity).toBe(
      "github:acme/widgets",
    );

    const events: JobEvent[] = [];
    const analysis = await httpRequest(server!.port, {
      method: "POST",
      path: `/api/projects/${ids.projectId}/analyses`,
      headers: { ...server!.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "HEAD" }),
    });
    expect(analysis.status).toBe(202);
    const submission = jsonBody(analysis) as CreateAnalysisResponse;
    const unsubscribe = server!.jobRunner.subscribe(submission.jobId, (event) =>
      events.push(event),
    );
    await server!.jobRunner.drain();
    unsubscribe();

    const job = await server!.jobRunner.get(submission.jobId);
    expect(job?.state).toBe("completed");

    const surfaces: string[] = [
      imported.text,
      analysis.text,
      JSON.stringify(job),
      JSON.stringify(events),
      fs.readFileSync(server!.paths.db).toString("utf8"),
    ];
    const credentials = server!.paths.credentials;
    if (fs.existsSync(credentials)) {
      surfaces.push(fs.readFileSync(credentials, "utf8"));
    }
    for (const file of walkFiles(server!.paths.knowledge)) {
      surfaces.push(fs.readFileSync(file, "utf8"));
    }
    for (const file of walkFiles(server!.paths.logs)) {
      surfaces.push(fs.readFileSync(file, "utf8"));
    }

    for (const surface of surfaces) {
      expect(surface).not.toContain(CANARY);
    }
  });
});
