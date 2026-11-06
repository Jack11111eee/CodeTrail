import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prefsModule } from "../../../src/learning/api/routes/prefs.ts";
import { computeCacheKey } from "../../../src/learning/contracts/keys.ts";
import type {
  PreferencesView,
} from "../../../src/learning/contracts/index.ts";
import { startHarness } from "../helpers/http-client.ts";
import type { Harness, HarnessResponse } from "../helpers/http-client.ts";
import { startRoutesServer } from "../helpers/routes-server.ts";
import type { RoutesServer } from "../helpers/routes-server.ts";

/**
 * Integration: preferences route (issue-16) + `cache_key` recipe (contracts).
 *
 * Learner preferences are an analysis input: `preferencesVersion` is part of
 * `computeCacheKey`, while a reading position is not. The route must therefore
 * bump the version for a preference patch and leave it alone for a reading
 * position, or a cached generation would be reused after the learner's stated
 * background changed (PRD §4, §11).
 */

let server: RoutesServer | null = null;
let harness: Harness | null = null;

function jsonOf<T>(response: HarnessResponse): T {
  expect(response.status).toBe(200);
  return response.json as T;
}

function cacheKeyFor(preferencesVersion: number): string {
  return computeCacheKey({
    repoIdentity: "local:/tmp/prefs-repo",
    targetCommitSha: "a".repeat(40),
    baseContextSha: null,
    scopeHash: "sc_1",
    generationConfigHash: "cf_1",
    promptTemplateVersion: "codetrail-lesson-v1",
    preferencesVersion,
    upstreamVersion: "0.7.2+7bb583d664f2",
  });
}

async function put(body: Record<string, unknown>): Promise<PreferencesView> {
  return jsonOf<PreferencesView>(
    await harness!.request("/api/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(async () => {
  server = await startRoutesServer([prefsModule]);
  harness = await startHarness({ start: () => server! });
});

afterEach(async () => {
  await harness?.close();
  harness = null;
  server = null;
});

describe("preferences × generation cache key", () => {
  it("bumps the preference version, moving the cache key, and exposes no ability field", async () => {
    const before = jsonOf<PreferencesView>(
      await harness!.request("/api/preferences"),
    );
    expect(before.preferences.version).toBe(0);
    expect(Object.keys(before).sort()).toEqual([
      "preferences",
      "readingPositions",
    ]);

    const after = await put({
      explainLevel: "technical_first",
      background: "熟悉 Python，不熟悉并发",
    });
    expect(after.preferences.version).toBe(1);
    expect(after.preferences.explainLevel).toBe("technical_first");
    expect(after.preferences.background).toBe("熟悉 Python，不熟悉并发");
    expect(server!.repos.prefs.version()).toBe(1);

    // The version is part of the frozen cache-key recipe.
    expect(cacheKeyFor(after.preferences.version)).not.toBe(
      cacheKeyFor(before.preferences.version),
    );

    // No comprehension/ability signal exists in the wire DTO.
    expect(JSON.stringify(after)).not.toMatch(
      /mastery|proficiency|abilityScore|examScore/iu,
    );
  });

  it("stores a reading position without touching the preference version or cache key", async () => {
    await put({ explainLevel: "plain_first" });
    const version = server!.repos.prefs.version();
    const keyBefore = cacheKeyFor(version);

    const withPosition = await put({
      readingPosition: {
        generationId: "g_1",
        lessonId: "l_1",
        offset: 42,
      },
    });

    expect(withPosition.preferences.version).toBe(version);
    expect(server!.repos.prefs.version()).toBe(version);
    expect(cacheKeyFor(withPosition.preferences.version)).toBe(keyBefore);
    expect(withPosition.readingPositions).toHaveLength(1);
    expect(withPosition.readingPositions[0]).toMatchObject({
      generationId: "g_1",
      lessonId: "l_1",
      offset: 42,
    });
    // The preference itself did not change with the reading position.
    expect(withPosition.preferences.explainLevel).toBe("plain_first");
  });
});
