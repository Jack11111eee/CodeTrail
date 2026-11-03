import { afterEach, describe, expect, it } from "vitest";

import { createGithubClient } from "../../../src/learning/updates/github-client.ts";
import { createDiscoveryService } from "../../../src/learning/updates/discovery.ts";
import { startFakeGithub, type FakeGithub } from "../helpers/fake-github.ts";
import {
  cleanupHarness,
  createUpdateHarness,
  type UpdateHarness,
} from "./harness.ts";

/**
 * AC-UPD-07: a three-page fake server containing open, closed and merged PRs
 * is fully discovered; requests use `state=all&sort=updated&direction=desc`
 * with increasing `page`, and page >= 2 is observed.
 */
describe("pull request pagination", () => {
  let harness: UpdateHarness | undefined;
  let fake: FakeGithub | undefined;

  afterEach(async () => {
    cleanupHarness(harness);
    harness = undefined;
    await fake?.close();
    fake = undefined;
  });

  it("walks every page and every state", async () => {
    fake = await startFakeGithub({
      ownerRepo: "acme/widgets",
      pages: 3,
      perPage: 2,
      states: ["open", "closed", "merged"],
    });
    harness = await createUpdateHarness();
    const client = createGithubClient({
      baseUrl: fake.baseUrl,
      credential: null,
      clock: harness.clock,
    });
    const discovery = createDiscoveryService({
      db: harness.db,
      repos: harness.repos,
      clock: harness.clock,
      github: client,
      paths: harness.paths,
    });

    const result = await discovery.tickPullRequests(harness.project.projectId, {
      now: harness.clock.now(),
      overlapMs: 120_000,
      perPage: 2,
      maxPages: 20,
    });

    expect(result.discovered).toBe(6);
    const prEvents = harness
      .events()
      .filter((event) => event.kind === "pull_request");
    expect(prEvents).toHaveLength(6);
    expect(new Set(prEvents.map((event) => event.payload.pr?.state))).toEqual(
      new Set(["open", "closed"]),
    );
    expect(prEvents.some((event) => event.payload.pr?.merged)).toBe(true);

    const pullRequests = fake.requests.filter((request) =>
      request.path.includes("/pulls?"),
    );
    expect(pullRequests).toHaveLength(3);
    for (const request of pullRequests) {
      expect(request.path).toContain("state=all");
      expect(request.path).toContain("sort=updated");
      expect(request.path).toContain("direction=desc");
    }
    const pages = pullRequests.map((request) => {
      const match = /[?&]page=(\d+)/u.exec(request.path);
      return match === null ? null : Number(match[1]);
    });
    expect(pages).toEqual([1, 2, 3]);
    expect(pages.some((page) => page !== null && page >= 2)).toBe(true);
  });
});
