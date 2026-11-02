import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dataSentManifest } from "../../../src/learning/config/model.ts";
import type { ModelSettings } from "../../../src/learning/config/model.ts";
import { settingsModule } from "../../../src/learning/api/routes/settings.ts";
import {
  computeConfigHash,
  computeDedupeKey,
} from "../../../src/learning/contracts/keys.ts";
import type {
  GenerationConfig,
  ModelSettingsView,
  RepoId,
} from "../../../src/learning/contracts/index.ts";
import { startHarness } from "../helpers/http-client.ts";
import type { Harness, HarnessResponse } from "../helpers/http-client.ts";
import { startRoutesServer } from "../helpers/routes-server.ts";
import type { RoutesServer } from "../helpers/routes-server.ts";

/**
 * AC-UI-09 and the API half of AC-GEN-19.
 *
 * The settings view discloses provider, model, quota, price state and the
 * `dataSent` manifest. A persisted row is exactly the source the job runner
 * turns into `GenerationConfig.model`, so changing the model changes the next
 * analysis' `config_hash` and `dedupe_key`.
 */

let server: RoutesServer | null = null;
let harness: Harness | null = null;

function jsonOf<T>(response: HarnessResponse): T {
  expect(response.status).toBe(200);
  return response.json as T;
}

function configFrom(settings: ModelSettings): GenerationConfig {
  return {
    language: "zh",
    model: {
      provider: settings.provider,
      model: settings.model,
      maxOutputTokens: settings.maxOutputTokens,
      temperature: settings.temperature,
    },
    pageConcurrency: 1,
    promptTemplateVersion: "v1",
    lessonPipelineVersion: "lp1",
    includeTests: false,
    externalDocs: { enabled: false, maxPerLesson: 0 },
  };
}

beforeEach(async () => {
  server = await startRoutesServer([settingsModule]);
  harness = await startHarness({ start: () => server! });
});

afterEach(async () => {
  await harness?.close();
  harness = null;
  server = null;
});

describe("GET /api/settings/model", () => {
  it("reports an unconfigured model with the dataSent manifest and zero quota", async () => {
    const view = jsonOf<ModelSettingsView>(
      await harness!.request("/api/settings/model"),
    );

    expect(view.provider).toBe("");
    expect(view.model).toBe("");
    expect(view.pricingConfigured).toBe(false);
    expect(view.quota).toEqual({
      maxCalls: 0,
      maxInputTokens: 0,
      maxOutputTokens: 0,
    });
    expect(view.dataSent).toEqual(dataSentManifest());
  });

  it("always returns a non-empty dataSent array of strings", async () => {
    const view = jsonOf<ModelSettingsView>(
      await harness!.request("/api/settings/model"),
    );
    expect(Array.isArray(view.dataSent)).toBe(true);
    expect(view.dataSent.length).toBeGreaterThan(0);
    expect(
      view.dataSent.every((entry) => typeof entry === "string" && entry !== ""),
    ).toBe(true);
  });
});

describe("PUT /api/settings/model", () => {
  it("persists provider, model, quota and pricing and reports them back", async () => {
    const view = jsonOf<ModelSettingsView>(
      await harness!.request("/api/settings/model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          model: "claude-test",
          maxOutputTokens: 2048,
          temperature: 0.1,
          pricing: { inputCentsPerMTok: 10, outputCentsPerMTok: 30 },
          quota: {
            maxCalls: 100,
            maxInputTokens: 1_000_000,
            maxOutputTokens: 200_000,
          },
        }),
      }),
    );

    expect(view).toMatchObject({
      provider: "anthropic",
      model: "claude-test",
      pricingConfigured: true,
      quota: {
        maxCalls: 100,
        maxInputTokens: 1_000_000,
        maxOutputTokens: 200_000,
      },
    });

    const reread = jsonOf<ModelSettingsView>(
      await harness!.request("/api/settings/model"),
    );
    expect(reread).toEqual(view);
  });

  it("treats pricing:null as unpriced", async () => {
    const view = jsonOf<ModelSettingsView>(
      await harness!.request("/api/settings/model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "fixture",
          model: "scripted-model",
          pricing: null,
        }),
      }),
    );

    expect(view.pricingConfigured).toBe(false);
  });

  it("feeds the next analysis' config_hash and dedupe_key", async () => {
    await harness!.request("/api/settings/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "anthropic",
        model: "claude-first",
        maxOutputTokens: 1024,
        temperature: 0,
      }),
    });
    const first = server!.repos.settings.model();
    expect(first).not.toBeNull();

    await harness!.request("/api/settings/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "anthropic",
        model: "claude-second",
        maxOutputTokens: 1024,
        temperature: 0,
      }),
    });
    const second = server!.repos.settings.model();
    expect(second).not.toBeNull();

    const firstHash = computeConfigHash(configFrom(first as ModelSettings));
    const secondHash = computeConfigHash(configFrom(second as ModelSettings));
    expect(secondHash).not.toBe(firstHash);

    const keyInput = {
      repoId: "r_1" as RepoId,
      streamId: null,
      comparisonBaseSha: null,
      headSha: "a".repeat(40),
      baseContextSha: null,
      scopeHash: "sc_1",
      analysisConfigHash: "",
    };
    expect(
      computeDedupeKey({ ...keyInput, analysisConfigHash: firstHash }),
    ).not.toBe(
      computeDedupeKey({ ...keyInput, analysisConfigHash: secondHash }),
    );
  });

  it("rejects a negative quota with invalid_input", async () => {
    const response = await harness!.request("/api/settings/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "anthropic",
        model: "claude-test",
        quota: { maxCalls: -1 },
      }),
    });

    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({ error: { code: "invalid_input" } });
  });

  it("rejects an unknown field with invalid_input", async () => {
    const response = await harness!.request("/api/settings/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "anthropic",
        model: "claude-test",
        mastery: 1,
      }),
    });

    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({ error: { code: "invalid_input" } });
  });
});
