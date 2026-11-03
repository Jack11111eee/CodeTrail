import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { changesRoutes } from "../../../src/learning/api/routes/changes.ts";
import {
  repoIdFromIdentity,
  type ProjectId,
  type PutWatchResponse,
  type WatchScheduler,
  type WatchTickResult,
} from "../../../src/learning/contracts/index.ts";
import { normalizeScope } from "../../../src/learning/projects/index.ts";
import { startHarness } from "../helpers/http-client.ts";
import type { Harness, HarnessResponse } from "../helpers/http-client.ts";
import { startRoutesServer } from "../helpers/routes-server.ts";
import type { RoutesServer } from "../helpers/routes-server.ts";

/**
 * `PUT /api/projects/:id/watch` (AC-UPD-01 HTTP half, AC-PRJ-13).
 *
 * The scheduler is a spy: a manual refresh must call `runTick(projectId)`
 * exactly once — never the all-project variant, never twice — and report the
 * tick's `{discovered,enqueued,gaps}` counters. Tests drive the tick through
 * the route, so no test sleeps.
 */

let server: RoutesServer | null = null;
let harness: Harness | null = null;

interface WatchSpy {
  readonly calls: (ProjectId | undefined)[];
  readonly scheduler: WatchScheduler;
  setNext(results: WatchTickResult[]): void;
}

function createWatchSpy(): WatchSpy {
  const calls: (ProjectId | undefined)[] = [];
  let next: WatchTickResult[] = [];
  const lastPollAt = "2026-01-01T00:00:05.000Z";
  return {
    calls,
    scheduler: {
      start(): void {},
      stop(): void {},
      runTick(projectId?: ProjectId): Promise<WatchTickResult[]> {
        calls.push(projectId);
        return Promise.resolve(next);
      },
      lastPollAt(): string | null {
        return lastPollAt;
      },
    },
    setNext(results: WatchTickResult[]): void {
      next = results;
    },
  };
}

let watchSpy: WatchSpy;

function seedProject(
  name: string,
  kind: "github" | "local",
  watchEnabled = false,
): ProjectId {
  const repoId = repoIdFromIdentity(`github:acme/${name}`);
  server!.repos.repos.upsert({
    repoId,
    identity: `github:acme/${name}`,
    kind,
    mirrorPath: `/tmp/${name}.git`,
    remoteUrl: kind === "github" ? `https://github.com/acme/${name}.git` : null,
    createdAt: server!.clock.now().toISOString(),
  });
  const projectId = `p_${name}` as ProjectId;
  server!.repos.projects.insert({
    projectId,
    repoId,
    kind,
    displayName: name,
    remoteUrl: kind === "github" ? `https://github.com/acme/${name}.git` : null,
    defaultBranch: "main",
    scope: normalizeScope(),
    watchEnabled,
    createdAt: server!.clock.now().toISOString(),
    deletedAt: null,
  });
  return projectId;
}

async function putWatch(
  projectId: ProjectId,
  body: Record<string, unknown>,
): Promise<HarnessResponse> {
  return harness!.request(`/api/projects/${projectId}/watch`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function jsonOf<T>(response: HarnessResponse, status = 200): T {
  expect(response.status).toBe(status);
  return response.json as T;
}

beforeEach(async () => {
  watchSpy = createWatchSpy();
  server = await startRoutesServer([changesRoutes], {
    deps: { watch: watchSpy.scheduler },
  });
  harness = await startHarness({ start: () => server! });
});

afterEach(async () => {
  await harness?.close();
  harness = null;
  server = null;
});

describe("PUT /api/projects/:id/watch", () => {
  it("runs exactly one tick with refreshNow and returns its counters", async () => {
    const projectId = seedProject("widgets", "github");
    watchSpy.setNext([
      {
        projectId,
        discovered: 3,
        enqueued: 2,
        gaps: 1,
        lastPollAt: "2026-01-01T00:00:09.000Z",
      },
    ]);

    const body = jsonOf<PutWatchResponse>(
      await putWatch(projectId, { enabled: true, refreshNow: true }),
    );

    expect(watchSpy.calls).toEqual([projectId]);
    expect(body).toEqual({
      watchEnabled: true,
      lastPollAt: "2026-01-01T00:00:09.000Z",
      refreshed: { discovered: 3, enqueued: 2, gaps: 1 },
    });
    expect(server!.repos.projects.byId(projectId)?.watchEnabled).toBe(true);
  });

  it("enables the watch without ticking when refreshNow is absent", async () => {
    const projectId = seedProject("widgets", "github");

    const body = jsonOf<PutWatchResponse>(
      await putWatch(projectId, { enabled: true }),
    );

    expect(watchSpy.calls).toEqual([]);
    expect(body.watchEnabled).toBe(true);
    expect(body.refreshed).toBeNull();
    expect(server!.repos.projects.byId(projectId)?.watchEnabled).toBe(true);
  });

  it("disables the watch without ticking", async () => {
    const projectId = seedProject("widgets", "github", true);

    const body = jsonOf<PutWatchResponse>(
      await putWatch(projectId, { enabled: false }),
    );

    expect(watchSpy.calls).toEqual([]);
    expect(body.watchEnabled).toBe(false);
    expect(body.refreshed).toBeNull();
    expect(server!.repos.projects.byId(projectId)?.watchEnabled).toBe(false);
  });

  it("returns 400 watch_requires_github for a local project", async () => {
    const projectId = seedProject("local-only", "local");

    const response = await putWatch(projectId, {
      enabled: true,
      refreshNow: true,
    });

    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({
      error: { code: "watch_requires_github" },
    });
    expect(watchSpy.calls).toEqual([]);
    expect(server!.repos.projects.byId(projectId)?.watchEnabled).toBe(false);
  });

  it("returns 409 conflict when refreshNow accompanies enabled:false", async () => {
    const projectId = seedProject("widgets", "github", true);

    const response = await putWatch(projectId, {
      enabled: false,
      refreshNow: true,
    });

    expect(response.status).toBe(409);
    expect(response.json).toMatchObject({ error: { code: "conflict" } });
    expect(watchSpy.calls).toEqual([]);
    // Refused before any write: the watch stays enabled.
    expect(server!.repos.projects.byId(projectId)?.watchEnabled).toBe(true);
  });

  it("answers 404 for an unknown project", async () => {
    const response = await putWatch("p_missing" as ProjectId, {
      enabled: true,
    });
    expect(response.status).toBe(404);
    expect(response.json).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("GET /api/projects/:id/changes/:changeId", () => {
  it("answers 404 for an unknown change id", async () => {
    const projectId = seedProject("widgets", "github");
    const response = await harness!.request(
      `/api/projects/${projectId}/changes/ch_missing`,
    );
    expect(response.status).toBe(404);
    expect(response.json).toMatchObject({ error: { code: "not_found" } });
  });
});
