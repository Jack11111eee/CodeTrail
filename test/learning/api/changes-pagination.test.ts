import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ROUTES } from "../../../src/learning/api/router.ts";
import { changesRoutes } from "../../../src/learning/api/routes/changes.ts";
import { knowledgePath } from "../../../src/learning/config/paths.ts";
import {
  changeEventIdFromKey,
  generationIdFromCacheKey,
  jobIdFromDedupeKey,
  repoIdFromIdentity,
} from "../../../src/learning/contracts/index.ts";
import type {
  ChangeDetailView,
  ChangeEventId,
  ChangeEventState,
  ChangeLesson,
  ChangeListView,
  ChangeRecord,
  GenerationId,
  JobId,
  ProjectId,
  RepoId,
  Significance,
} from "../../../src/learning/contracts/index.ts";
import { normalizeScope } from "../../../src/learning/projects/index.ts";
import { startHarness } from "../helpers/http-client.ts";
import type { Harness, HarnessResponse } from "../helpers/http-client.ts";
import { startRoutesServer } from "../helpers/routes-server.ts";
import type { RoutesServer } from "../helpers/routes-server.ts";

/**
 * AC-API-10: the change inbox pages with an opaque keyset cursor. Walking every
 * page at `limit=1` must return each event exactly once, in one stable order,
 * and an undecodable cursor is `400 invalid_input` with
 * `details.reason="cursor_invalid"`.
 *
 * The seed mixes `state` and `significance` and gives several events the same
 * `discoveredAt`, so the `(discovered_at, event_id)` tie-break is exercised;
 * nothing may be filtered out. Removal is asserted on all three routes (410
 * `source_removed`, reason `project_removed`), and the detail view is checked
 * for the six change-lesson fields plus a non-GitHub commit reference.
 */

let server: RoutesServer | null = null;
let harness: Harness | null = null;

interface SeededProject {
  projectId: ProjectId;
  repoId: RepoId;
}

function seedProject(name: string): SeededProject {
  const repoId = repoIdFromIdentity(`github:acme/${name}`);
  server!.repos.repos.upsert({
    repoId,
    identity: `github:acme/${name}`,
    kind: "github",
    mirrorPath: `/tmp/${name}.git`,
    remoteUrl: `https://github.com/acme/${name}.git`,
    createdAt: server!.clock.now().toISOString(),
  });
  const projectId = `p_${name}` as ProjectId;
  server!.repos.projects.insert({
    projectId,
    repoId,
    kind: "github",
    displayName: name,
    remoteUrl: `https://github.com/acme/${name}.git`,
    defaultBranch: "main",
    scope: normalizeScope(),
    watchEnabled: false,
    createdAt: server!.clock.now().toISOString(),
    deletedAt: null,
  });
  return { projectId, repoId };
}

interface SeedEventOptions {
  seq: number;
  discoveredAt?: string;
  state?: ChangeEventState;
  significance?: Significance;
  kind?: ChangeRecord["kind"];
  gapReason?: string | null;
  jobId?: JobId | null;
}

function eventIdOf(projectId: ProjectId, seq: number): ChangeEventId {
  return changeEventIdFromKey(`evt:${projectId}:${String(seq)}`);
}

function seedEvent(
  project: SeededProject,
  options: SeedEventOptions,
): ChangeRecord {
  const eventId = eventIdOf(project.projectId, options.seq);
  const record: ChangeRecord = {
    eventId,
    eventKey: `evt:${project.projectId}:${String(options.seq)}`,
    repoId: project.repoId,
    projectId: project.projectId,
    streamId: `default_branch:${project.repoId}`,
    streamKind: "default_branch",
    kind: options.kind ?? "commit",
    baseSha: `base-${String(options.seq)}`,
    headSha: `head-${String(options.seq)}`,
    mergeBaseSha: null,
    baseContextSha: null,
    significance: options.significance ?? "full",
    state: options.state ?? "discovered",
    jobId: options.jobId ?? null,
    gapReason: options.gapReason ?? null,
    linkedEventId: null,
    linkRelation: null,
    discoveredAt: options.discoveredAt ?? "2026-01-01T00:00:00.000Z",
    publishedAt: null,
    payload: { commit: { firstParent: null, associatedCommits: [] } },
  };
  server!.repos.changes.insertMany([record]);
  return record;
}

function changeLesson(
  generationId: GenerationId,
  eventId: ChangeEventId,
): ChangeLesson {
  return {
    lessonId: `l_${generationId}` as ChangeLesson["lessonId"],
    generationId,
    kind: "change",
    eventId,
    context: {
      repoId: "r_seed",
      commitSha: "head-1",
      generationId,
      scenarioId: "sc_change",
      moduleIds: ["src"],
    },
    scenario: {
      id: "sc_change",
      kind: "library_interface",
      inputs: [],
      userAction: "调用",
      observableResult: "返回",
      isExample: true,
    },
    overview: [],
    plainExplanation: [],
    technicalExplanation: [],
    choices: [],
    choicesOmittedReason: null,
    boundaries: [],
    statements: [],
    evidence: [],
    diagram: {
      kind: "component",
      mermaid: "flowchart LR",
      nodes: [],
      edges: [],
    },
    coverageGaps: [],
    checks: { structural: "pass", evidence: "pass", semantic: "pass" },
    behaviorChange: { before: "旧行为", after: "新行为" },
    affectedModules: [{ moduleId: "src", effect: "改变导出值" }],
    keyTechnologies: ["TypeScript"],
    alternatives: [],
    unverifiedEffects: ["运行时行为未经测试"],
    omittedReasons: {},
  } as unknown as ChangeLesson;
}

/** Writes a published change generation plus its lesson and links `jobId`. */
async function seedChangeGeneration(
  project: SeededProject,
  event: ChangeRecord,
): Promise<{ generationId: GenerationId; jobId: JobId }> {
  const generationId = generationIdFromCacheKey(`cache:${event.eventKey}`);
  const jobId = jobIdFromDedupeKey(`dedupe:${event.eventKey}`);
  const at = server!.clock.now().toISOString();

  const knowledgeDir = knowledgePath(server!.paths, generationId);
  await mkdir(path.join(knowledgeDir, "lessons"), { recursive: true });
  const lesson = changeLesson(generationId, event.eventId);
  await writeFile(
    path.join(knowledgeDir, "lessons", `${lesson.lessonId}.json`),
    `${JSON.stringify(lesson, null, 2)}\n`,
    "utf8",
  );

  server!.repos.jobs.insert({
    jobId,
    dedupeKey: `dedupe:${event.eventKey}`,
    kind: "change_analysis",
    repoId: project.repoId,
    projectId: project.projectId,
    streamId: event.streamId,
    state: "completed",
    payload: {
      kind: "change",
      eventId: event.eventId,
      baseSha: event.baseSha ?? "base",
      headSha: event.headSha ?? "head",
      mergeBaseSha: event.mergeBaseSha ?? "base",
      streamKind: event.streamKind,
    },
    attempt: 0,
    errorCode: null,
    errorDetail: null,
    progress: null,
    outputGenerationId: generationId,
    createdAt: at,
    startedAt: at,
    finishedAt: at,
  });

  server!.repos.generations.insertPublished({
    generationId,
    cacheKey: `cache:${event.eventKey}`,
    repoId: project.repoId,
    projectId: project.projectId,
    commitSha: event.headSha ?? "head",
    comparisonBaseSha: null,
    kind: "change",
    scopeHash: "scope:seed",
    configHash: "config:seed",
    promptTemplateVersion: "prompt",
    preferencesVersion: 1,
    upstreamVersion: "upstream",
    status: "published",
    contentDir: knowledgeDir,
    sealedTreeHash: "sha256:tree",
    baselineFromGenerationId: null,
    fallbackReason: null,
    jobId,
    createdAt: at,
    publishedAt: at,
  });

  server!.repos.lessons.insertMany([
    {
      lessonId: lesson.lessonId,
      generationId,
      kind: "change",
      title: "变更讲解",
      relPath: `lessons/${lesson.lessonId}.json`,
      jsonSha256: "sha256:lesson",
      publishedAt: at,
    },
  ]);

  // Persist the job id on the event so the route can reach the generation.
  server!.repos.changes.setState(event.eventId, "published", {
    jobId,
    publishedAt: at,
  });
  return { generationId, jobId };
}

function jsonOf<T>(response: HarnessResponse, status = 200): T {
  expect(response.status).toBe(status);
  return response.json as T;
}

async function walkAllPages(
  projectId: ProjectId,
  limit: number,
): Promise<{ ids: string[]; states: string[] }> {
  const ids: string[] = [];
  const states: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 500; page += 1) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor !== null) query.set("cursor", cursor);
    const body = jsonOf<ChangeListView>(
      await harness!.request(
        `/api/projects/${projectId}/changes?${query.toString()}`,
      ),
    );
    for (const item of body.items) {
      ids.push(item.changeId);
      states.push(item.state);
    }
    cursor = body.next;
    if (cursor === null) return { ids, states };
  }
  throw new Error("pagination did not terminate");
}

beforeEach(async () => {
  server = await startRoutesServer([changesRoutes]);
  harness = await startHarness({ start: () => server! });
});

afterEach(async () => {
  await harness?.close();
  harness = null;
  server = null;
});

describe("GET /api/projects/:id/changes (AC-API-10)", () => {
  it("returns every event exactly once over a full limit=1 walk", async () => {
    const project = seedProject("widgets");
    const seeded: ChangeRecord[] = [
      seedEvent(project, {
        seq: 1,
        discoveredAt: "2026-01-01T00:00:01.000Z",
        state: "published",
      }),
      seedEvent(project, {
        seq: 2,
        discoveredAt: "2026-01-01T00:00:02.000Z",
        state: "failed",
        significance: "short",
      }),
      seedEvent(project, {
        seq: 3,
        discoveredAt: "2026-01-01T00:00:02.000Z",
        state: "gap",
        kind: "history_gap",
        gapReason: "history_gap",
      }),
      seedEvent(project, {
        seq: 4,
        discoveredAt: "2026-01-01T00:00:02.000Z",
        state: "discovered",
      }),
      seedEvent(project, {
        seq: 5,
        discoveredAt: "2026-01-01T00:00:03.000Z",
        state: "queued",
        significance: "short",
      }),
      seedEvent(project, {
        seq: 6,
        discoveredAt: "2026-01-01T00:00:04.000Z",
        state: "cancelled",
      }),
      seedEvent(project, {
        seq: 7,
        discoveredAt: "2026-01-01T00:00:05.000Z",
        state: "analyzing",
      }),
    ];

    const first = await walkAllPages(project.projectId, 1);

    expect(first.ids).toHaveLength(seeded.length);
    expect(new Set(first.ids).size).toBe(seeded.length);
    expect(new Set(first.ids)).toEqual(
      new Set(seeded.map((event) => event.eventId)),
    );
    // No state or significance is filtered out.
    expect(new Set(first.states)).toEqual(
      new Set([
        "published",
        "failed",
        "gap",
        "discovered",
        "queued",
        "cancelled",
        "analyzing",
      ]),
    );

    const second = await walkAllPages(project.projectId, 1);
    expect(second.ids).toEqual(first.ids);
  });

  it("has the same items and order at limit=1 and limit=3", async () => {
    const project = seedProject("widgets");
    for (let seq = 1; seq <= 5; seq += 1) {
      seedEvent(project, {
        seq,
        discoveredAt: `2026-01-01T00:00:0${String(seq)}.000Z`,
      });
    }

    const one = await walkAllPages(project.projectId, 1);
    const three = await walkAllPages(project.projectId, 3);
    expect(three.ids).toEqual(one.ids);
  });

  it("returns an empty page with next=null for an empty inbox", async () => {
    const project = seedProject("empty");
    const body = jsonOf<ChangeListView>(
      await harness!.request(`/api/projects/${project.projectId}/changes`),
    );
    expect(body.items).toEqual([]);
    expect(body.next).toBeNull();
  });

  it("rejects an undecodable cursor with reason cursor_invalid", async () => {
    const project = seedProject("widgets");
    seedEvent(project, { seq: 1 });

    const response = await harness!.request(
      `/api/projects/${project.projectId}/changes?cursor=${encodeURIComponent("@@not-a-cursor@@")}`,
    );
    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({
      error: {
        code: "invalid_input",
        details: { reason: "cursor_invalid" },
      },
    });
  });

  it("treats an empty cursor as the first page", async () => {
    const project = seedProject("widgets");
    seedEvent(project, { seq: 1 });
    const body = jsonOf<ChangeListView>(
      await harness!.request(
        `/api/projects/${project.projectId}/changes?cursor=`,
      ),
    );
    expect(body.items).toHaveLength(1);
  });

  it("never leaks another project's events through a foreign cursor", async () => {
    const mine = seedProject("mine");
    const theirs = seedProject("theirs");
    for (let seq = 1; seq <= 3; seq += 1) {
      seedEvent(mine, {
        seq,
        discoveredAt: `2026-01-01T00:00:0${String(seq)}.000Z`,
      });
    }
    for (let seq = 10; seq <= 12; seq += 1) {
      seedEvent(theirs, {
        seq,
        discoveredAt: `2026-01-01T00:00:0${String(seq - 9)}.000Z`,
      });
    }

    const foreign = jsonOf<ChangeListView>(
      await harness!.request(
        `/api/projects/${theirs.projectId}/changes?limit=1`,
      ),
    );
    expect(foreign.next).not.toBeNull();

    const response = jsonOf<ChangeListView>(
      await harness!.request(
        `/api/projects/${mine.projectId}/changes?limit=10&cursor=${encodeURIComponent(foreign.next ?? "")}`,
      ),
    );
    const mineIds = new Set((await walkAllPages(mine.projectId, 10)).ids);
    for (const item of response.items)
      expect(mineIds.has(item.changeId)).toBe(true);
  });

  it("refuses limit=0 and a negative limit", async () => {
    const project = seedProject("widgets");
    seedEvent(project, { seq: 1 });

    const zero = await harness!.request(
      `/api/projects/${project.projectId}/changes?limit=0`,
    );
    expect(zero.status).toBe(400);
    expect(zero.json).toMatchObject({ error: { code: "invalid_input" } });

    const negative = await harness!.request(
      `/api/projects/${project.projectId}/changes?limit=-1`,
    );
    expect(negative.status).toBe(400);
    expect(negative.json).toMatchObject({ error: { code: "invalid_input" } });
  });

  it("clamps an oversized limit to the page maximum", async () => {
    const project = seedProject("widgets");
    seedEvent(project, { seq: 1 });
    const body = jsonOf<ChangeListView>(
      await harness!.request(
        `/api/projects/${project.projectId}/changes?limit=100000`,
      ),
    );
    expect(body.items).toHaveLength(1);
    expect(body.next).toBeNull();
  });

  it("answers 410 project_removed for a removed project", async () => {
    const project = seedProject("removed");
    const event = seedEvent(project, { seq: 1 });
    server!.repos.projects.markDeleted(
      project.projectId,
      server!.clock.now().toISOString(),
    );

    for (const response of [
      await harness!.request(`/api/projects/${project.projectId}/changes`),
      await harness!.request(
        `/api/projects/${project.projectId}/changes/${event.eventId}`,
      ),
      await harness!.request(`/api/projects/${project.projectId}/watch`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
    ]) {
      expect(response.status).toBe(410);
      expect(response.json).toMatchObject({
        error: {
          code: "source_removed",
          details: { reason: "project_removed" },
        },
      });
    }
  });

  it("answers 404 for an unknown project", async () => {
    const response = await harness!.request("/api/projects/nope/changes");
    expect(response.status).toBe(404);
    expect(response.json).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("GET /api/projects/:id/changes/:changeId", () => {
  it("returns the full detail: payload, six record fields and a commit ref", async () => {
    const project = seedProject("widgets");
    const event = seedEvent(project, {
      seq: 1,
      state: "published",
      discoveredAt: "2026-01-01T00:00:01.000Z",
    });
    await seedChangeGeneration(project, event);

    const body = jsonOf<ChangeDetailView>(
      await harness!.request(
        `/api/projects/${project.projectId}/changes/${event.eventId}`,
      ),
    );

    expect(body.change.changeId).toBe(event.eventId);
    expect(body.change.state).toBe("published");
    expect(body.payload).toMatchObject({
      commit: { firstParent: null, associatedCommits: [] },
    });
    expect(body.lesson).not.toBeNull();
    expect(body.lesson?.kind).toBe("change");
    expect(body.lesson?.behaviorChange).toEqual({
      before: "旧行为",
      after: "新行为",
    });
    expect(body.lesson?.affectedModules).toEqual([
      { moduleId: "src", effect: "改变导出值" },
    ]);
    expect(body.lesson?.keyTechnologies).toEqual(["TypeScript"]);
    expect(body.lesson?.alternatives).toEqual([]);
    expect(body.lesson?.evidence).toEqual([]);
    expect(body.lesson?.unverifiedEffects).toEqual(["运行时行为未经测试"]);

    // Display-only: the commit is a short sha and a label, never a URL.
    expect(body.commitRef).toEqual({
      sha: event.headSha,
      label: `提交 ${event.headSha?.slice(0, 12) ?? ""}`,
    });
    expect(JSON.stringify(body.commitRef)).not.toMatch(/github|https?:/iu);
  });

  it("serves the event with lesson=null when no lesson was published", async () => {
    const project = seedProject("widgets");
    const event = seedEvent(project, { seq: 1 });
    const body = jsonOf<ChangeDetailView>(
      await harness!.request(
        `/api/projects/${project.projectId}/changes/${event.eventId}`,
      ),
    );
    expect(body.change.changeId).toBe(event.eventId);
    expect(body.lesson).toBeNull();
  });

  it("answers 404 for an unknown change id", async () => {
    const project = seedProject("widgets");
    const response = await harness!.request(
      `/api/projects/${project.projectId}/changes/${changeEventIdFromKey("nope")}`,
    );
    expect(response.status).toBe(404);
    expect(response.json).toMatchObject({ error: { code: "not_found" } });
  });

  it("answers 404 when the change belongs to another project", async () => {
    const mine = seedProject("mine");
    const theirs = seedProject("theirs");
    const event = seedEvent(theirs, { seq: 1 });

    const response = await harness!.request(
      `/api/projects/${mine.projectId}/changes/${event.eventId}`,
    );
    expect(response.status).toBe(404);
    expect(response.json).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("module registration", () => {
  it("registers under the frozen table without editing it", () => {
    expect(changesRoutes.id).toBe("changes");
    const mine = changesRoutes.routes.map(
      (route) => `${route.method} ${route.pattern} ${route.handler}`,
    );
    const frozen = ROUTES.filter((route) =>
      ["watch.put", "changes.list", "changes.get"].includes(route.handler),
    ).map((route) => `${route.method} ${route.pattern} ${route.handler}`);
    expect(mine).toEqual(frozen);
    expect(ROUTES).toHaveLength(40);
  });
});
