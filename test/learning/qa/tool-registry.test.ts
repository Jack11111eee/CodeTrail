import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { LearningError } from "../../../src/learning/contracts/index.ts";
import {
  assertNoWriteTools,
  createQaToolset,
  QA_TOOL_NAMES,
} from "../../../src/learning/qa/tools.ts";
import {
  cleanupTempDirs,
  createQaDb,
  publishGeneration,
  tempDir,
  toolContextFor,
  writeTree,
} from "./qa-helpers.ts";

/**
 * AC-QA-07 / AC-SEC-12: the registry is exactly five read-only tools. There is
 * no write, edit, delete, execute, SQL or shell capability, and no generic URL
 * fetcher — `read_external_doc` only serves an already registered URL.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

afterEach(() => {
  cleanupTempDirs();
});

function readSource(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

describe("the closed tool whitelist", () => {
  it("is exactly the five names, in order", () => {
    expect(QA_TOOL_NAMES).toEqual([
      "search_wiki",
      "read_page",
      "read_snapshot_file",
      "resolve_evidence",
      "read_external_doc",
    ]);
  });

  it("creates a set with the same names and no mutating method", () => {
    const ctx = createQaDb();
    try {
      const fixture = publishGeneration(ctx, {
        generationId: "g_tools",
        files: { "openwiki/intro.md": "# Intro\n\nThe ledger records invoices." },
      });
      const tools = createQaToolset(toolContextFor(ctx, fixture));

      expect(tools.map((tool) => tool.name)).toEqual([...QA_TOOL_NAMES]);
      for (const tool of tools) {
        expect(tool.readOnly).toBe(true);
        expect(typeof tool.run).toBe("function");
        expect(Object.keys(tool).sort()).toEqual([
          "description",
          "name",
          "readOnly",
          "run",
          "schema",
        ]);
        for (const forbidden of [
          "write",
          "edit",
          "delete",
          "execute",
          "exec",
          "sql",
          "shell",
          "fetch",
        ]) {
          expect(
            (tool as unknown as Record<string, unknown>)[forbidden],
            `${tool.name}.${forbidden}`,
          ).toBeUndefined();
        }
      }
    } finally {
      ctx.close();
    }
  });

  it("rejects a mutating or unknown tool with internal_error", () => {
    const capture = (name: string) => {
      try {
        assertNoWriteTools([{ name }]);
      } catch (error) {
        return error;
      }
      return null;
    };

    for (const name of [
      "write_file",
      "edit_file",
      "delete_file",
      "execute_command",
      "run_sql",
      "shell",
      "fetch_url",
      "search",
    ]) {
      const error = capture(name);
      expect(error, name).toBeInstanceOf(LearningError);
      expect((error as LearningError).code, name).toBe("internal_error");
    }
    expect(() =>
      assertNoWriteTools(QA_TOOL_NAMES.map((name) => ({ name }))),
    ).not.toThrow();
  });

  it("rejects a def that is not read-only or exposes a write method", () => {
    const notReadOnly = { name: "read_page", readOnly: false };
    expect(() => assertNoWriteTools([notReadOnly])).toThrowError(LearningError);

    const withWrite = {
      name: "read_page",
      readOnly: true,
      write: () => undefined,
    };
    expect(() => assertNoWriteTools([withWrite])).toThrowError(LearningError);
  });

  it("does not inherit upstream chat tools or any execute surface", () => {
    const tools = readSource("src/learning/qa/tools.ts");
    const answer = readSource("src/learning/qa/answer.ts");
    for (const source of [tools, answer]) {
      expect(source).not.toMatch(/from\s+["']node:child_process["']/u);
      expect(source).not.toMatch(/from\s+["']deepagents["']/u);
      expect(source).not.toMatch(/\.execSync?\(/u);
      expect(source).not.toMatch(/\bspawnSync?\(/u);
    }
    expect(tools).not.toMatch(/writeFileSync|writeFile\(/u);
  });
});

describe("tool behaviour stays read-only and bound", () => {
  it("reads a snapshot file only through the read scope", async () => {
    const ctx = createQaDb();
    try {
      const fixture = publishGeneration(ctx, { generationId: "g_read" });
      const context = toolContextFor(ctx, fixture, {
        "src/index.ts": "export const ledger = 1;\n",
      });
      const tools = new Map(
        createQaToolset(context).map((tool) => [tool.name, tool]),
      );

      const result = await tools.get("read_snapshot_file")!.run(
        { path: "src/index.ts" },
        context,
      );
      expect(result.content).toContain("ledger");
      expect(result.citations).toHaveLength(1);

      await expect(
        tools.get("read_snapshot_file")!.run(
          { path: "../outside.ts" },
          context,
        ),
      ).rejects.toMatchObject({ code: "out_of_scope_path" });
    } finally {
      ctx.close();
    }
  });

  it("serves only an already registered external URL", async () => {
    const ctx = createQaDb();
    try {
      const fixture = publishGeneration(ctx, {
        generationId: "g_external",
        sources: [
          {
            sourceId: "s_external_1",
            kind: "external",
            payload: {
              sourceId: "s_external_1",
              kind: "external",
              canonicalUrl: "https://example.test/design",
              versionOrRetrievedAt: "v1",
              locator: "",
              contentHash: "sha256:" + "1".repeat(64),
              title: "Design",
            },
          },
        ],
      });
      const context = toolContextFor(ctx, fixture);
      const tool = createQaToolset(context).find(
        (entry) => entry.name === "read_external_doc",
      )!;

      await expect(
        tool.run({ url: "https://evil.test/steal" }, context),
      ).rejects.toMatchObject({ code: "invalid_input" });

      await expect(
        tool.run({ url: "https://example.test/design" }, context),
      ).rejects.toMatchObject({ code: "external_source_unavailable" });
    } finally {
      ctx.close();
    }
  });

  it("searches the published knowledge pages without writing them", async () => {
    const ctx = createQaDb();
    try {
      const root = tempDir("codetrail-qa-wiki-");
      writeTree(root, {
        "openwiki/intro.md": "# Intro\nThe snapshot cache evicts entries.",
      });
      const fixture = publishGeneration(ctx, {
        generationId: "g_wiki",
        contentDir: root,
      });
      const context = toolContextFor(ctx, fixture);
      const tool = createQaToolset(context).find(
        (entry) => entry.name === "search_wiki",
      )!;
      const result = await tool.run({ query: "snapshot evicts" }, context);
      expect(result.content).toContain("intro");
      expect(result.citations.length).toBeGreaterThan(0);
    } finally {
      ctx.close();
    }
  });
});
