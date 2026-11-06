import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { opsModule } from "../../../src/learning/api/routes/ops.ts";
import { settingsModule } from "../../../src/learning/api/routes/settings.ts";
import {
  computeConfigHash,
  computeDedupeKey,
} from "../../../src/learning/contracts/keys.ts";
import type {
  GenerationConfig,
  ModelSettings,
  ModelSettingsView,
  RepoId,
  UsageView,
} from "../../../src/learning/contracts/index.ts";
import { startHarness } from "../helpers/http-client.ts";
import type { Harness, HarnessResponse } from "../helpers/http-client.ts";
import { startRoutesServer } from "../helpers/routes-server.ts";
import type { RoutesServer } from "../helpers/routes-server.ts";
import { makeUsage } from "../store/helpers.ts";

/**
 * Integration: model settings route (issue-16) + usage/storage route (issue-16)
 * + the frozen `config_hash` recipe (contracts/keys).
 *
 * The settings row is read by two consumers that must agree: the job runner
 * hashes it into `config_hash`, and the usage route uses its price to decide
 * whether any amount may be shown. The boundary assertions are that a pricing
 * PUT immediately changes what `/api/usage` reports, and that a quota PUT — a
 * resource limit, not an analysis input — leaves `config_hash`/`dedupe_key`
 * untouched.
 */

let server: RoutesServer | null = null;
let harness: Harness | null = null;

function jsonOf<T>(response: HarnessResponse): T {
  expect(response.status).toBe(200);
  return response.json as T;
}

async function putModel(body: Record<string, unknown>): Promise<unknown> {
  const response = await harness!.request("/api/settings/model", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return jsonOf<ModelSettingsView>(response);
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
    promptTemplateVersion: "codetrail-lesson-v1",
    lessonPipelineVersion: "lp1",
    includeTests: false,
    externalDocs: { enabled: false, maxPerLesson: 0 },
  };
}

function dedupeKeyFor(settings: ModelSettings): string {
  return computeDedupeKey({
    repoId: "r_1" as RepoId,
    streamId: null,
    comparisonBaseSha: null,
    headSha: "a".repeat(40),
    baseContextSha: null,
    scopeHash: "sc_1",
    analysisConfigHash: computeConfigHash(configFrom(settings)),
  });
}

beforeEach(async () => {
  server = await startRoutesServer([settingsModule, opsModule]);
  harness = await startHarness({ start: () => server! });
});

afterEach(async () => {
  await harness?.close();
  harness = null;
  server = null;
});

describe("settings × usage boundary", () => {
  it("a pricing PUT flips the amounts the usage route may report", async () => {
    server!.repos.usage.insert(
      makeUsage({
        usageId: "u_initial",
        kind: "initial",
        inputTokens: 10,
        outputTokens: 5,
        calls: 1,
        costCents: 7,
      }),
    );
    server!.repos.usage.insert(
      makeUsage({
        usageId: "u_qa",
        kind: "qa",
        inputTokens: 20,
        outputTokens: 10,
        calls: 2,
        costCents: 3,
      }),
    );

    // Unpriced deployment: recorded amounts are hidden, only usage is shown.
    const before = jsonOf<UsageView>(await harness!.request("/api/usage"));
    expect(before.totals.pricingConfigured).toBe(false);
    expect(before.totals.costCents).toBeNull();
    expect(before.groups.map((group) => group.kind)).toEqual([
      "initial",
      "qa",
    ]);
    expect(before.groups.map((group) => group.costCents)).toEqual([
      null,
      null,
    ]);

    const settings = (await putModel({
      provider: "anthropic",
      model: "claude-test",
      pricing: { inputCentsPerMTok: 10, outputCentsPerMTok: 30 },
    })) as ModelSettingsView;
    expect(settings.pricingConfigured).toBe(true);

    // The very next usage read sees the configured price and the stored costs.
    const after = jsonOf<UsageView>(await harness!.request("/api/usage"));
    expect(after.totals).toEqual({
      inputTokens: 30,
      outputTokens: 15,
      calls: 3,
      costCents: 10,
      pricingConfigured: true,
    });
    expect(after.groups.map((group) => group.costCents)).toEqual([7, 3]);
  });

  it("a quota change is a resource limit, not an analysis input", async () => {
    await putModel({
      provider: "anthropic",
      model: "claude-test",
      maxOutputTokens: 1024,
      temperature: 0,
      quota: { maxCalls: 100, maxInputTokens: 1_000_000, maxOutputTokens: 200_000 },
    });
    const first = server!.repos.settings.model() as ModelSettings;
    const firstHash = computeConfigHash(configFrom(first));
    const firstKey = dedupeKeyFor(first);

    await putModel({
      provider: "anthropic",
      model: "claude-test",
      maxOutputTokens: 1024,
      temperature: 0,
      quota: { maxCalls: 7, maxInputTokens: 2_000, maxOutputTokens: 3_000 },
    });
    const second = server!.repos.settings.model() as ModelSettings;

    // `quota` is not part of the config hash recipe: cached generations stay
    // cacheable after a quota tightening.
    expect(second.quota.maxCalls).toBe(7);
    expect(second.quota.maxInputTokens).toBe(2_000);
    expect(computeConfigHash(configFrom(second))).toBe(firstHash);
    expect(dedupeKeyFor(second)).toBe(firstKey);

    // The inputs that *are* in the recipe do move the hash.
    await putModel({
      provider: "anthropic",
      model: "claude-test",
      maxOutputTokens: 2048,
      temperature: 0,
    });
    const third = server!.repos.settings.model() as ModelSettings;
    expect(computeConfigHash(configFrom(third))).not.toBe(firstHash);
    expect(dedupeKeyFor(third)).not.toBe(firstKey);
  });

  it("keeps pricing across a merge PUT and reports the same view on re-read", async () => {
    await putModel({
      provider: "anthropic",
      model: "claude-test",
      maxOutputTokens: 512,
      temperature: 0.2,
      pricing: { inputCentsPerMTok: 1, outputCentsPerMTok: 2 },
    });
    // A later PUT that omits pricing must not silently drop it.
    const merged = (await putModel({
      provider: "anthropic",
      model: "claude-test",
      maxOutputTokens: 512,
      temperature: 0.2,
    })) as ModelSettingsView;
    expect(merged.pricingConfigured).toBe(true);

    const reread = jsonOf<ModelSettingsView>(
      await harness!.request("/api/settings/model"),
    );
    expect(reread).toEqual(merged);
    expect(reread.dataSent.length).toBeGreaterThan(0);
    expect(server!.repos.settings.model()?.pricing).toEqual({
      inputCentsPerMTok: 1,
      outputCentsPerMTok: 2,
    });
  });
});
