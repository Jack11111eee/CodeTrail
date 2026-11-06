/**
 * Merge boundary: `updates` watch/discovery ◊ `projects` read routes ◊ the
 * cursor contract (AC-UPD-01/03/04/07, AC-PRJ-13 watch half).
 *
 * The updates branch owns discovery, the watch scheduler and the cursor
 * contract (`overlapMs` was added to `windowStart`); the projects branch owns
 * the read routes. This suite runs real discovery against a real Git mirror and
 * then reads the same rows back through `GET /api/projects/:id`, which is the
 * only place the scheduler's `lastPollAt` reaches the wire.
 *
 * It also pins the two behaviours that cross the branch boundary:
 *   - a local project can never start a tick (`watch_requires_github`) and the
 *     scheduler skips it;
 *   - `windowStart` keeps the documented default overlap and honours an
 *     explicit one, so the contract edit did not change existing cursors.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSessionStore, SESSION_COOKIE } from "../../../src/learning/api/auth.ts";
import { registerRouteModule } from "../../../src/learning/api/router.ts";
import { projectsRoutes } from "../../../src/learning/api/routes/projects.ts";
import { createLearningServer } from "../../../src/learning/api/server.ts";
import { PR_OVERLAP_MS } from "../../../src/learning/config/defaults.ts";
import type {
  AppDeps,
  ProjectDetail,
  ProjectListView,
  RunningServer,
} from "../../../src/learning/contracts/index.ts";
import {
  decodeCursor,
  encodeCursor,
  windowStart,
} from "../../../src/learning/contracts/cursor.ts";
import type { CursorJson } from "../../../src/learning/contracts/cursor.ts";
import {
  createWatchScheduler,
  runWatchTick,
} from "../../../src/learning/updates/watch.ts";
import { createUpdateHarness, type UpdateHarness } from "../updates/harness.ts";

let harness: UpdateHarness | undefined;
let server: RunningServer | undefined;
let cookie: Record<string, string>;

async function rawGet(
  path: string,
): Promise<{ status: number; text: string }> {
  const response = await fetch(new URL(path, server!.url), {
    headers: cookie,
  });
  return { status: response.status, text: await response.text() };
}

function getJson<T>(path: string): Promise<T> {
  return rawGet(path).then((response) => JSON.parse(response.text) as T);
}

/** Runs the projects route on top of the updates harness's own database. */
async function startProjectsReadServer(
  updateHarness: UpdateHarness,
): Promise<{ server: RunningServer; cookie: Record<string, string> }> {
  const session = createSessionStore(updateHarness.paths);
  const scheduler = createWatchScheduler(updateHarness.deps);
  const deps = {
    paths: updateHarness.paths,
    clock: updateHarness.clock,
    db: updateHarness.db,
    repos: updateHarness.repos,
    session,
    watch: scheduler,
    jobRunner: updateHarness.deps.jobRunner,
  } as unknown as AppDeps;

  registerRouteModule(projectsRoutes);
  const running = await createLearningServer({
    paths: updateHarness.paths,
    port: 0,
    clock: updateHarness.clock,
    deps,
  });
  const token = await session.ensureToken();
  return {
    server: running,
    cookie: { Cookie: `${SESSION_COOKIE}=${token}` },
  };
}

beforeEach(async () => {
  harness = await createUpdateHarness({
    pulls: [],
  });
  const started = await startProjectsReadServer(harness);
  server = started.server;
  cookie = started.cookie;
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  harness?.close();
  harness = undefined;
});

describe("watch discovery feeds the projects read routes", () => {
  it("publishes lastPollAt and the watch flag without touching generation state", async () => {
    const projectId = harness!.project.projectId;

    const before = await getJson<ProjectDetail>(
      `/api/projects/${projectId}`,
    );
    expect(before.watchEnabled).toBe(true);
    expect(before.lastPollAt).toBeNull();
    expect(before.latestJobState).toBeNull();
    expect(before.generationCount).toBe(0);

    const scheduler = createWatchScheduler(harness!.deps);
    const results = await scheduler.runTick(projectId);
    expect(results).toHaveLength(1);
    expect(results[0].projectId).toBe(projectId);
    expect(results[0].discovered).toBeGreaterThanOrEqual(1);

    const cursor = harness!.discoveryCursor("default_branch");
    expect(cursor).not.toBeNull();
    expect(cursor!.lastPollAt).not.toBeNull();

    const after = await getJson<ProjectDetail>(
      `/api/projects/${projectId}`,
    );
    expect(after.lastPollAt).toBe(cursor!.lastPollAt);
    expect(after.watchEnabled).toBe(true);
    expect(after.defaultBranch).toBe("main");
    // Discovery writes change events; it must not fabricate a generation.
    expect(after.generationCount).toBe(0);
    expect(after.analyzedCommitSha).toBeNull();

    const list = await getJson<ProjectListView>("/api/projects");
    expect(list.projects.find((p) => p.projectId === projectId)).toMatchObject({
      watchEnabled: true,
      latestJobState: null,
    });
  });

  it("stops discovering when watch is disabled and keeps the records", async () => {
    const projectId = harness!.project.projectId;
    await harness!.tick();
    const baselineEvents = harness!.events().length;
    expect(baselineEvents).toBeGreaterThanOrEqual(1);

    harness!.repos.projects.setWatch(projectId, false, null);

    const scheduler = createWatchScheduler(harness!.deps);
    const results = await scheduler.runTick();
    expect(results).toEqual([]);
    expect(harness!.events()).toHaveLength(baselineEvents);
    expect(harness!.discoveryCursor("default_branch")!.lastPollAt).not.toBeNull();

    await expect(
      runWatchTick(harness!.deps, projectId),
    ).rejects.toMatchObject({ code: "conflict" });

    const detail = await getJson<ProjectDetail>(
      `/api/projects/${projectId}`,
    );
    expect(detail.watchEnabled).toBe(false);
  });
});

describe("a local project cannot be watched", () => {
  it("rejects a tick with watch_requires_github and the scheduler skips it", async () => {
    // The same store holds a GitHub project and a local one; only the GitHub
    // row may ever enter discovery.
    const localProjectId = "p_local_watch_test";
    harness!.repos.projects.insert({
      projectId: localProjectId as never,
      repoId: harness!.repo.repoId,
      kind: "local",
      displayName: "local-checkout",
      remoteUrl: null,
      defaultBranch: "main",
      scope: harness!.project.scope,
      watchEnabled: true,
      createdAt: harness!.clock.now().toISOString(),
      deletedAt: null,
    });

    await expect(
      runWatchTick(harness!.deps, localProjectId as never),
    ).rejects.toMatchObject({ code: "watch_requires_github" });

    // Disable the GitHub row so a scheduler sweep has nothing else to do.
    harness!.repos.projects.setWatch(harness!.project.projectId, false, null);
    const scheduler = createWatchScheduler(harness!.deps);
    expect(await scheduler.runTick()).toEqual([]);
    expect(harness!.discoveryCursor("default_branch")).toBeNull();
  });
});

describe("the edited cursor contract", () => {
  const baseCursor = (): CursorJson => ({
    v: 1,
    streamKind: "pull_request",
    headSha: null,
    branch: null,
    updatedAt: "2024-06-01T00:30:00.000Z",
    page: null,
    baseSha: null,
    lastGapSha: null,
    lastGapAt: null,
    lastPollAt: null,
  });

  it("keeps the default overlap and honours an explicit overlapMs", () => {
    const now = new Date("2024-06-01T01:00:00.000Z");
    const cursor = baseCursor();
    const anchor = Date.parse(cursor.updatedAt!);

    // Three-argument call: unchanged legacy behaviour.
    expect(windowStart(cursor, now, 7 * 24 * 60 * 60 * 1000).getTime()).toBe(
      anchor - PR_OVERLAP_MS,
    );
    // Explicit overlap: the value passed by the watch tick is used verbatim.
    expect(
      windowStart(cursor, now, 7 * 24 * 60 * 60 * 1000, 1_000).getTime(),
    ).toBe(anchor - 1_000);
    expect(
      windowStart(cursor, now, 7 * 24 * 60 * 60 * 1000, 0).getTime(),
    ).toBe(anchor);
  });

  it("round-trips persisted cursors (including ones written by discovery)", async () => {
    await harness!.tick();
    const stored = harness!.discoveryCursor("default_branch")!;
    const decoded = decodeCursor(encodeCursor(stored));
    expect(decoded).toEqual(stored);

    const pull = harness!.discoveryCursor("pull_request");
    // A repository with no PRs may not have written the PR cursor yet; the
    // default-branch cursor is the one the watch tick always advances.
    expect(stored.lastPollAt).not.toBeNull();
    expect(pull?.streamKind ?? "pull_request").toBe("pull_request");
  });

  it("still discovers pull-request events within the overlap window", async () => {
    // Add a PR that points at a real commit of the harness mirror, then run
    // the same tick path the scheduler uses (baseline + PR in one tick).
    const head = harness!.git.head("main");
    harness!.github.setPulls([
      {
        number: 7,
        state: "open",
        merged: false,
        title: "widgets: change value",
        headRef: "feature-7",
        headSha: head,
        baseRef: "main",
        baseHeadSha: head,
        updatedAt: "2024-06-01T00:30:00.000Z",
        createdAt: "2024-06-01T00:00:00.000Z",
      },
    ]);

    const result = await createWatchScheduler(harness!.deps).runTick(
      harness!.project.projectId,
    );
    expect(result[0].discovered).toBeGreaterThanOrEqual(2);
    const pullCursor = harness!.discoveryCursor("pull_request");
    // A closed window advances the watermark to the tick instant.
    expect(pullCursor?.updatedAt).toBe(harness!.clock.now().toISOString());
    expect(pullCursor?.lastPollAt).toBe(harness!.clock.now().toISOString());
    expect(
      harness!.events().some((event) => event.streamKind === "pull_request"),
    ).toBe(true);
  });
});
