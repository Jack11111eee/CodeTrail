import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ChangeDetailView,
  ChangeListView,
  ProjectId,
  PutWatchResponse,
  WatchScheduler,
  WatchTickResult,
} from "../../../src/learning/contracts/index.ts";
import { startHarness } from "../helpers/http-client.ts";
import type { Harness, HarnessResponse } from "../helpers/http-client.ts";
import {
  eventIdOf,
  seedEvent,
  seedProject,
  startChangesServer,
} from "./merged-changes-harness.ts";
import type {
  ChangesHarness,
  SeededProject,
} from "./merged-changes-harness.ts";

/**
 * Merge boundary: `PUT /api/projects/:id/watch` (manual refresh) → the watch
 * scheduler → the `change_events` store → `GET /changes` / `/changes/:id`.
 *
 * The routes-changes branch wires the three routes together through one
 * scheduler port. This suite runs the real repository and route handlers with a
 * scheduler that persists what a tick "discovered", then reads the inbox back
 * over HTTP — the exact path the UI takes after a manual refresh.
 *
 * It also pins the project-state boundary the branch relies on: a local project
 * is refused, a disabled watch cannot be refreshed, and a removed project is
 * `410 source_removed` on all three routes (never a 404 or a redirect).
 */

const LAST_POLL_AT = "2026-01-01T00:00:05.000Z";

interface WatchSpy {
  readonly calls: (ProjectId | undefined)[];
  readonly scheduler: WatchScheduler;
  /** What the "poll" persisted; the route must serve it on the next read. */
  create(project: SeededProject, count: number): void;
}

function createWatchSpy(server: ChangesHarness): WatchSpy {
  const calls: (ProjectId | undefined)[] = [];
  const results = new Map<ProjectId, WatchTickResult>();

  return {
    calls,
    scheduler: {
      start(): void {},
      stop(): void {},
      runTick(projectId?: ProjectId): Promise<WatchTickResult[]> {
        calls.push(projectId);
        if (projectId === undefined) return Promise.resolve([]);
        const result = results.get(projectId);
        return Promise.resolve(result === undefined ? [] : [result]);
      },
      lastPollAt(): string | null {
        return LAST_POLL_AT;
      },
    },
    create(project: SeededProject, count: number): void {
      for (let seq = 1; seq <= count; seq += 1) {
        seedEvent(server.repos, project, {
          seq,
          discoveredAt: `2026-01-01T00:00:0${String(seq)}.000Z`,
          headSha: `discovered-${String(seq)}`,
        });
      }
      results.set(project.projectId, {
        projectId: project.projectId,
        discovered: count,
        enqueued: Math.max(0, count - 1),
        gaps: count > 0 ? 1 : 0,
        lastPollAt: LAST_POLL_AT,
      });
    },
  };
}

let server: ChangesHarness | null = null;
let harness: Harness | null = null;
let watch: WatchSpy | null = null;

beforeEach(async () => {
  server = await startChangesServer();
  watch = createWatchSpy(server);
  // The handlers read `deps.watch` at request time; the production CLI builds
  // the same object once. Attaching after start mirrors that late binding.
  (server.deps as unknown as { watch: WatchScheduler }).watch =
    watch.scheduler;
  harness = await startHarness({ start: () => server! });
});

afterEach(async () => {
  await harness?.close();
  harness = null;
  await server?.close();
  server = null;
  watch = null;
});

async function putWatch(
  projectId: string,
  body: Record<string, unknown>,
): Promise<HarnessResponse> {
  return harness!.request(`/api/projects/${projectId}/watch`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function detailPath(projectId: ProjectId, seq: number): string {
  return `/api/projects/${projectId}/changes/${eventIdOf(projectId, seq)}`;
}

describe("manual watch refresh feeds the change inbox", () => {
  it("runs exactly one project-scoped tick and serves what it discovered", async () => {
    const project = seedProject(server!.repos, server!.clock, "acme");
    watch!.create(project, 2);

    const response = await putWatch(project.projectId, {
      enabled: true,
      refreshNow: true,
    });
    expect(response.status).toBe(200);
    const body = response.json as PutWatchResponse;
    expect(body.watchEnabled).toBe(true);
    expect(body.lastPollAt).toBe(LAST_POLL_AT);
    expect(body.refreshed).toEqual({ discovered: 2, enqueued: 1, gaps: 1 });

    expect(watch!.calls).toEqual([project.projectId]);
    expect(server!.repos.projects.byId(project.projectId)?.watchEnabled).toBe(
      true,
    );

    const list = await harness!.request(
      `/api/projects/${project.projectId}/changes`,
    );
    expect(list.status).toBe(200);
    const page = list.json as ChangeListView;
    expect(page.items).toHaveLength(2);
    expect(page.items.map((item) => item.headSha)).toEqual([
      "discovered-2",
      "discovered-1",
    ]);

    const detail = await harness!.request(
      detailPath(project.projectId, 2),
    );
    expect(detail.status).toBe(200);
    const view = detail.json as ChangeDetailView;
    expect(view.change.changeId).toBe(eventIdOf(project.projectId, 2));
    expect(view.commitRef).toEqual({
      sha: "discovered-2",
      label: "提交 discovered-2",
    });
  });

  it("does not tick when refreshNow is absent", async () => {
    const project = seedProject(server!.repos, server!.clock, "acme");

    const response = await putWatch(project.projectId, { enabled: true });
    expect(response.status).toBe(200);
    const body = response.json as PutWatchResponse;
    expect(body.refreshed).toBeNull();
    expect(watch!.calls).toEqual([]);

    const list = (await harness!.request(
      `/api/projects/${project.projectId}/changes`,
    )).json as ChangeListView;
    expect(list.items).toEqual([]);
  });

  it("refuses a local project before any write or tick", async () => {
    const project = seedProject(
      server!.repos,
      server!.clock,
      "local-only",
      "local",
    );

    const response = await putWatch(project.projectId, {
      enabled: true,
      refreshNow: true,
    });
    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({
      error: { code: "watch_requires_github" },
    });
    expect(watch!.calls).toEqual([]);
    expect(server!.repos.projects.byId(project.projectId)?.watchEnabled).toBe(
      false,
    );
  });

  it("refuses refreshNow on a disabled watch without writing the flag", async () => {
    const project = seedProject(server!.repos, server!.clock, "acme");

    const response = await putWatch(project.projectId, {
      enabled: false,
      refreshNow: true,
    });
    expect(response.status).toBe(409);
    expect(response.json).toMatchObject({
      error: { code: "conflict", details: { reason: "watch_disabled" } },
    });
    expect(watch!.calls).toEqual([]);
    expect(server!.repos.projects.byId(project.projectId)?.watchEnabled).toBe(
      false,
    );
  });

  it("answers 410 source_removed on all three routes for a removed project", async () => {
    const project = seedProject(server!.repos, server!.clock, "gone");
    seedEvent(server!.repos, project, { seq: 1 });
    server!.repos.projects.markDeleted(
      project.projectId,
      server!.clock.now().toISOString(),
    );

    for (const request of [
      () => putWatch(project.projectId, { enabled: true }),
      () =>
        harness!.request(`/api/projects/${project.projectId}/changes`),
      () => harness!.request(detailPath(project.projectId, 1)),
    ]) {
      const response = await request();
      expect(response.status).toBe(410);
      expect(response.json).toMatchObject({
        error: {
          code: "source_removed",
          details: { reason: "project_removed" },
        },
      });
    }
    expect(watch!.calls).toEqual([]);
  });

  it("answers 404 for an unknown project on all three routes", async () => {
    const responses = await Promise.all([
      putWatch("p_missing", { enabled: true }),
      harness!.request("/api/projects/p_missing/changes"),
      harness!.request("/api/projects/p_missing/changes/evt:none:1"),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.json).toMatchObject({ error: { code: "not_found" } });
    }
  });
});
