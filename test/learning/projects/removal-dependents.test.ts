import fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertProjectActive,
  newConversationId,
  newMessageId,
  type CreateAnalysisResponse,
  type CreateProjectResponse,
  type ProjectId,
} from "../../../src/learning/contracts/index.ts";
import {
  knowledgePath,
  mirrorPath,
} from "../../../src/learning/config/paths.ts";
import {
  createRemovalService,
  type RemovalService,
} from "../../../src/learning/projects/removal.ts";
import { fixturePath } from "../helpers/git-fixture.ts";
import { citationAvailability } from "../../../src/learning/api/routes/generations.ts";
import {
  errorCode,
  httpRequest,
  jsonBody,
  type StubResponse,
} from "../helpers/stub-server.ts";
import {
  makeChange,
  makeGeneration,
  makeLesson,
  makeSource,
} from "../store/helpers.ts";
import {
  createHarness,
  seedProject,
  seedRepo,
  thrownBy,
  type ProjectsHarness,
} from "./harness.ts";
import { startRoutesHarness, type RoutesHarness } from "./routes-harness.ts";

/**
 * AC-PRJ-14 (service half): dependents enumerate every artifact, an
 * unconfirmed removal writes nothing, and a confirmed one writes only
 * `deleted_at` and `watch_enabled = 0` in one transaction while retaining
 * every row and every knowledge directory.
 */
describe("project removal and dependents", () => {
  let harness: ProjectsHarness | undefined;

  afterEach(() => {
    harness?.close();
    harness = undefined;
  });

  function seedArtifacts(h: ProjectsHarness) {
    const repo = seedRepo(h, { identity: "local:/tmp/removal-repo" });
    const project = seedProject(h, { repoId: repo.repoId, watchEnabled: true });

    h.repos.generations.insertPublished(
      makeGeneration({
        generationId: "g_1",
        cacheKey: "ck_1",
        projectId: project.projectId,
        repoId: repo.repoId,
      }),
    );
    h.repos.generations.insertPublished(
      makeGeneration({
        generationId: "g_2",
        cacheKey: "ck_2",
        projectId: project.projectId,
        repoId: repo.repoId,
      }),
    );
    h.repos.lessons.insertMany([
      makeLesson({ lessonId: "l_1", generationId: "g_1" }),
      makeLesson({ lessonId: "l_2", generationId: "g_1" }),
      makeLesson({ lessonId: "l_3", generationId: "g_2" }),
    ]);
    h.repos.sources.insertMany([
      makeSource({ generationId: "g_1", sourceId: "s_1" }),
      makeSource({ generationId: "g_2", sourceId: "s_2" }),
    ]);
    h.repos.conversations.insert({
      conversationId: "c_1",
      generationIds: ["g_1"],
      at: h.clock.now().toISOString(),
    });
    h.repos.conversations.insert({
      conversationId: "c_2",
      generationIds: ["g_2"],
      at: h.clock.now().toISOString(),
    });
    h.repos.changes.insertMany([
      makeChange({
        eventId: "e_1",
        projectId: project.projectId,
        repoId: repo.repoId,
      }),
    ]);

    // Files on disk that removal must keep.
    const knowledgeDir = knowledgePath(h.paths, "g_1");
    fs.mkdirSync(knowledgeDir, { recursive: true });
    fs.writeFileSync(`${knowledgeDir}/lesson.json`, "{}\n");
    fs.mkdirSync(mirrorPath(h.paths, repo.repoId), { recursive: true });
    fs.mkdirSync(`${h.paths.work}/${repo.repoId}/sha`, { recursive: true });

    return { repo, project, knowledgeDir };
  }

  it("lists dependents, requires confirmation and keeps every artifact", async () => {
    harness = await createHarness();
    const { repo, project, knowledgeDir } = seedArtifacts(harness);
    const service: RemovalService = createRemovalService({
      db: harness.db,
      repos: harness.repos,
      clock: harness.clock,
    });

    expect(await service.dependents(project.projectId)).toEqual({
      conversations: ["c_1", "c_2"],
      lessons: ["l_1", "l_2", "l_3"],
      generations: ["g_1", "g_2"],
      changeEvents: ["e_1"],
    });
    expect(service.state(project.projectId)).toBe("active");
    expect(() =>
      assertProjectActive("active", project.projectId),
    ).not.toThrow();

    // Without confirmation nothing at all is written.
    await expect(
      service.remove(project.projectId, false),
    ).rejects.toMatchObject({
      code: "invalid_input",
      details: { reason: "confirm_required" },
    });
    const untouched = harness.repos.projects.byId(project.projectId);
    expect(untouched).toEqual(project);

    // With confirmation exactly two columns change.
    const dependents = await service.remove(project.projectId, true);
    expect(dependents).toEqual({
      conversations: ["c_1", "c_2"],
      lessons: ["l_1", "l_2", "l_3"],
      generations: ["g_1", "g_2"],
      changeEvents: ["e_1"],
    });

    const after = harness.repos.projects.byId(project.projectId);
    expect(after).not.toBeNull();
    expect(after?.deletedAt).toBe(harness.clock.now().toISOString());
    expect(after?.watchEnabled).toBe(false);
    expect({ ...after, deletedAt: null, watchEnabled: true }).toEqual(project);

    // Every artifact row survives.
    expect(
      harness.repos.generations.listByProject(project.projectId),
    ).toHaveLength(2);
    expect(harness.repos.lessons.listByGeneration("g_1")).toHaveLength(2);
    expect(harness.repos.sources.all("g_1")).toHaveLength(1);
    expect(harness.repos.conversations.byId("c_1")).not.toBeNull();
    expect(harness.repos.changes.byId("e_1")).not.toBeNull();
    expect(fs.existsSync(knowledgeDir)).toBe(true);
    expect(fs.existsSync(mirrorPath(harness.paths, repo.repoId))).toBe(true);
    expect(fs.existsSync(`${harness.paths.work}/${repo.repoId}/sha`)).toBe(
      true,
    );

    // State transitions and the shared guard.
    expect(service.state(project.projectId)).toBe("removed");
    const removedError = thrownBy(() =>
      assertProjectActive("removed", project.projectId),
    );
    expect(removedError.code).toBe("source_removed");
    expect(removedError.details?.reason).toBe("project_removed");
    expect(() => assertProjectActive("unknown", project.projectId)).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(service.state("p_never-existed" as ProjectId)).toBe("unknown");
    await expect(
      service.dependents("p_never-existed" as ProjectId),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(service.remove(project.projectId, true)).rejects.toMatchObject(
      {
        code: "source_removed",
        details: { reason: "project_removed" },
      },
    );
  });

  it("removes a project with zero dependents", async () => {
    harness = await createHarness();
    const repo = seedRepo(harness, { identity: "local:/tmp/empty-repo" });
    const project = seedProject(harness, { repoId: repo.repoId });
    const service = createRemovalService({
      db: harness.db,
      repos: harness.repos,
      clock: harness.clock,
    });

    expect(await service.dependents(project.projectId)).toEqual({
      conversations: [],
      lessons: [],
      generations: [],
      changeEvents: [],
    });
    expect(await service.remove(project.projectId, true)).toEqual({
      conversations: [],
      lessons: [],
      generations: [],
      changeEvents: [],
    });
    expect(
      harness.repos.projects.byId(project.projectId)?.deletedAt,
    ).not.toBeNull();
  });

  it("rolls both columns back when the second write fails", async () => {
    harness = await createHarness();
    const repo = seedRepo(harness, { identity: "local:/tmp/atomic-repo" });
    const project = seedProject(harness, {
      repoId: repo.repoId,
      watchEnabled: true,
    });
    const service = createRemovalService({
      db: harness.db,
      repos: harness.repos,
      clock: harness.clock,
    });

    // Fail the `watch_enabled` update; the `deleted_at` write must roll back.
    harness.db.raw.exec(
      `CREATE TRIGGER block_watch BEFORE UPDATE OF watch_enabled ON projects
       WHEN NEW.watch_enabled = 0
       BEGIN SELECT RAISE(ABORT, 'watch write blocked'); END;`,
    );
    await expect(service.remove(project.projectId, true)).rejects.toThrow();
    harness.db.raw.exec("DROP TRIGGER block_watch");

    const after = harness.repos.projects.byId(project.projectId);
    expect(after?.deletedAt).toBeNull();
    expect(after?.watchEnabled).toBe(true);
    expect(service.state(project.projectId)).toBe("active");
  });
});

/**
 * AC-PRJ-14 (HTTP half, §5.8 matrix): the same removal over the wire. Every
 * generation-scoped link answers 410 with `reason="project_removed"` and no
 * redirect, while the rows and the conversation history are retained.
 */
describe("removal over HTTP", () => {
  let server: RoutesHarness | undefined;

  beforeEach(async () => {
    server = await startRoutesHarness();
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  function get(path: string): Promise<StubResponse> {
    return httpRequest(server!.port, { path, headers: { ...server!.cookie } });
  }

  function post(path: string, body: unknown): Promise<StubResponse> {
    return httpRequest(server!.port, {
      method: "POST",
      path,
      headers: { ...server!.cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function del(path: string): Promise<StubResponse> {
    return httpRequest(server!.port, {
      method: "DELETE",
      path,
      headers: { ...server!.cookie },
    });
  }

  function reasonOf(response: StubResponse): unknown {
    const body = jsonBody(response) as {
      error?: { details?: { reason?: unknown } };
    };
    return body.error?.details?.reason;
  }

  it("covers every removed-project route row", async () => {
    const created = jsonBody(
      await post("/api/projects", {
        localPath: fixturePath("last-mile-mini"),
      }),
    ) as CreateProjectResponse;
    const analysis = jsonBody(
      await post(`/api/projects/${created.projectId}/analyses`, { ref: "HEAD" }),
    ) as CreateAnalysisResponse;
    await server!.jobRunner.drain();

    const generation = server!.repos.generations.byId(
      analysis.generationId,
    );
    const lesson = server!.repos.lessons.listByGeneration(
      analysis.generationId,
    )[0];
    const source = server!.repos.sources.all(analysis.generationId)[0];
    expect(generation?.status).toBe("published");
    expect(lesson).toBeDefined();
    expect(source).toBeDefined();

    const conversationId = newConversationId();
    const at = server!.clock.now().toISOString();
    server!.repos.conversations.insert({
      conversationId,
      generationIds: [analysis.generationId],
      at,
    });
    server!.repos.conversations.insertMessage({
      messageId: newMessageId(),
      conversationId,
      role: "user",
      content: "旧快照为什么丢了",
      status: "complete",
      answerPhase: "complete",
      citations: [],
      selection: null,
      checks: null,
      unknownReason: null,
      incomplete: false,
      createdAt: at,
    });
    server!.repos.changes.insertMany([
      {
        eventId: "e_http_seed" as never,
        eventKey: "ek_http_seed",
        repoId: created.repoId,
        projectId: created.projectId,
        streamId: "default_branch",
        streamKind: "default_branch",
        kind: "commit",
        baseSha: null,
        headSha: generation!.commitSha,
        mergeBaseSha: null,
        baseContextSha: null,
        significance: "full",
        state: "published",
        jobId: null,
        gapReason: null,
        linkedEventId: null,
        linkRelation: null,
        discoveredAt: at,
        publishedAt: at,
        payload: { commit: { firstParent: null, associatedCommits: [] } },
      },
    ]);

    const dependents = await get(
      `/api/projects/${created.projectId}/dependents`,
    );
    expect(dependents.status).toBe(200);
    const view = jsonBody(dependents) as {
      conversations: { ids: string[]; count: number };
      lessons: { ids: string[]; count: number };
      generations: { ids: string[]; count: number };
      changeEvents: { ids: string[]; count: number };
    };
    expect(view.conversations.ids).toContain(conversationId);
    expect(view.conversations.count).toBe(1);
    expect(view.lessons.ids).toContain(lesson.lessonId);
    expect(view.generations.ids).toContain(analysis.generationId);
    expect(view.changeEvents.ids).toContain("e_http_seed");
    for (const group of [
      view.conversations,
      view.lessons,
      view.generations,
      view.changeEvents,
    ]) {
      expect(group.count).toBe(group.ids.length);
    }

    const refused = await del(`/api/projects/${created.projectId}`);
    expect(refused.status).toBe(400);
    expect(errorCode(refused)).toBe("invalid_input");
    expect(reasonOf(refused)).toBe("confirm_required");

    // `?confirm=false` is not a confirmation either: the schema accepts the
    // string and the removal service refuses it before writing (§5.8).
    const explicitlyFalse = await del(
      `/api/projects/${created.projectId}?confirm=false`,
    );
    expect(explicitlyFalse.status).toBe(400);
    expect(errorCode(explicitlyFalse)).toBe("invalid_input");
    expect(reasonOf(explicitlyFalse)).toBe("confirm_required");
    expect((await get(`/api/projects/${created.projectId}`)).status).toBe(200);

    // A citation is available while the project is live, and marked
    // unavailable after removal — the read-time derivation the conversation
    // routes use (§5.8, AC-R16-02).
    expect(citationAvailability(server!.deps, analysis.generationId)).toBe(
      "available",
    );

    const removed = await del(
      `/api/projects/${created.projectId}?confirm=true`,
    );
    expect(removed.status).toBe(200);
    expect(jsonBody(removed)).toMatchObject({ removed: true });

    expect(citationAvailability(server!.deps, analysis.generationId)).toBe(
      "source_removed",
    );

    for (const path of [
      `/api/projects/${created.projectId}`,
      `/api/projects/${created.projectId}/dependents`,
    ]) {
      const response = await get(path);
      expect(response.status).toBe(410);
      expect(errorCode(response)).toBe("source_removed");
      expect(reasonOf(response)).toBe("project_removed");
      expect(response.headers.location).toBeUndefined();
    }

    for (const submission of [
      await post(`/api/projects/${created.projectId}/analyses`, { ref: "HEAD" }),
      await post(`/api/projects/${created.projectId}/comparisons`, {
        baseSha: "HEAD~1",
        headSha: "HEAD",
      }),
      await del(`/api/projects/${created.projectId}?confirm=true`),
    ]) {
      expect(submission.status).toBe(410);
      expect(reasonOf(submission)).toBe("project_removed");
      expect(submission.headers.location).toBeUndefined();
    }

    const list = jsonBody(await get("/api/projects")) as {
      projects: { projectId: string }[];
    };
    expect(
      list.projects.some((project) => project.projectId === created.projectId),
    ).toBe(false);

    for (const path of [
      `/api/generations/${analysis.generationId}/lessons`,
      `/api/generations/${analysis.generationId}/lessons/${lesson.lessonId}`,
      `/api/generations/${analysis.generationId}/sources/${source.sourceId}`,
      `/api/generations/${analysis.generationId}/coverage`,
    ]) {
      const response = await get(path);
      expect(response.status).toBe(410);
      expect(errorCode(response)).toBe("source_removed");
      expect(reasonOf(response)).toBe("project_removed");
      expect(response.headers.location).toBeUndefined();
    }

    // History is retained: rows survive and the conversation stays readable at
    // the store layer. Its HTTP read/post handlers belong to the conversations
    // route module; this issue owns the removal decision they consume.
    expect(
      server!.repos.generations.byId(analysis.generationId as never),
    ).not.toBeNull();
    expect(
      server!.repos.lessons.byId(
        analysis.generationId as never,
        lesson.lessonId,
      ),
    ).not.toBeNull();
    expect(
      server!.repos.sources.get(
        analysis.generationId as never,
        source.sourceId,
      ),
    ).not.toBeNull();
    expect(server!.repos.conversations.byId(conversationId)).not.toBeNull();
    expect(
      server!.repos.conversations.messages(conversationId).length,
    ).toBe(1);

    // Job routes are not project-scoped in §5.8.
    expect((await get(`/api/jobs/${analysis.jobId}`)).status).toBe(200);
  });

  it("re-importing a removed path creates a new project and never undeletes the old one", async () => {
    const localPath = fixturePath("last-mile-mini");
    const first = jsonBody(
      await post("/api/projects", { localPath }),
    ) as CreateProjectResponse;
    expect(
      (await del(`/api/projects/${first.projectId}?confirm=true`)).status,
    ).toBe(200);

    const second = jsonBody(
      await post("/api/projects", { localPath }),
    ) as CreateProjectResponse;
    expect(second.projectId).not.toBe(first.projectId);
    expect(second.repoId).toBe(first.repoId);

    // The old link stays gone forever; the new project is independent.
    expect((await get(`/api/projects/${first.projectId}`)).status).toBe(410);
    expect((await get(`/api/projects/${second.projectId}`)).status).toBe(200);
    const list = jsonBody(await get("/api/projects")) as {
      projects: { projectId: string }[];
    };
    const ids = list.projects.map((project) => project.projectId);
    expect(ids).not.toContain(first.projectId);
    expect(ids).toContain(second.projectId);
  });
});
