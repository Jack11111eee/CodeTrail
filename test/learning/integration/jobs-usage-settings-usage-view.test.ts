import { afterEach, describe, expect, it } from "vitest";

import type {
  ModelSettings,
  ProjectId,
} from "../../../src/learning/contracts/index.ts";
import { opsModule } from "../../../src/learning/api/routes/ops.ts";
import { settingsModule } from "../../../src/learning/api/routes/settings.ts";
import type { UsageView } from "../../../src/learning/contracts/api.ts";
import {
  createHarness,
  generationInput,
  runToCompletion,
  SHA_A,
  SHA_B,
  SHA_C,
  type Harness,
} from "../generation/harness.ts";
import { countTestId, startUiServer, uiDepsFrom } from "./merge-ui-server.ts";
import type { UiServer } from "./merge-ui-server.ts";

/**
 * Integration: the jobs/publish branch's usage meter records per-call rows,
 * the ops route projects them into `UsageView`, and the ui branch's settings
 * page renders the same projection.
 *
 * The interesting boundary is pricing: `usage.ts` writes `cost_cents:null`
 * when the model has no price, `routes/ops.ts` hides a stale amount when no
 * price is configured, and the settings page must say "仅用量" rather than
 * inventing a number (AC-GEN-19, AC-UI-10).
 */

const PROJECT_ID = "p_level8_usage" as ProjectId;

interface Fixture {
  harness: Harness;
  server: UiServer;
}

const fixtures: Fixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.server.close();
    fixture.harness.close();
  }
});

async function start(
  options: { settings?: ModelSettings } = {},
): Promise<Fixture> {
  const harness = await createHarness(
    options.settings === undefined ? {} : { settings: options.settings },
  );
  harness.repos.projects.insert({
    projectId: PROJECT_ID,
    repoId: harness.repoId,
    kind: "local",
    displayName: "usage-fixture",
    remoteUrl: null,
    defaultBranch: "main",
    scope: harness.scope,
    watchEnabled: false,
    createdAt: harness.clock.now().toISOString(),
    deletedAt: null,
  });
  const server = await startUiServer(uiDepsFrom(harness), {
    modules: [opsModule, settingsModule],
  });
  const fixture = { harness, server };
  fixtures.push(fixture);
  return fixture;
}

function enqueue(harness: Harness, sha: string, mode: "init" | "update") {
  return {
    ...generationInput(harness, {
      sha,
      mode,
      streamId: `usage-${sha.slice(0, 6)}`,
    }),
    projectId: PROJECT_ID,
  };
}

function usageOf(json: unknown): UsageView {
  return json as UsageView;
}

describe("job usage rendered by the settings page", () => {
  it("groups initial/update usage and never shows money when unpriced", async () => {
    const { harness, server } = await start();

    const initial = await runToCompletion(
      harness,
      enqueue(harness, SHA_A, "init"),
    );
    expect(initial.state).toBe("completed");
    const update = await runToCompletion(
      harness,
      enqueue(harness, SHA_B, "update"),
    );
    expect(update.state).toBe("completed");

    const response = await server.get("/api/usage");
    expect(response.status).toBe(200);
    const usage = usageOf(JSON.parse(response.text));
    expect(usage.groups.map((group) => group.kind)).toEqual([
      "initial",
      "update",
    ]);
    expect(usage.groups[0].calls).toBe(3);
    expect(usage.groups[1].calls).toBe(3);
    expect(usage.groups.every((group) => group.costCents === null)).toBe(true);
    expect(usage.totals.calls).toBe(6);
    expect(usage.totals.pricingConfigured).toBe(false);
    expect(usage.totals.costCents).toBeNull();

    const filtered = usageOf(
      JSON.parse((await server.get("/api/usage?kind=initial")).text),
    );
    expect(filtered.groups.map((group) => group.kind)).toEqual(["initial"]);

    const page = await server.get("/settings");
    expect(page.status).toBe(200);
    expect(countTestId(page.text, "settings-usage")).toBe(1);
    expect(countTestId(page.text, "settings-model-scope")).toBe(1);
    expect(countTestId(page.text, "settings-storage")).toBe(1);
    expect(page.text).toContain(
      'data-testid="settings-usage" data-pricing-configured="false"',
    );
    expect(page.text).toMatch(/<tr data-kind="initial">.*?<td>3<\/td>/u);
    expect(page.text).toContain("仅用量");
    expect(page.text).toContain("仅用量：未配置价格，不显示金额。");

    // Storage and model scope come from the same merged repositories.
    expect(page.text).toContain("生成版本 2 个");
    expect(page.text).toContain("项目 1 个");
    expect(page.text).toContain('name="model" required value="scripted"');
    expect(page.text).toContain("发送给模型的内容范围");
  });

  it("keeps existing null costs after pricing is configured through the API", async () => {
    const { harness, server } = await start();
    await runToCompletion(harness, enqueue(harness, SHA_A, "init"));

    const put = await server.request("/api/settings/model", {
      method: "PUT",
      body: {
        provider: "fixture",
        model: "scripted",
        pricing: { inputCentsPerMTok: 100, outputCentsPerMTok: 100 },
      },
    });
    expect(put.status).toBe(200);
    expect(JSON.parse(put.text)).toMatchObject({
      pricingConfigured: true,
      provider: "fixture",
    });

    const usage = usageOf(JSON.parse((await server.get("/api/usage")).text));
    expect(usage.totals.pricingConfigured).toBe(true);
    // The recorded rows were unpriced when they were written; the view must
    // not fabricate an amount for them.
    expect(usage.groups[0].costCents).toBeNull();
    expect(usage.totals.costCents).toBeNull();

    const page = await server.get("/settings");
    expect(page.text).toContain('data-pricing-configured="true"');
    expect(page.text).not.toContain("仅用量：未配置价格，不显示金额。");
  });

  it("shows the recorded cost once the model handle carries a price", async () => {
    const { harness, server } = await start({
      settings: {
        provider: "fixture",
        model: "scripted",
        maxOutputTokens: 1024,
        temperature: 0,
        pricing: { inputCentsPerMTok: 100, outputCentsPerMTok: 100 },
        quota: {
          maxCalls: 1000,
          maxInputTokens: 1_000_000,
          maxOutputTokens: 1_000_000,
        },
      },
    });
    const job = await runToCompletion(harness, enqueue(harness, SHA_C, "init"));
    expect(job.state).toBe("completed");

    const usage = usageOf(JSON.parse((await server.get("/api/usage")).text));
    const record = usage.groups.find((group) => group.kind === "initial")!;
    expect(record.costCents).not.toBeNull();
    expect(usage.totals.costCents).not.toBeNull();
    expect(usage.totals.pricingConfigured).toBe(true);

    const page = await server.get("/settings");
    expect(page.text).toContain(
      'data-testid="settings-usage" data-pricing-configured="true"',
    );
    expect(page.text).toContain(`${String(record.costCents)} 分`);
    expect(page.text).not.toContain("仅用量");
  });
});
