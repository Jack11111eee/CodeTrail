/**
 * AC-F06-01 — default-branch and PR streams produce independent events and
 * records, both cursors advance independently, and the PR preview and main
 * versions remain distinct.
 *
 * Ticks are driven through `PUT …/watch {refreshNow:true}`; the fake GitHub
 * server provides the read-only REST surface while the mirror is a real bare
 * checkout of `watch-remote.git`. The "main version" is the generation the
 * learner publishes for the default branch, so a PR preview can never be
 * confused with it.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { fixturePath, fixtureSha } from "../helpers/git-fixture.ts";
import {
  analyzeToCompletion,
  generationScripts,
  importGithub,
  jsonOf,
  putJson,
  startAcceptance,
  type AcceptanceServer,
} from "./support.ts";

const README = "README.md";

let server: AcceptanceServer | null = null;
const tempDirs: string[] = [];

afterEach(async () => {
  await server?.close();
  server = null;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

interface ChangeSummary {
  changeId: string;
  kind: string;
  streamKind: string;
  state: string;
  headSha: string | null;
  baseSha: string | null;
  publishedAt: string | null;
}

interface ChangeList {
  items: ChangeSummary[];
}

interface ChangeDetail {
  change: ChangeSummary;
  payload: {
    pr?: { number: number; headSha: string; baseHeadSha: string };
    commit?: { firstParent: string | null };
  };
  commitRef: { sha: string } | null;
}

interface WatchResponse {
  watchEnabled: boolean;
  lastPollAt: string | null;
  refreshed: { discovered: number; enqueued: number; gaps: number } | null;
}

function commitOnTopOfMirror(mirrorPath: string): string {
  const working = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-watch-"));
  tempDirs.push(working);
  // Clone the mirror itself so successive commits build on the previous push.
  execFileSync("git", ["clone", "--quiet", mirrorPath, working], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  execFileSync("git", [
    "-C",
    working,
    "config",
    "user.email",
    "test@example.com",
  ]);
  execFileSync("git", ["-C", working, "config", "user.name", "Watch Test"]);
  fs.appendFileSync(
    path.join(working, README),
    "\n- follow-up: 变更后的审批路径\n",
    "utf8",
  );
  execFileSync("git", ["-C", working, "add", README]);
  execFileSync("git", [
    "-C",
    working,
    "commit",
    "--quiet",
    "-m",
    "change approval path",
  ]);
  const sha = execFileSync("git", ["-C", working, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  execFileSync(
    "git",
    ["-C", working, "push", mirrorPath, "HEAD:refs/heads/main"],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return sha;
}

async function changes(
  target: AcceptanceServer,
  projectId: string,
): Promise<ChangeList> {
  return jsonOf<ChangeList>(
    await target.request(`/api/projects/${projectId}/changes?limit=50`),
    200,
  );
}

function refresh(
  target: AcceptanceServer,
  projectId: string,
): Promise<WatchResponse> {
  return putJson(target, `/api/projects/${projectId}/watch`, {
    enabled: true,
    refreshNow: true,
  }).then((response) => jsonOf<WatchResponse>(response, 200));
}

describe("AC-F06-01: independent default-branch and PR streams", () => {
  test("both streams advance independently and restart resumes from cursors", async () => {
    const mainHead = fixtureSha("watch-remote.git", "main");
    server = await startAcceptance({
      fixture: "last-mile-mini",
      // The fake server's PR timestamps sit just before 2024-06-01; the clock
      // must be inside the configured lookback for the first tick to see them.
      env: { CODETRAIL_NOW: "2024-06-01T00:05:00.000Z" },
      github: {
        ownerRepo: "acme/watch",
        pages: 1,
        perPage: 2,
        gitRepoPath: fixturePath("watch-remote.git"),
      },
    });
    server.fakeGithub!.pushCommit(mainHead);
    server.writeScripts(
      generationScripts({
        sourcePath: README,
        lines: { start: 1, end: 1 },
        commitSha: mainHead,
      }),
    );

    const project = await importGithub(server, "https://github.com/acme/watch");
    const mirror = path.join(
      server.dataDir,
      "mirrors",
      `${project.repoId}.git`,
    );

    // First tick: a default-branch baseline plus two PR previews.
    const first = await refresh(server, project.projectId);
    expect(first.watchEnabled).toBe(true);
    expect(first.refreshed?.discovered).toBe(3);
    expect(first.refreshed?.enqueued).toBe(2);

    const afterFirst = await changes(server, project.projectId);
    expect(afterFirst.items).toHaveLength(3);
    const baseline = afterFirst.items.find((item) => item.kind === "baseline");
    const pullRequests = afterFirst.items.filter(
      (item) => item.streamKind === "pull_request",
    );
    expect(baseline?.streamKind).toBe("default_branch");
    expect(baseline?.headSha).toBe(mainHead);
    expect(pullRequests).toHaveLength(2);
    for (const pr of pullRequests) {
      expect(pr.headSha).not.toBe(mainHead);
      expect(pr.baseSha).not.toBe(pr.headSha);
    }

    // A PR detail keeps its own preview head/base, never the main version.
    const prDetail = jsonOf<ChangeDetail>(
      await server.request(
        `/api/projects/${project.projectId}/changes/${pullRequests[0].changeId}`,
      ),
      200,
    );
    expect(prDetail.payload.pr?.headSha).toBe(pullRequests[0].headSha);
    expect(prDetail.payload.pr?.baseHeadSha).toBe(pullRequests[0].baseSha);
    expect(prDetail.commitRef?.sha).toBe(pullRequests[0].headSha);

    // The main version the learner reads: one analysis at the main head.
    const mainAnalysis = await analyzeToCompletion(server, project.projectId);
    expect(mainAnalysis.job.state).toBe("completed");
    const mainCommit = jsonOf<{ commitSha: string }>(
      await server.request(
        `/api/generations/${mainAnalysis.analysis.generationId}/coverage`,
      ),
      200,
    ).commitSha;
    expect(mainCommit).toBe(mainHead);
    for (const pr of pullRequests) {
      expect(pr.headSha).not.toBe(mainCommit);
    }

    // A new default-branch commit is discovered by its own stream only.
    const newHead = commitOnTopOfMirror(mirror);
    server.fakeGithub!.pushCommit(newHead);
    const second = await refresh(server, project.projectId);
    expect(second.refreshed?.discovered).toBe(1);
    expect(second.refreshed?.enqueued).toBe(1);

    const afterSecond = await changes(server, project.projectId);
    const commitEvent = afterSecond.items.find(
      (item) => item.kind === "commit" && item.headSha === newHead,
    );
    expect(commitEvent?.streamKind).toBe("default_branch");
    expect(commitEvent?.baseSha).toBe(mainHead);
    // The PR previews are untouched by the default-branch advance.
    const prsAfter = afterSecond.items.filter(
      (item) => item.streamKind === "pull_request",
    );
    expect(prsAfter.map((item) => item.changeId)).toEqual(
      pullRequests.map((item) => item.changeId),
    );
    expect(prsAfter.map((item) => item.state)).toEqual(
      pullRequests.map((item) => item.state),
    );

    const commitDetail = jsonOf<ChangeDetail>(
      await server.request(
        `/api/projects/${project.projectId}/changes/${commitEvent!.changeId}`,
      ),
      200,
    );
    expect(commitDetail.payload.commit?.firstParent).toBe(mainHead);

    // A further tick discovers nothing: the default-branch cursor advanced and
    // the PR cursor must not replay either.
    const third = await refresh(server, project.projectId);
    expect(third.refreshed?.discovered).toBe(0);
    const beforeRestart = await changes(server, project.projectId);

    // Restart mid-watch: both cursors are durable, so nothing is replayed.
    await server.restart();
    const fourth = await refresh(server, project.projectId);
    expect(fourth.refreshed?.discovered).toBe(0);
    const afterRestart = await changes(server, project.projectId);
    expect(afterRestart.items.map((item) => item.changeId)).toEqual(
      beforeRestart.items.map((item) => item.changeId),
    );
    // A brand-new default-branch commit after restart is still picked up,
    // proving the default-branch cursor did not jump past the new head.
    const thirdHead = commitOnTopOfMirror(mirror);
    server.fakeGithub!.pushCommit(thirdHead);
    const fifth = await refresh(server, project.projectId);
    expect(fifth.refreshed?.discovered).toBe(1);
    const finalList = await changes(server, project.projectId);
    expect(
      finalList.items.some(
        (item) =>
          item.streamKind === "default_branch" && item.headSha === thirdHead,
      ),
    ).toBe(true);
  }, 240_000);
});
