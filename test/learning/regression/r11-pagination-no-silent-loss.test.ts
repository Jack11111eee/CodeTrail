/**
 * AC-R11-01: discovery has no silent loss. The number of persisted events must
 * equal the change log the server actually reported — across a multi-commit
 * first-parent chain, multiple PR pages, and a commit with a large diff — and
 * an unreadable history must be recorded as an explicit `history_gap` event.
 *
 * Expected counts are derived from the fake Git repository's own commit list
 * and the fake HTTP server's own PR pages, never from a hardcoded list.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { PullRequestMeta } from "../../../src/learning/contracts/index.ts";
import { createGithubClient } from "../../../src/learning/updates/github-client.ts";
import { createDiscoveryService } from "../../../src/learning/updates/discovery.ts";
import { startFakeGithub, type FakeGithub } from "../helpers/fake-github.ts";
import {
  cleanupHarness,
  createUpdateHarness,
  type UpdateHarness,
} from "../updates/harness.ts";

let harness: UpdateHarness | undefined;
let fake: FakeGithub | undefined;

afterEach(async () => {
  cleanupHarness(harness);
  harness = undefined;
  await fake?.close();
  fake = undefined;
});

/** Counts the fake server's PR list by paging its own REST surface. */
async function serverPullTally(
  baseUrl: string,
  perPage: number,
): Promise<number> {
  const seen = new Set<number>();
  for (let page = 1; page <= 100; page += 1) {
    const response = await fetch(
      `${baseUrl}/repos/acme/widgets/pulls?state=all&sort=updated&direction=desc&per_page=${perPage}&page=${page}`,
    );
    const items = (await response.json()) as PullRequestMeta[];
    if (items.length === 0) break;
    for (const item of items) seen.add(item.number);
  }
  return seen.size;
}

describe("AC-R11-01 — pagination without silent loss", () => {
  it("creates one event per real commit across multiple nodes", async () => {
    harness = await createUpdateHarness();
    await harness.tick();

    const commitsBefore = harness.git.commitList("main").length;
    for (let index = 0; index < 4; index += 1) {
      harness.git.write(`src/node-${index}.ts`, `export const n = ${index};\n`);
      harness.git.commit(`feat: node ${index}`);
    }
    const commitsAfter = harness.git.commitList("main").length;
    const realChanges = commitsAfter - commitsBefore;

    const result = await harness.tick();
    expect(realChanges).toBe(4);
    expect(result.discovered).toBe(realChanges);
    expect(
      harness.events().filter((event) => event.kind === "commit"),
    ).toHaveLength(realChanges);
    expect(
      harness.jobs().filter((job) => job.streamId === "default_branch"),
    ).toHaveLength(realChanges);
    expect(harness.discoveryCursor()?.headSha).toBe(harness.git.head("main"));
  });

  it("creates one event per PR across multiple pages", async () => {
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

    const tally = await serverPullTally(fake.baseUrl, 2);
    const result = await discovery.tickPullRequests(harness.project.projectId, {
      now: harness.clock.now(),
      overlapMs: 120_000,
      perPage: 2,
      maxPages: 20,
    });

    expect(tally).toBe(6);
    expect(result.discovered).toBe(tally);
    const prEvents = harness
      .events()
      .filter((event) => event.kind === "pull_request");
    expect(prEvents).toHaveLength(tally);
    expect(new Set(prEvents.map((event) => event.headSha)).size).toBe(tally);

    // Page >= 2 was really requested; a one-page walk would have lost four.
    const pages = fake.requests
      .filter((request) => request.path.includes("/pulls?"))
      .map((request) => /[?&]page=(\d+)/u.exec(request.path)?.[1] ?? "");
    expect(pages.some((page) => Number(page) >= 2)).toBe(true);
  });

  it("creates exactly one event for a commit with a large diff", async () => {
    harness = await createUpdateHarness();
    await harness.tick();

    const commitsBefore = harness.git.commitList("main").length;
    for (let index = 0; index < 350; index += 1) {
      harness.git.write(
        `src/generated/file-${String(index).padStart(3, "0")}.ts`,
        `export const value = ${index};\n`,
      );
    }
    const head = harness.git.commit("feat: large generated change");
    const realChanges = harness.git.commitList("main").length - commitsBefore;

    await harness.tick();
    expect(realChanges).toBe(1);
    expect(
      harness.events().filter((event) => event.headSha === head),
    ).toHaveLength(1);
  });

  it("records an unreadable first-parent history as history_gap", async () => {
    harness = await createUpdateHarness();
    const oldHead = harness.git.head("main");
    await harness.tick();

    // An unrelated root: the old head is not an ancestor of the new head, so no
    // intermediate version can be claimed.
    harness.git.git(["checkout", "-q", "--orphan", "rewritten"]);
    harness.git.git(["rm", "-rf", "."]);
    harness.git.write("src/rewritten.ts", "export const rewritten = true;\n");
    const newHead = harness.git.commit("rewrite: new root");
    harness.git.forceBranch("main", newHead);
    harness.git.checkout("main");

    const result = await harness.tick();
    expect(result.gaps).toBe(1);
    const gap = harness.events().find((event) => event.kind === "history_gap");
    expect(gap).toBeDefined();
    expect(gap?.gapReason).toBe("history_gap");
    expect(gap?.baseSha).toBe(oldHead);
    expect(gap?.headSha).toBe(newHead);
    expect(harness.discoveryCursor()?.lastGapSha).toBe(oldHead);
    expect(
      harness.events().filter((event) => event.kind === "commit"),
    ).toHaveLength(0);
  });
});
