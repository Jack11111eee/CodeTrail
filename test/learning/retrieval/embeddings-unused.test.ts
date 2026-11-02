import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createSemanticIndexRegistry,
  semanticIndexes,
} from "../../../src/learning/retrieval/embeddings.js";
import type { SemanticIndexExtension } from "../../../src/learning/retrieval/embeddings.js";

/**
 * AC-RET-09: the semantic index is an interface plus an empty registry. No
 * implementation is instantiated, `active()` is always `null`, no embedding
 * library is imported and nothing reaches the network.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SOURCE = path.join(
  REPO_ROOT,
  "src/learning/retrieval/embeddings.ts",
);
const PACKAGE_JSON = path.join(REPO_ROOT, "package.json");

const EXTENSION: SemanticIndexExtension = {
  id: "test-extension",
  index(): Promise<void> {
    return Promise.resolve();
  },
  query(): Promise<{ id: string; score: number }[]> {
    return Promise.resolve([]);
  },
};

describe("SemanticIndexRegistry", () => {
  it("has no active implementation", () => {
    expect(semanticIndexes.active()).toBeNull();
  });

  it("stays empty even after a registration", () => {
    const registry = createSemanticIndexRegistry();
    registry.register(EXTENSION);
    expect(registry.active()).toBeNull();

    semanticIndexes.register(EXTENSION);
    expect(semanticIndexes.active()).toBeNull();
  });
});

describe("no embedding implementation leaks in", () => {
  it("imports nothing but the contract types and makes no network call", () => {
    const source = fs.readFileSync(SOURCE, "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map(
      (match) => match[1],
    );
    expect(imports).toEqual(["../contracts/index.js"]);
    expect(source).not.toMatch(/\bfetch\s*\(/u);
    expect(source).not.toMatch(/node:https?/u);
    expect(source).not.toMatch(/\brequire\s*\(/u);
    expect(source).not.toMatch(/\bimport\s*\(/u);
  });

  it("declares no embedding dependency in package.json", () => {
    const manifest = JSON.parse(
      fs.readFileSync(PACKAGE_JSON, "utf8"),
    ) as Record<string, Record<string, string> | undefined>;
    const names = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ];
    const forbidden = [
      "@xenova/transformers",
      "@huggingface/transformers",
      "faiss-node",
      "hnswlib-node",
      "chromadb",
      "voyageai",
      "cohere-ai",
      "tensorflow",
      "@tensorflow/tfjs-node",
      "onnxruntime-node",
    ];
    for (const dependency of forbidden) {
      expect(names, dependency).not.toContain(dependency);
    }
  });
});
