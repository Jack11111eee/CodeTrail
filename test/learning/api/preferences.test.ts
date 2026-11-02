import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prefsModule } from "../../../src/learning/api/routes/prefs.ts";
import type {
  PreferencesView,
  ReadingPosition,
} from "../../../src/learning/contracts/index.ts";
import { startHarness } from "../helpers/http-client.ts";
import type { Harness, HarnessResponse } from "../helpers/http-client.ts";
import { startRoutesServer } from "../helpers/routes-server.ts";
import type { RoutesServer } from "../helpers/routes-server.ts";

/**
 * AC-UI-08 (API half) and AC-SCOPE-02.
 *
 * Preferences and reading positions are two stores with two payload fields.
 * The response has no mastery/score/proficiency concept, and neither store can
 * be written through the other's payload.
 */

let server: RoutesServer | null = null;
let harness: Harness | null = null;

async function boot(): Promise<void> {
  server = await startRoutesServer([prefsModule]);
  harness = await startHarness({ start: () => server! });
}

function jsonOf<T>(response: HarnessResponse): T {
  expect(response.status).toBe(200);
  return response.json as T;
}

function positionKey(position: ReadingPosition): string {
  return `${position.generationId}/${position.lessonId}`;
}

function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      collectKeys(child, out);
    }
  }
  return out;
}

beforeEach(async () => {
  await boot();
});

afterEach(async () => {
  await harness?.close();
  harness = null;
  server = null;
});

describe("GET /api/preferences", () => {
  it("returns exactly preferences and reading positions with defaults", async () => {
    const body = jsonOf<PreferencesView>(
      await harness!.request("/api/preferences"),
    );

    expect(Object.keys(body).sort()).toEqual([
      "preferences",
      "readingPositions",
    ]);
    expect(body.preferences).toMatchObject({
      explainLevel: "plain_first",
      background: null,
      language: "zh",
      version: 0,
    });
    expect(body.readingPositions).toEqual([]);
  });

  it("never exposes a mastery, score or proficiency key anywhere", async () => {
    const response = await harness!.request("/api/preferences");
    const keys = collectKeys(response.json);
    for (const forbidden of ["mastery", "score", "proficiency"]) {
      expect(keys).not.toContain(forbidden);
    }
    expect(response.text).not.toMatch(/mastery|proficiency/iu);
  });
});

describe("PUT /api/preferences", () => {
  it("writes explainLevel and background, bumping the version", async () => {
    const body = jsonOf<PreferencesView>(
      await harness!.request("/api/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          explainLevel: "technical_first",
          background: "会一点 Python",
        }),
      }),
    );

    expect(body.preferences.explainLevel).toBe("technical_first");
    expect(body.preferences.background).toBe("会一点 Python");
    expect(body.preferences.version).toBe(1);
    expect(body.readingPositions).toEqual([]);
  });

  it("writes a reading position without bumping the preference version", async () => {
    const first = jsonOf<PreferencesView>(
      await harness!.request("/api/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          readingPosition: { generationId: "g_1", lessonId: "l_1", offset: 0 },
        }),
      }),
    );

    expect(first.preferences.version).toBe(0);
    expect(first.readingPositions).toHaveLength(1);
    expect(first.readingPositions[0]).toMatchObject({
      generationId: "g_1",
      lessonId: "l_1",
      offset: 0,
      conversationId: null,
    });
  });

  it("keeps the first position when a second lesson is stored", async () => {
    await harness!.request("/api/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        readingPosition: { generationId: "g_1", lessonId: "l_1", offset: 3 },
      }),
    });
    const body = jsonOf<PreferencesView>(
      await harness!.request("/api/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          readingPosition: { generationId: "g_1", lessonId: "l_2", offset: 10 },
        }),
      }),
    );

    expect(body.readingPositions.map(positionKey).sort()).toEqual([
      "g_1/l_1",
      "g_1/l_2",
    ]);
  });

  it("a preferences-only PUT never touches reading positions", async () => {
    await harness!.request("/api/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        readingPosition: { generationId: "g_1", lessonId: "l_1", offset: 7 },
      }),
    });

    const body = jsonOf<PreferencesView>(
      await harness!.request("/api/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ explainLevel: "technical_first" }),
      }),
    );

    expect(body.readingPositions).toHaveLength(1);
    expect(body.readingPositions[0]?.offset).toBe(7);
    expect(body.preferences.version).toBe(1);
  });

  it("a position PUT never changes preferences", async () => {
    await harness!.request("/api/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        explainLevel: "technical_first",
        background: "背景",
      }),
    });
    const second = jsonOf<PreferencesView>(
      await harness!.request("/api/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          readingPosition: { generationId: "g_2", lessonId: "l_9", offset: 1 },
        }),
      }),
    );

    expect(second.preferences.explainLevel).toBe("technical_first");
    expect(second.preferences.background).toBe("背景");
    expect(second.preferences.version).toBe(1);
  });

  it("survives a restart", async () => {
    await harness!.request("/api/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        explainLevel: "technical_first",
        background: "会一点 Python",
        readingPosition: { generationId: "g_1", lessonId: "l_1", offset: 4 },
      }),
    });

    await harness!.close();
    harness = null;
    server = null;
    await boot();

    const body = jsonOf<PreferencesView>(
      await harness!.request("/api/preferences"),
    );
    expect(body.preferences.explainLevel).toBe("technical_first");
    expect(body.preferences.background).toBe("会一点 Python");
    expect(body.readingPositions).toHaveLength(1);
    expect(body.readingPositions[0]?.offset).toBe(4);
  });

  it("rejects an unknown field with invalid_input", async () => {
    const response = await harness!.request("/api/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mastery: 99 }),
    });

    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({
      error: { code: "invalid_input" },
    });
  });

  it("rejects a negative offset with invalid_input", async () => {
    const response = await harness!.request("/api/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        readingPosition: { generationId: "g_1", lessonId: "l_1", offset: -1 },
      }),
    });

    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({
      error: { code: "invalid_input" },
    });
  });
});
