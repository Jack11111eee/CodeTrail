/**
 * Model settings disclosure (architecture §3.8, §4.4, §14.1).
 *
 * `GET /api/settings/model` is the only place the UI learns what leaves the
 * machine: `dataSent` is the frozen `dataSentManifest()`, and `pricingConfigured`
 * tells the settings/usage pages whether a cost may ever be shown (AC-UI-09,
 * AC-GEN-19).
 *
 * The row lives in `app_settings(key='model')` — deployment settings, not
 * learner preferences. `GenerationConfig.model` is hashed into `config_hash`,
 * so a successful PUT changes the next analysis's `config_hash` and therefore
 * its `dedupe_key`/`cache_key` (Appendix B5).
 */

import { dataSentManifest } from "../../config/model.js";
import type { ModelSettings } from "../../config/model.js";
import { LearningError, errorMessageFor } from "../../contracts/index.js";
import type {
  HandlerFactory,
  ModelSettingsView,
  PutModelSettingsRequest,
  RouteDef,
  RouteHandlerKey,
  RouteModule,
} from "../../contracts/index.js";

/** Applied only when the row is absent and the PUT omits the field. */
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
const DEFAULT_TEMPERATURE = 0.2;
const EMPTY_QUOTA: ModelSettings["quota"] = Object.freeze({
  maxCalls: 0,
  maxInputTokens: 0,
  maxOutputTokens: 0,
});

export const routes: RouteDef[] = [
  {
    method: "GET",
    pattern: "/api/settings/model",
    auth: "session",
    handler: "settings.model.get",
  },
  {
    method: "PUT",
    pattern: "/api/settings/model",
    auth: "session",
    handler: "settings.model.put",
  },
];

/**
 * Projects the persisted row (or its absence) onto the wire DTO. A null row is
 * reported as an empty provider/model with `pricingConfigured:false` and a zero
 * quota; `dataSent` is always present, even before a model is configured.
 */
export function toModelSettingsView(
  settings: ModelSettings | null,
): ModelSettingsView {
  return {
    provider: settings?.provider ?? "",
    model: settings?.model ?? "",
    pricingConfigured:
      settings?.pricing !== null && settings?.pricing !== undefined,
    quota: {
      maxCalls: settings?.quota.maxCalls ?? EMPTY_QUOTA.maxCalls,
      maxInputTokens:
        settings?.quota.maxInputTokens ?? EMPTY_QUOTA.maxInputTokens,
      maxOutputTokens:
        settings?.quota.maxOutputTokens ?? EMPTY_QUOTA.maxOutputTokens,
    },
    dataSent: dataSentManifest(),
  };
}

const getModelSettings: HandlerFactory = (deps) => () =>
  Promise.resolve({
    kind: "json",
    status: 200,
    body: toModelSettingsView(deps.repos.settings.model()),
  });

const putModelSettings: HandlerFactory = (deps) => (req) => {
  if (
    typeof req.body !== "object" ||
    req.body === null ||
    Array.isArray(req.body)
  ) {
    throw new LearningError(
      "invalid_input",
      errorMessageFor("invalid_input", "zh"),
      { field: "body" },
    );
  }
  const body = req.body as PutModelSettingsRequest;
  const current = deps.repos.settings.model();

  const next: ModelSettings = {
    provider: body.provider,
    model: body.model,
    maxOutputTokens:
      body.maxOutputTokens ??
      current?.maxOutputTokens ??
      DEFAULT_MAX_OUTPUT_TOKENS,
    temperature:
      body.temperature ?? current?.temperature ?? DEFAULT_TEMPERATURE,
    pricing:
      body.pricing === undefined ? (current?.pricing ?? null) : body.pricing,
    quota: {
      maxCalls:
        body.quota?.maxCalls ?? current?.quota.maxCalls ?? EMPTY_QUOTA.maxCalls,
      maxInputTokens:
        body.quota?.maxInputTokens ??
        current?.quota.maxInputTokens ??
        EMPTY_QUOTA.maxInputTokens,
      maxOutputTokens:
        body.quota?.maxOutputTokens ??
        current?.quota.maxOutputTokens ??
        EMPTY_QUOTA.maxOutputTokens,
    },
  };

  deps.repos.settings.putModel(next);
  return Promise.resolve({
    kind: "json",
    status: 200,
    body: toModelSettingsView(next),
  });
};

export const handlers: Partial<Record<RouteHandlerKey, HandlerFactory>> = {
  "settings.model.get": getModelSettings,
  "settings.model.put": putModelSettings,
};

export const settingsModule: RouteModule = {
  id: "settings",
  routes,
  handlers,
};
