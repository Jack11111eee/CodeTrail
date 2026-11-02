import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { opsModule } from "../../../src/learning/api/routes/ops.ts";
import type { UsageView } from "../../../src/learning/contracts/index.ts";
import { startHarness } from "../helpers/http-client.ts";
import type { Harness, HarnessResponse } from "../helpers/http-client.ts";
import { startRoutesServer } from "../helpers/routes-server.ts";
import type { RoutesServer } from "../helpers/routes-server.ts";
import { makeModelSettings, makeUsage } from "../store/helpers.ts";

/**
 * AC-GEN-19 (API half) and AC-UI-10's data half.
 *
 * Usage is grouped by task kind in the canonical order. When no price is
 * configured every amount is `null` ("仅用量"); the totals are the sum of the
 * groups, so the two can never drift.
 */

let server: RoutesServer | null = null;
let harness: Harness | null = null;

function jsonOf<T>(response: HarnessResponse): T {
  expect(response.status).toBe(200);
  return response.json as T;
}

function seedUsage(i: {
  usageId: string;
  kind: UsageView["groups"][number]["kind"];
  inputTokens: number;
  outputTokens: number;
  calls: number;
  costCents: number | null;
}): void {
  server!.repos.usage.insert(
    makeUsage({
      usageId: i.usageId,
      kind: i.kind,
      inputTokens: i.inputTokens,
      outputTokens: i.outputTokens,
      calls: i.calls,
      costCents: i.costCents,
    }),
  );
}

beforeEach(async () => {
  server = await startRoutesServer([opsModule]);
  harness = await startHarness({ start: () => server! });
});

afterEach(async () => {
  await harness?.close();
  harness = null;
  server = null;
});

describe("GET /api/usage", () => {
  it("returns empty groups and zero totals when there are no rows", async () => {
    const view = jsonOf<UsageView>(await harness!.request("/api/usage"));

    expect(view.groups).toEqual([]);
    expect(view.totals).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      costCents: null,
      pricingConfigured: false,
    });
  });

  it("groups mixed kinds and totals them", async () => {
    seedUsage({
      usageId: "u_initial",
      kind: "initial",
      inputTokens: 10,
      outputTokens: 5,
      calls: 1,
      costCents: null,
    });
    seedUsage({
      usageId: "u_qa",
      kind: "qa",
      inputTokens: 20,
      outputTokens: 10,
      calls: 2,
      costCents: null,
    });
    seedUsage({
      usageId: "u_change",
      kind: "change",
      inputTokens: 100,
      outputTokens: 50,
      calls: 4,
      costCents: null,
    });

    const view = jsonOf<UsageView>(await harness!.request("/api/usage"));

    expect(view.groups.map((group) => group.kind)).toEqual([
      "initial",
      "qa",
      "change",
    ]);
    expect(view.totals.inputTokens).toBe(130);
    expect(view.totals.outputTokens).toBe(65);
    expect(view.totals.calls).toBe(7);
    expect(view.totals.pricingConfigured).toBe(false);
    expect(view.totals.costCents).toBeNull();
    expect(view.groups.every((group) => group.costCents === null)).toBe(true);
  });

  it("forces costCents to null when pricing is unconfigured, even for legacy rows", async () => {
    seedUsage({
      usageId: "u_legacy",
      kind: "update",
      inputTokens: 1,
      outputTokens: 2,
      calls: 1,
      costCents: 5,
    });

    const view = jsonOf<UsageView>(await harness!.request("/api/usage"));
    expect(view.groups[0]?.costCents).toBeNull();
    expect(view.totals.costCents).toBeNull();
    expect(view.totals.pricingConfigured).toBe(false);
  });

  it("reports costs when pricing is configured and totals match the groups", async () => {
    server!.repos.settings.putModel(
      makeModelSettings({
        pricing: { inputCentsPerMTok: 10, outputCentsPerMTok: 30 },
      }),
    );
    seedUsage({
      usageId: "u_a",
      kind: "initial",
      inputTokens: 1_000,
      outputTokens: 500,
      calls: 3,
      costCents: 4,
    });
    seedUsage({
      usageId: "u_b",
      kind: "comparison",
      inputTokens: 2_000,
      outputTokens: 100,
      calls: 2,
      costCents: 6,
    });

    const view = jsonOf<UsageView>(await harness!.request("/api/usage"));
    expect(view.totals.pricingConfigured).toBe(true);
    expect(view.groups.map((group) => group.kind)).toEqual([
      "initial",
      "comparison",
    ]);
    expect(view.groups.map((group) => group.costCents)).toEqual([4, 6]);

    const summed = view.groups.reduce(
      (acc, group) => ({
        inputTokens: acc.inputTokens + group.inputTokens,
        outputTokens: acc.outputTokens + group.outputTokens,
        calls: acc.calls + group.calls,
        costCents: acc.costCents + (group.costCents ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0, calls: 0, costCents: 0 },
    );
    expect(view.totals).toEqual({
      ...summed,
      pricingConfigured: true,
    });
  });

  it("filters by kind and totals only that kind", async () => {
    seedUsage({
      usageId: "u_initial",
      kind: "initial",
      inputTokens: 10,
      outputTokens: 5,
      calls: 1,
      costCents: null,
    });
    seedUsage({
      usageId: "u_qa",
      kind: "qa",
      inputTokens: 20,
      outputTokens: 10,
      calls: 2,
      costCents: null,
    });

    const view = jsonOf<UsageView>(
      await harness!.request("/api/usage?kind=qa"),
    );
    expect(view.groups).toHaveLength(1);
    expect(view.groups[0]).toMatchObject({ kind: "qa", calls: 2 });
    expect(view.totals).toMatchObject({
      inputTokens: 20,
      outputTokens: 10,
      calls: 2,
    });
  });

  it("rejects an unknown kind with invalid_input", async () => {
    const response = await harness!.request("/api/usage?kind=bogus");
    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({ error: { code: "invalid_input" } });
  });
});
