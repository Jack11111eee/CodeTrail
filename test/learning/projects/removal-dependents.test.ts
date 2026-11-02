import fs from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertProjectActive,
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
