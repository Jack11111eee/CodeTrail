import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ChangeListView,
  ChangeSummary,
} from "../../../src/learning/contracts/index.ts";
import { startHarness } from "../helpers/http-client.ts";
import type { Harness } from "../helpers/http-client.ts";
import {
  seedEvent,
  seedProject,
  startChangesServer,
} from "./merged-changes-harness.ts";
import type {
  ChangesHarness,
  SeededProject,
} from "./merged-changes-harness.ts";

/**
 * Merge boundary: `routes-changes` ↔ the static inbox page.
 *
 * The branch moved `changeTitle`/`toChangeSummary` out of `api/static.ts` and
 * into `api/routes/changes.ts`, and `static.ts` now imports them. That shared
 * projection is the only place where the browser view and the JSON API can
 * drift: both must show the same events, in the same order, with the same
 * titles and the same gap accounting.
 *
 * The suite runs the real server with both surfaces mounted and compares the
 * JSON `GET /api/projects/:id/changes` with the server-rendered `/inbox`.
 */

/** Mirrors `ui/render/markdown.ts#escapeHtml` (quotes stay literal in text). */
function escapeHtml(value: string): string {
  return value
    .replace(/&(?!(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);)/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function itemIds(html: string): string[] {
  return [...html.matchAll(/data-change-id="([^"]*)"/gu)].map((m) => m[1]);
}

function headings(html: string): string[] {
  return [...html.matchAll(/<h2>(.*?)<\/h2>/gu)].map((m) => m[1]);
}

function attribute(html: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]*)"`, "u").exec(html);
  return match === null ? null : match[1];
}

let server: ChangesHarness | null = null;
let harness: Harness | null = null;

beforeEach(async () => {
  server = await startChangesServer({ ui: true });
  harness = await startHarness({ start: () => server! });
});

afterEach(async () => {
  await harness?.close();
  harness = null;
  await server?.close();
  server = null;
});

function seedInbox(project: SeededProject): void {
  // Two pages' worth (23 > the inbox page size of 20) so the shared keyset
  // cursor of the HTML page and the JSON API can be compared as well.
  for (let seq = 1; seq <= 16; seq += 1) {
    seedEvent(server!.repos, project, {
      seq,
      discoveredAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
    });
  }
  seedEvent(server!.repos, project, {
    seq: 17,
    discoveredAt: "2026-01-01T00:00:17.000Z",
    state: "gap",
    headSha: "deadbeef0000",
  });
  seedEvent(server!.repos, project, {
    seq: 18,
    discoveredAt: "2026-01-01T00:00:18.000Z",
    state: "discovered",
    significance: "short",
    headSha: null,
    baseSha: null,
    payload: {},
  });
  seedEvent(server!.repos, project, {
    seq: 19,
    discoveredAt: "2026-01-01T00:00:19.000Z",
    state: "waiting",
    headSha: "abcdef1234567890",
  });
  seedEvent(server!.repos, project, {
    seq: 20,
    discoveredAt: "2026-01-01T00:00:20.000Z",
    state: "published",
    kind: "baseline",
    headSha: "baseline0001",
  });
  seedEvent(server!.repos, project, {
    seq: 21,
    discoveredAt: "2026-01-01T00:00:21.000Z",
    kind: "branch_switch",
    headSha: "switch000001",
  });
  seedEvent(server!.repos, project, {
    seq: 22,
    discoveredAt: "2026-01-01T00:00:22.000Z",
    state: "gap",
    kind: "history_gap",
    headSha: "gap000000001",
  });
  seedEvent(server!.repos, project, {
    seq: 23,
    discoveredAt: "2026-01-01T00:00:23.000Z",
    state: "published",
    kind: "pull_request",
    headSha: null,
    baseSha: null,
    payload: {
      pr: {
        number: 7,
        state: "open",
        merged: false,
        title: '修复 <script>alert("x")</script> & 说明',
        headSha: "prhead000001",
        baseHeadSha: "prbase000001",
        mergeBaseSha: "prmerge00001",
        updatedAt: "2026-01-01T00:00:23.000Z",
        branch: "fix/inbox",
        baseBranch: "main",
      },
    },
  });
}

async function apiPage(projectId: string, query = ""): Promise<ChangeListView> {
  const response = await harness!.request(
    `/api/projects/${projectId}/changes${query}`,
  );
  expect(response.status, response.text).toBe(200);
  return response.json as ChangeListView;
}

describe("static inbox and the changes API share one projection", () => {
  it("renders the same events in the same order with the same titles", async () => {
    const project = seedProject(server!.repos, server!.clock, "widgets");
    seedInbox(project);

    const api = await apiPage(project.projectId, "?limit=20");
    expect(api.items).toHaveLength(20);
    expect(api.next).not.toBeNull();

    const inbox = await harness!.request(`/inbox?project=${project.projectId}`);
    expect(inbox.status).toBe(200);
    expect(inbox.headers.get("content-type")).toContain("text/html");

    expect(itemIds(inbox.text)).toEqual(
      api.items.map((item: ChangeSummary) => item.changeId),
    );

    const renderedHeadings = headings(inbox.text);
    expect(renderedHeadings).toEqual(
      api.items.map((item: ChangeSummary) => escapeHtml(item.title)),
    );

    // The PR title is untrusted repository data: it must reach the page
    // escaped, never as markup, while the API keeps the raw value.
    expect(api.items[0].title).toContain("<script>alert");
    expect(inbox.text).not.toContain('<script>alert("x")</script>');
    expect(inbox.text).toContain("&lt;script&gt;alert");

    // The gap badge is derived from the same `hasGap` bit the API returns.
    const expectedGaps = api.items.filter((item) => item.hasGap).length;
    expect(expectedGaps).toBe(2); // state=gap row + history_gap row
    expect(attribute(inbox.text, "data-gap-count")).toBe(String(expectedGaps));
    expect(inbox.text).toContain('data-testid="inbox-gap-badge"');
    expect(inbox.text).toContain('data-testid="polling-note"');

    // Display only: the inbox never links to GitHub (no write/comment surface).
    expect(inbox.text).not.toContain("github.com");
  });

  it("paginates with the same opaque keyset cursor as the JSON API", async () => {
    const project = seedProject(server!.repos, server!.clock, "widgets");
    seedInbox(project);

    const first = await apiPage(project.projectId, "?limit=20");
    expect(first.next).not.toBeNull();

    const inboxFirst = await harness!.request(
      `/inbox?project=${project.projectId}`,
    );
    const href = /href="(\/inbox\?[^"]*[&?]cursor=[^"]+)"/u.exec(
      inboxFirst.text,
    )?.[1];
    expect(href, "inbox renders a next-page link").toBeDefined();
    const cursor = new URL(href!, "http://127.0.0.1").searchParams.get(
      "cursor",
    );
    expect(cursor).toBe(first.next);

    const second = await apiPage(
      project.projectId,
      `?limit=20&cursor=${encodeURIComponent(first.next!)}`,
    );
    expect(second.items).toHaveLength(3);
    expect(second.next).toBeNull();

    const inboxSecond = await harness!.request(
      `/inbox?project=${project.projectId}&cursor=${encodeURIComponent(first.next!)}`,
    );
    expect(inboxSecond.status).toBe(200);
    expect(itemIds(inboxSecond.text)).toEqual(
      second.items.map((item) => item.changeId),
    );
  });

  it("treats an empty inbox cursor as the first page on both surfaces", async () => {
    const project = seedProject(server!.repos, server!.clock, "widgets");
    seedEvent(server!.repos, project, { seq: 1 });

    const api = await apiPage(project.projectId, "?cursor=");
    expect(api.items).toHaveLength(1);

    const inbox = await harness!.request(
      `/inbox?project=${project.projectId}&cursor=`,
    );
    expect(inbox.status).toBe(200);
    expect(itemIds(inbox.text)).toEqual([api.items[0].changeId]);
  });

  it("answers a malformed inbox cursor through the one error funnel, not a crash", async () => {
    const project = seedProject(server!.repos, server!.clock, "widgets");
    seedEvent(server!.repos, project, { seq: 1 });

    const inbox = await harness!.request(
      `/inbox?project=${project.projectId}&cursor=${encodeURIComponent("@@not-a-cursor@@")}`,
    );
    expect(inbox.status).toBe(400);
    expect(inbox.text).toContain("invalid_input");
    // An error document, not a half-rendered inbox.
    expect(inbox.text).not.toContain("更新收件箱");
  });
});
