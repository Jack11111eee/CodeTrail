import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ChangeDetailView,
  ChangeLesson,
} from "../../../src/learning/contracts/index.ts";
import { startHarness } from "../helpers/http-client.ts";
import type { Harness } from "../helpers/http-client.ts";
import {
  changeLesson,
  seedChangeGeneration,
  seedEvent,
  seedProject,
  startChangesServer,
} from "./merged-changes-harness.ts";
import type { ChangesHarness } from "./merged-changes-harness.ts";

/**
 * Merge boundary: `GET /api/projects/:id/changes/:changeId` ↔ the generation /
 * lesson store ↔ the sealed knowledge directory.
 *
 * `changes.ts` resolves the six-field change lesson through three documented
 * hops (`change_events.job_id → jobs.output_generation_id`, then
 * `generations.job_id`, then a published change generation for the same head
 * commit) and a merge-link hop. It must degrade to `lesson: null` — never a
 * 500 — when a row, file or path is wrong, and it must never read outside the
 * generation's knowledge directory.
 */

const SIX_FIELDS = [
  "behaviorChange",
  "affectedModules",
  "keyTechnologies",
  "alternatives",
  "unverifiedEffects",
  "evidence",
] as const;

let server: ChangesHarness | null = null;
let harness: Harness | null = null;

beforeEach(async () => {
  server = await startChangesServer();
  harness = await startHarness({ start: () => server! });
});

afterEach(async () => {
  await harness?.close();
  harness = null;
  await server?.close();
  server = null;
});

async function detail(
  projectId: string,
  eventId: string,
): Promise<ChangeDetailView> {
  const response = await harness!.request(
    `/api/projects/${projectId}/changes/${eventId}`,
  );
  expect(response.status, response.text).toBe(200);
  return response.json as ChangeDetailView;
}

describe("change detail resolves the change lesson through the store", () => {
  it("returns the six-field lesson, the payload and a display-only commit ref", async () => {
    const project = seedProject(server!.repos, server!.clock, "acme");
    const event = seedEvent(server!.repos, project, {
      seq: 1,
      state: "published",
      headSha: "abcdef1234567890",
      payload: {
        commit: {
          firstParent: "parent000001",
          associatedCommits: ["side0001"],
        },
      },
    });
    await seedChangeGeneration(server!, project, event);

    const response = await harness!.request(
      `/api/projects/${project.projectId}/changes/${event.eventId}`,
    );
    expect(response.status).toBe(200);
    const view = response.json as ChangeDetailView;

    expect(view.lesson).not.toBeNull();
    for (const field of SIX_FIELDS) {
      expect(view.lesson).toHaveProperty(field);
    }
    expect(view.lesson!.generationId).toBeDefined();
    expect(view.payload.commit?.firstParent).toBe("parent000001");
    expect(view.payload.commit?.associatedCommits).toEqual(["side0001"]);
    expect(view.commitRef).toEqual({
      sha: "abcdef1234567890",
      label: "提交 abcdef123456",
    });

    // A display record only: no GitHub write/comment URL may appear.
    expect(response.text).not.toContain("github.com");
    expect(response.text).not.toContain("http://");
    expect(response.text).not.toContain("https://");
  });

  it("falls back to generations.job_id when the job row is gone", async () => {
    const project = seedProject(server!.repos, server!.clock, "acme");
    const event = seedEvent(server!.repos, project, { seq: 1 });
    await seedChangeGeneration(server!, project, event, { skipJob: true });

    const view = await detail(project.projectId, event.eventId);
    expect(view.lesson).not.toBeNull();
    expect(view.lesson!.kind).toBe("change");
  });

  it("falls back to a published change generation for the same head commit", async () => {
    const project = seedProject(server!.repos, server!.clock, "acme");
    const event = seedEvent(server!.repos, project, {
      seq: 1,
      headSha: "commit-fallback-1",
    });
    await seedChangeGeneration(server!, project, event);
    // Detach the event from its job: only the commit fallback can find it.
    server!.repos.changes.setState(event.eventId, "published", {
      jobId: null,
      publishedAt: server!.clock.now().toISOString(),
    });

    const view = await detail(project.projectId, event.eventId);
    expect(view.lesson).not.toBeNull();
  });

  it("does not use a staged generation as the commit fallback", async () => {
    const project = seedProject(server!.repos, server!.clock, "acme");
    const event = seedEvent(server!.repos, project, {
      seq: 1,
      headSha: "staged-commit-1",
    });
    await seedChangeGeneration(server!, project, event, { status: "staged" });
    server!.repos.changes.setState(event.eventId, "discovered", {
      jobId: null,
    });

    const view = await detail(project.projectId, event.eventId);
    expect(view.lesson).toBeNull();
    // The event itself is still served.
    expect(view.change.changeId).toBe(event.eventId);
  });

  it("degrades a malformed lesson file to lesson:null instead of a 500", async () => {
    const project = seedProject(server!.repos, server!.clock, "acme");
    const event = seedEvent(server!.repos, project, { seq: 1 });
    await seedChangeGeneration(server!, project, event, {
      fileContents: "{ this is not json",
    });

    const view = await detail(project.projectId, event.eventId);
    expect(view.lesson).toBeNull();
    expect(view.change.changeId).toBe(event.eventId);
  });

  it("rejects a lesson file whose kind is not change", async () => {
    const project = seedProject(server!.repos, server!.clock, "acme");
    const event = seedEvent(server!.repos, project, { seq: 1 });
    const wrongKind = changeLesson(
      `g_${event.eventId}` as ChangeLesson["generationId"],
      event.eventId,
      { kind: "research" as ChangeLesson["kind"] },
    );
    await seedChangeGeneration(server!, project, event, { lesson: wrongKind });

    const view = await detail(project.projectId, event.eventId);
    expect(view.lesson).toBeNull();
  });

  it("refuses a lesson relPath that escapes the knowledge directory", async () => {
    const project = seedProject(server!.repos, server!.clock, "acme");
    const event = seedEvent(server!.repos, project, { seq: 1 });
    // The hostile file is written *outside* the generation root. If safeJoin
    // were missing, the route would serve it.
    await seedChangeGeneration(server!, project, event, {
      relPath: "../../outside/evil.json",
    });

    const view = await detail(project.projectId, event.eventId);
    expect(view.lesson).toBeNull();
  });

  it("follows one merge link so a PR event can surface the main-branch lesson", async () => {
    const project = seedProject(server!.repos, server!.clock, "acme");
    const mainEvent = seedEvent(server!.repos, project, {
      seq: 1,
      headSha: "main-head-0001",
    });
    const { generationId } = await seedChangeGeneration(
      server!,
      project,
      mainEvent,
    );
    const prEvent = seedEvent(server!.repos, project, {
      seq: 2,
      headSha: "pr-head-000001",
      kind: "pull_request",
      linkedEventId: mainEvent.eventId,
      payload: {
        pr: {
          number: 9,
          state: "open",
          merged: false,
          title: "PR 标题",
          headSha: "pr-head-000001",
          baseHeadSha: "main-head-0001",
          mergeBaseSha: "merge-base-01",
          updatedAt: "2026-01-01T00:00:00.000Z",
          branch: "fix/x",
          baseBranch: "main",
        },
        linkage: { status: "linked", relation: "identical_content" },
      },
    });

    const view = await detail(project.projectId, prEvent.eventId);
    expect(view.lesson).not.toBeNull();
    expect(view.lesson!.generationId).toBe(generationId);
    expect(view.change.linkedChangeId).toBe(mainEvent.eventId);
  });
});
