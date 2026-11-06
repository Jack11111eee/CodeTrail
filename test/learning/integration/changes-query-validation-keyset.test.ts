import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ChangeDetailView,
  ChangeListView,
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
 * Merge boundary: `api/validate.ts` (the one shared query validator) ↔ the
 * changes handler ↔ `ChangesRepo.page`.
 *
 * The routes-changes branch changed the shared `changesListQuery` schema from
 * `nonEmptyString` to `string`, so an empty cursor becomes "first page" and a
 * malformed one reaches the repository's decoder instead of being rejected by
 * the generic Zod funnel. This suite pins the resulting contract at the wire:
 * empty is a page, garbage is `cursor_invalid`, and paging stays project-scoped
 * and stable.
 */

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

function seedProjectWithEvents(name: string, count: number): SeededProject {
  const project = seedProject(server!.repos, server!.clock, name);
  for (let seq = 1; seq <= count; seq += 1) {
    seedEvent(server!.repos, project, {
      seq,
      discoveredAt: `2026-01-01T00:00:0${String(seq)}.000Z`,
    });
  }
  return project;
}

async function list(
  projectId: string,
  query = "",
): Promise<HarnessResponse> {
  return harness!.request(`/api/projects/${projectId}/changes${query}`);
}

async function okList(
  projectId: string,
  query = "",
): Promise<ChangeListView> {
  const response = await list(projectId, query);
  expect(response.status, response.text).toBe(200);
  return response.json as ChangeListView;
}

describe("changes query validation and keyset cursor", () => {
  it("maps an empty cursor to the first page and keeps every event", async () => {
    const project = seedProjectWithEvents("widgets", 5);

    const omitted = await okList(project.projectId);
    const empty = await okList(project.projectId, "?cursor=");

    expect(omitted.items).toHaveLength(5);
    expect(empty.items.map((item) => item.changeId)).toEqual(
      omitted.items.map((item) => item.changeId),
    );
    expect(empty.next).toBeNull();
  });

  it("rejects limit=0 in the handler (a non-null cursor with no item would hide events)", async () => {
    const project = seedProjectWithEvents("widgets", 2);

    const response = await list(project.projectId, "?limit=0");
    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({
      error: { code: "invalid_input", details: { field: "limit" } },
    });
  });

  it.each(["limit=-1", "limit=1.5", "limit=abc", "limit=", "unknown=1"])(
    "rejects invalid query %s through the shared validator",
    async (query) => {
      const project = seedProjectWithEvents("widgets", 2);

      const response = await list(project.projectId, `?${query}`);
      expect(response.status).toBe(400);
      expect(response.json).toMatchObject({ error: { code: "invalid_input" } });
    },
  );

  it.each([
    ["raw garbage", "@@not-a-cursor@@"],
    ["valid base64, wrong shape", Buffer.from('{"d":1}').toString("base64url")],
    ["base64 of null", Buffer.from("null").toString("base64url")],
  ])("rejects a %s cursor with reason cursor_invalid", async (_label, cursor) => {
    const project = seedProjectWithEvents("widgets", 2);

    const response = await list(
      project.projectId,
      `?cursor=${encodeURIComponent(cursor)}`,
    );
    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({
      error: { code: "invalid_input", details: { reason: "cursor_invalid" } },
    });
  });

  it("walks every page exactly once and repeats the same order", async () => {
    const project = seedProjectWithEvents("widgets", 5);

    const walk = async (): Promise<string[]> => {
      const ids: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const query =
          cursor === null
            ? "?limit=2"
            : `?limit=2&cursor=${encodeURIComponent(cursor)}`;
        const body = await okList(project.projectId, query);
        ids.push(...body.items.map((item) => item.changeId));
        cursor = body.next;
        if (cursor === null) return ids;
      }
      throw new Error("pagination did not terminate");
    };

    const first = await walk();
    const second = await walk();

    expect(first).toHaveLength(5);
    expect(new Set(first).size).toBe(5);
    expect(second).toEqual(first);
    // Newest first: discovered_at DESC is the documented stable order.
    expect(first[0]).toBe(eventIdOf(project.projectId, 5));
    expect(first[4]).toBe(eventIdOf(project.projectId, 1));
  });

  it("never leaks another project's events through a foreign cursor", async () => {
    const alpha = seedProjectWithEvents("alpha", 4);
    const beta = seedProjectWithEvents("beta", 2);

    const alphaFirst = await okList(alpha.projectId, "?limit=2");
    expect(alphaFirst.next).not.toBeNull();

    const betaPage = await okList(
      beta.projectId,
      `?limit=20&cursor=${encodeURIComponent(alphaFirst.next!)}`,
    );
    const betaIds = new Set(betaPage.items.map((item) => item.changeId));
    const expectedBeta = new Set([
      eventIdOf(beta.projectId, 2),
      eventIdOf(beta.projectId, 1),
    ]);
    expect(betaIds).toEqual(expectedBeta);
    for (const event of [1, 2, 3, 4].map((seq) =>
      eventIdOf(alpha.projectId, seq),
    )) {
      expect(betaIds.has(event)).toBe(false);
    }

    // And the alpha cursor is still valid for alpha.
    const alphaSecond = await okList(
      alpha.projectId,
      `?limit=20&cursor=${encodeURIComponent(alphaFirst.next!)}`,
    );
    expect(alphaSecond.items.map((item) => item.changeId)).toEqual([
      eventIdOf(alpha.projectId, 2),
      eventIdOf(alpha.projectId, 1),
    ]);
  });

  it("answers a cross-project change id with 404 and no existence leak", async () => {
    const alpha = seedProjectWithEvents("alpha", 1);
    const beta = seedProjectWithEvents("beta", 1);
    const alphaEvent = eventIdOf(alpha.projectId, 1);

    const crossResponse = await harness!.request(
      `/api/projects/${beta.projectId}/changes/${alphaEvent}`,
    );
    expect(crossResponse.status).toBe(404);
    expect(crossResponse.json).toMatchObject({ error: { code: "not_found" } });
    expect(crossResponse.text).not.toContain("提交");
    expect(crossResponse.text).not.toContain("head-1");

    const ownResponse = await harness!.request(
      `/api/projects/${alpha.projectId}/changes/${alphaEvent}`,
    );
    expect(ownResponse.status).toBe(200);
    const detail = ownResponse.json as ChangeDetailView;
    expect(detail.change.changeId).toBe(alphaEvent);
    // The detail is reachable even without a published lesson.
    expect(detail.lesson).toBeNull();
  });
});
