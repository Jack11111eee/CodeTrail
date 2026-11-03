/**
 * AC-F01-01 — local, public GitHub and authorised private GitHub sources all
 * import and complete one analysis with traceable sources and no token leak.
 *
 * The flow is HTTP-only: three imports, three analyses, then lesson, coverage
 * and source reads through the built server. The private half proves both
 * sides of the credential boundary: without a token the import is a structured
 * 401, with a token it succeeds, and the token never reaches any artefact.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  analyzeToCompletion,
  generationScripts,
  importGithub,
  importLocal,
  jsonOf,
  makeBareCopy,
  startAcceptance,
  treeContains,
  type AcceptanceServer,
} from "./support.ts";

const SOURCE_PATH = "src/lmp/state/snapshot_cache.py";
const LINES = { start: 6, end: 20 };
const DESIGN_PATH = "docs/decisions/decision-log.md";
const TOKEN = "ghp_acceptance_canary_7f3a9c";

const servers: AcceptanceServer[] = [];
const tempDirs: string[] = [];
const responses: string[] = [];

function record(response: { text: string }): void {
  responses.push(response.text);
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
  responses.length = 0;
});

describe("AC-F01-01: all three source kinds import and analyse", () => {
  test("local, public and token-gated private sources each publish one generation", async () => {
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-bare-"));
    tempDirs.push(bareDir);
    const bare = makeBareCopy("last-mile-mini", bareDir);

    const server = await startAcceptance({
      github: {
        ownerRepo: "acme/widgets",
        pages: 1,
        perPage: 1,
        gitRepoPath: bare,
      },
    });
    servers.push(server);
    server.writeScripts(
      generationScripts({
        sourcePath: SOURCE_PATH,
        lines: LINES,
        designPath: DESIGN_PATH,
        commitSha: server.commitSha,
      }),
    );

    // 1. Local source.
    const local = await importLocal(server);
    const localAnalysis = await analyzeToCompletion(server, local.projectId);
    expect(localAnalysis.job.state).toBe("completed");
    expect(localAnalysis.job.outputGenerationId).toBe(
      localAnalysis.analysis.generationId,
    );

    // 2. Public GitHub source: no token needed.
    const publicResponse = await importGithub(
      server,
      "https://github.com/acme/widgets",
    );
    const publicAnalysis = await analyzeToCompletion(
      server,
      publicResponse.projectId,
    );
    expect(publicAnalysis.job.state).toBe("completed");

    // 3. Private GitHub source: a separate token-gated fake.
    const privateFake = await server.startFake({
      ownerRepo: "acme/widgets-private",
      pages: 1,
      perPage: 1,
      token: TOKEN,
      gitRepoPath: bare,
    });
    await server.restart({
      CODETRAIL_GITHUB_API_BASE_URL: privateFake.baseUrl,
    });

    const deniedBody = await server.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        githubUrl: "https://github.com/acme/widgets-private",
      }),
    });
    record(deniedBody);
    expect(deniedBody.status).toBe(401);
    expect(deniedBody.json).toMatchObject({
      error: { code: "github_auth_failed" },
    });

    await server.restart({ CODETRAIL_GITHUB_TOKEN: TOKEN });
    const privateAnalysis = await analyzeToCompletion(
      server,
      (await importGithub(server, "https://github.com/acme/widgets-private"))
        .projectId,
    );
    expect(privateAnalysis.job.state).toBe("completed");

    // Every generation is traceable: a published lesson cites a real file at
    // the analysed commit, and the coverage report lists that file.
    const generations = [
      localAnalysis.analysis.generationId,
      publicAnalysis.analysis.generationId,
      privateAnalysis.analysis.generationId,
    ];
    const sourceIds: string[] = [];
    for (const generationId of generations) {
      const coverageResponse = await server.request(
        `/api/generations/${generationId}/coverage`,
      );
      record(coverageResponse);
      const coverage = jsonOf<{
        complete: boolean;
        analyzed: { path: string }[];
        commitSha: string;
      }>(coverageResponse, 200);
      expect(coverage.complete).toBe(true);
      expect(coverage.commitSha).toBe(server.commitSha);
      expect(coverage.analyzed.some((file) => file.path === SOURCE_PATH)).toBe(
        true,
      );

      const lessonsResponse = await server.request(
        `/api/generations/${generationId}/lessons`,
      );
      record(lessonsResponse);
      const list = jsonOf<{ lessons: { lessonId: string }[] }>(
        lessonsResponse,
        200,
      );
      expect(list.lessons).toHaveLength(1);

      const detailResponse = await server.request(
        `/api/generations/${generationId}/lessons/${list.lessons[0].lessonId}`,
      );
      record(detailResponse);
      const detail = jsonOf<{
        lesson: { evidence: string[]; context: { commitSha: string } };
        diagram: { nodes: { evidenceIds: string[] }[] };
      }>(detailResponse, 200);
      expect(detail.lesson.context.commitSha).toBe(server.commitSha);
      expect(detail.lesson.evidence.length).toBeGreaterThan(0);
      expect(detail.diagram.nodes[0].evidenceIds.length).toBeGreaterThan(0);
      sourceIds.push(...detail.lesson.evidence);

      const sourceResponse = await server.request(
        `/api/generations/${generationId}/sources/${detail.lesson.evidence[0]}`,
      );
      record(sourceResponse);
      expect(sourceResponse.status).toBe(200);
    }

    // Three distinct repositories, one shared pair of traceable source ids.
    expect(sourceIds).toHaveLength(6);
    expect(new Set(sourceIds).size).toBe(2);

    // No response text and no file in the data directory carries the token.
    expect(responses.some((text) => text.includes(TOKEN))).toBe(false);
    expect(treeContains(server.dataDir, TOKEN)).toBe(false);

    // A request with the token never leaks it either.
    const withToken = await server.request("/api/settings/model");
    record(withToken);
    expect(withToken.text.includes(TOKEN)).toBe(false);
  }, 120_000);

  test("a failed private import leaves no project behind", async () => {
    // The previous test already proved the 401; this one pins the invariant
    // that the failed attempt is not silently recorded as a project.
    const server = await startAcceptance({
      configureModel: false,
      github: {
        ownerRepo: "acme/private",
        pages: 1,
        perPage: 1,
        token: TOKEN,
      },
    });
    servers.push(server);

    const response = await server.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ githubUrl: "https://github.com/acme/private" }),
    });
    record(response);
    expect(response.status).toBe(401);

    const listResponse = await server.request("/api/projects");
    record(listResponse);
    const list = jsonOf<{ projects: unknown[] }>(listResponse, 200);
    expect(list.projects).toEqual([]);
  }, 120_000);
});
