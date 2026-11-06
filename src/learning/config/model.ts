/**
 * The model seam (architecture §4.4).
 *
 * `ModelSettings`, `ModelHandle`, `ModelRole` and `ChatModelLike` are declared
 * in `contracts/` and re-exported here — this module adds behaviour only.
 *
 * The handle is created synchronously, so the concrete model is loaded on the
 * first `chat()` call. Provider modules are loaded through `createRequire`
 * rather than a static `import`, which keeps the scripted model (and the heavy
 * provider SDKs) out of the module graph until a handle is actually used.
 */

import { createRequire } from "node:module";

import { LearningError } from "../contracts/index.js";
import type {
  ChatModelLike,
  ModelHandle,
  ModelRole,
  ModelSettings,
} from "../contracts/index.js";
import { PROMPT_TEMPLATE_VERSION } from "./defaults.js";
import { normalizeModelBaseUrl } from "./model-url.js";

export type {
  ChatModelLike,
  ModelHandle,
  ModelRole,
  ModelSettings,
} from "../contracts/index.js";

/** Provider id used for deterministic tests; its module lives in `testing/`. */
export const FIXTURE_PROVIDER = "fixture";
export const ANTHROPIC_PROVIDER = "anthropic";

/**
 * What leaves the machine when the model is called. `GET /api/settings/model`
 * returns this verbatim so the UI can show it next to the provider and model id.
 */
const DATA_SENT_MANIFEST: readonly string[] = Object.freeze([
  "the repository file contents selected by the configured read scope",
  "file paths, line ranges and commit SHAs cited as evidence",
  "the learner's question text and any lesson passage they selected",
  "learner preferences: explanation level, language and stated background",
  "the pinned prompt templates identified by the prompt-template version",
  "earlier messages of the current conversation",
]);

/** A fresh copy of the stable manifest; callers cannot mutate the shared list. */
export function dataSentManifest(): string[] {
  return [...DATA_SENT_MANIFEST];
}

interface ScriptedModelOptionsLike {
  dir: string;
  role: ModelRole;
  promptTemplateVersion: string;
}

interface ScriptedModelModuleLike {
  createScriptedModel(options: ScriptedModelOptionsLike): ChatModelLike;
}

interface ProviderModuleLike {
  ChatAnthropic: new (fields: Record<string, unknown>) => ChatModelLike;
}

interface ModelTransportOptions {
  maxRetries?: number;
  timeout?: number;
}

const nodeRequire = createRequire(import.meta.url);

function loadModule<T>(specifier: string): T {
  try {
    return nodeRequire(specifier) as T;
  } catch (error) {
    throw new LearningError(
      "internal_error",
      `unable to load model provider module: ${specifier}`,
      {
        module: specifier,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

const SUPPORTED_PROVIDERS: ReadonlySet<string> = new Set([
  FIXTURE_PROVIDER,
  ANTHROPIC_PROVIDER,
]);

function resolveProvider(
  settings: ModelSettings,
  env: NodeJS.ProcessEnv,
): string {
  const configured = env.CODETRAIL_MODEL_PROVIDER?.trim();
  const provider =
    configured && configured !== "" ? configured : settings.provider.trim();
  if (provider === "") {
    throw new LearningError(
      "invalid_input",
      "model provider is not configured",
      {
        field: "provider",
      },
    );
  }
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new LearningError(
      "invalid_input",
      `unknown model provider: ${provider}`,
      { field: "provider", provider },
    );
  }
  return provider;
}

function createFixtureModel(env: NodeJS.ProcessEnv): ChatModelLike {
  const dir = env.CODETRAIL_FIXTURE_DIR?.trim();
  if (dir === undefined || dir === "") {
    throw new LearningError(
      "invalid_input",
      "CODETRAIL_FIXTURE_DIR is required for the fixture provider",
      { field: "CODETRAIL_FIXTURE_DIR" },
    );
  }
  const module = loadModule<ScriptedModelModuleLike>(
    "../testing/scripted-model.js",
  );
  return module.createScriptedModel({
    dir,
    role: "lesson",
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
  });
}

function createAnthropicModel(
  settings: ModelSettings,
  apiKey?: string,
  transport?: ModelTransportOptions,
): ChatModelLike {
  const module = loadModule<ProviderModuleLike>("@langchain/anthropic");
  return new module.ChatAnthropic({
    model: settings.model,
    anthropicApiUrl: settings.baseUrl ?? "https://api.anthropic.com",
    ...(apiKey ? { apiKey } : {}),
    // Retry pages at durable boundaries, rather than hiding repeated multi-minute
    // transport retries inside every model call.
    maxRetries: transport?.maxRetries ?? 0,
    clientOptions: { timeout: transport?.timeout ?? 60_000 },
    temperature: settings.temperature,
    maxTokens: settings.maxOutputTokens,
  });
}

function createChatModel(
  provider: string,
  settings: ModelSettings,
  env: NodeJS.ProcessEnv,
  apiKey?: string,
  transport?: ModelTransportOptions,
): ChatModelLike {
  switch (provider) {
    case FIXTURE_PROVIDER:
      return createFixtureModel(env);
    case ANTHROPIC_PROVIDER:
      return createAnthropicModel(settings, apiKey, transport);
    default:
      throw new LearningError(
        "invalid_input",
        `unknown model provider: ${provider}`,
        { field: "provider", provider },
      );
  }
}

/**
 * Builds the handle the composition root stores in `AppDeps.model`.
 *
 * `CODETRAIL_MODEL_PROVIDER` / `CODETRAIL_MODEL_ID` override the persisted
 * settings, which is how tests select the scripted model without touching the
 * database.
 */
export function createModelHandle(
  settings: ModelSettings,
  env: NodeJS.ProcessEnv,
  apiKey?: string,
  transport?: ModelTransportOptions,
): ModelHandle {
  const provider = resolveProvider(settings, env);
  const overrideModelId = env.CODETRAIL_MODEL_ID?.trim();
  const modelId =
    overrideModelId !== undefined && overrideModelId !== ""
      ? overrideModelId
      : settings.model;
  const baseUrl =
    normalizeModelBaseUrl(settings.baseUrl) ??
    normalizeModelBaseUrl(env.ANTHROPIC_API_URL || env.ANTHROPIC_BASE_URL);
  const effective: ModelSettings = {
    ...settings,
    provider,
    model: modelId,
    ...(baseUrl ? { baseUrl } : {}),
  };
  return {
    modelId,
    settings: effective,
    chat: () => createChatModel(provider, effective, env, apiKey, transport),
    estimate: (_role: ModelRole, promptTokens: number) => ({
      calls: 1,
      tokens: Math.max(0, Math.trunc(promptTokens)) + settings.maxOutputTokens,
    }),
  };
}

/**
 * The seam AC-API-06 turns on: reads keep working without a model, while a new
 * generation job fails with `model_not_configured`.
 */
export function assertModelConfigured(
  handle: ModelHandle | null,
): asserts handle is ModelHandle {
  if (!handle) {
    throw new LearningError("model_not_configured", "model is not configured", {
      reason: "no_model",
    });
  }
}
