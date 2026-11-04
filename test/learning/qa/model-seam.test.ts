import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LearningError } from "../../../src/learning/contracts/index.js";
import type {
  ModelHandle,
  ModelSettings,
} from "../../../src/learning/contracts/index.js";
import * as modelModule from "../../../src/learning/config/model.js";
import {
  assertModelConfigured,
  createModelHandle,
  dataSentManifest,
} from "../../../src/learning/config/model.js";

/**
 * AC-API-06 (model half): reads survive without a model, generation jobs fail
 * with `model_not_configured`, and the settings view can state exactly what is
 * sent to the provider. The fixture provider is reached through the dynamic
 * module seam so the production bundle never statically depends on it.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const MODEL_SOURCE = path.join(REPO_ROOT, "src/learning/config/model.ts");

const SETTINGS: ModelSettings = {
  provider: "anthropic",
  model: "claude-test",
  maxOutputTokens: 1024,
  temperature: 0,
  pricing: null,
  quota: {
    maxCalls: 100,
    maxInputTokens: 100_000,
    maxOutputTokens: 20_000,
  },
};

function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

describe("assertModelConfigured", () => {
  it("throws model_not_configured when the handle is absent", () => {
    const error = capture(() => assertModelConfigured(null));
    expect(error).toBeInstanceOf(LearningError);
    const failure = error as LearningError;
    expect(failure.code).toBe("model_not_configured");
    expect(failure.status).toBe(400);
    expect(failure.details?.reason).toBe("no_model");
  });

  it("narrows a present handle", () => {
    const handle: ModelHandle | null = createModelHandle(SETTINGS, {});
    assertModelConfigured(handle);
    expect(handle.modelId).toBe("claude-test");
  });
});

describe("dataSentManifest", () => {
  it("is non-empty, stable and defensive", () => {
    const first = dataSentManifest();
    const second = dataSentManifest();

    expect(first.length).toBeGreaterThan(0);
    expect(
      first.every((entry) => typeof entry === "string" && entry !== ""),
    ).toBe(true);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);

    first.push("mutated");
    expect(dataSentManifest()).not.toContain("mutated");
  });
});

describe("createModelHandle", () => {
  it("lets the environment select the fixture provider and model id", () => {
    const handle = createModelHandle(SETTINGS, {
      CODETRAIL_MODEL_PROVIDER: "fixture",
      CODETRAIL_MODEL_ID: "fixture-model",
    });
    expect(handle.settings.provider).toBe("fixture");
    expect(handle.modelId).toBe("fixture-model");
    expect(typeof handle.chat).toBe("function");
  });

  it("keeps the persisted settings when the environment is silent", () => {
    const handle = createModelHandle(SETTINGS, {});
    expect(handle.settings.provider).toBe("anthropic");
    expect(handle.modelId).toBe("claude-test");
  });

  it("estimates one call and reserves the configured output budget", () => {
    const handle = createModelHandle(SETTINGS, {});
    expect(handle.estimate("lesson", 120)).toEqual({
      calls: 1,
      tokens: 120 + SETTINGS.maxOutputTokens,
    });
    expect(handle.estimate("qa", 0).tokens).toBe(SETTINGS.maxOutputTokens);
  });

  it("rejects an unknown provider with invalid_input", () => {
    const error = capture(() =>
      createModelHandle(SETTINGS, { CODETRAIL_MODEL_PROVIDER: "nope" }),
    );
    expect(error).toBeInstanceOf(LearningError);
    expect((error as LearningError).code).toBe("invalid_input");
  });

  it("requires a fixture directory for the fixture provider", () => {
    const handle = createModelHandle(SETTINGS, {
      CODETRAIL_MODEL_PROVIDER: "fixture",
    });
    const error = capture(() => handle.chat());
    expect(error).toBeInstanceOf(LearningError);
    expect((error as LearningError).code).toBe("invalid_input");
    expect((error as LearningError).details?.field).toBe(
      "CODETRAIL_FIXTURE_DIR",
    );
  });
});

describe("the model seam", () => {
  it("loads the scripted model dynamically, never statically", () => {
    const source = fs.readFileSync(MODEL_SOURCE, "utf8");
    expect(source).toContain("../testing/scripted-model.js");
    expect(source).not.toMatch(
      /from\s+["']\.\.\/testing\/scripted-model\.js["']/u,
    );
    expect(source).toMatch(/createRequire\(import\.meta\.url\)/u);
    expect(Object.keys(modelModule)).toEqual(
      expect.arrayContaining([
        "createModelHandle",
        "assertModelConfigured",
        "dataSentManifest",
      ]),
    );
  });

  it("re-exports contract types instead of redeclaring them", () => {
    const source = fs.readFileSync(MODEL_SOURCE, "utf8");
    for (const name of [
      "ModelSettings",
      "ModelHandle",
      "ModelRole",
      "ChatModelLike",
    ]) {
      expect(source, name).toMatch(
        new RegExp(
          `export\\s+type\\s+\\{[^}]*\\b${name}\\b[^}]*\\}\\s+from\\s+["']\\.\\./contracts/index\\.js["']`,
          "u",
        ),
      );
      expect(source, name).not.toMatch(
        new RegExp(
          `export\\s+(?:interface|class|type|const|function)\\s+${name}\\b`,
          "u",
        ),
      );
    }
  });
});
