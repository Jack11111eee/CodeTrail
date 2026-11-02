import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  evidenceSlicesFor,
  isBestEffort,
  splitVueSfc,
} from "../../../src/learning/projects/languages.ts";
import {
  languageOf,
  normalizeScope,
} from "../../../src/learning/projects/scope.ts";
import { fixturePath } from "../helpers/git-fixture.ts";
import { reportForFixture } from "./scope-fixtures.ts";

const POLYGLOT = fixturePath("polyglot");
const APP_VUE = fs.readFileSync(path.join(POLYGLOT, "vue/App.vue"), "utf8");

/**
 * AC-PRJ-17: language labels, Vue SFC block splitting with 1-based content
 * lines, and best-effort marking for every non-preferred language.
 */
describe("languageOf", () => {
  it.each([
    ["python/main.py", "python"],
    ["java/Main.java", "java"],
    ["ts/app.ts", "typescript"],
    ["ui/App.tsx", "typescript"],
    ["ts/module.mts", "typescript"],
    ["js/app.js", "javascript"],
    ["js/app.mjs", "javascript"],
    ["vue/App.vue", "vue"],
    ["go/main.go", "go"],
    ["rb/task.rb", "ruby"],
    ["rs/main.rs", "rust"],
    ["cs/Program.cs", "csharp"],
    ["README.md", "other"],
    ["Dockerfile", "other"],
    ["no-extension", "other"],
  ] as const)("%s ⇒ %s", (file, expected) => {
    expect(languageOf(file)).toBe(expected);
  });

  it("is case-insensitive about the suffix", () => {
    expect(languageOf("Python/MAIN.PY")).toBe("python");
    expect(languageOf("Vue/App.VUE")).toBe("vue");
  });
});

describe("isBestEffort", () => {
  it("is false only for the preferred languages", () => {
    for (const language of [
      "python",
      "java",
      "typescript",
      "javascript",
      "vue",
    ] as const) {
      expect(isBestEffort(language), language).toBe(false);
    }
    for (const language of ["go", "ruby", "rust", "csharp", "other"] as const) {
      expect(isBestEffort(language), language).toBe(true);
    }
  });
});

describe("splitVueSfc", () => {
  it("splits a real SFC into script/template/style with 1-based content lines", () => {
    const blocks = splitVueSfc(APP_VUE);
    expect(blocks).toEqual([
      {
        kind: "script",
        startLine: 2,
        endLine: 2,
        attrs: { setup: "", lang: "ts" },
      },
      { kind: "template", startLine: 6, endLine: 6, attrs: {} },
      { kind: "style", startLine: 10, endLine: 12, attrs: { scoped: "" } },
    ]);
  });

  it("handles CRLF without changing the line numbers", () => {
    const crlf = APP_VUE.replace(/\n/gu, "\r\n");
    expect(splitVueSfc(crlf)).toEqual(splitVueSfc(APP_VUE));
  });

  it("handles a missing trailing newline", () => {
    const withoutTrailing = APP_VUE.replace(/\n$/u, "");
    expect(splitVueSfc(withoutTrailing)).toEqual(splitVueSfc(APP_VUE));
  });

  it("keeps multiple blocks of the same kind in source order", () => {
    const source = [
      "<template>",
      "  <div>{{ x }}</div>",
      "</template>",
      "",
      "<script>",
      "export default {}",
      "</script>",
      "",
      "<style>",
      ".a { color: red; }",
      "</style>",
      "",
      "<style scoped>",
      ".b { color: blue; }",
      "</style>",
    ].join("\n");
    expect(splitVueSfc(source)).toEqual([
      { kind: "template", startLine: 2, endLine: 2, attrs: {} },
      { kind: "script", startLine: 6, endLine: 6, attrs: {} },
      { kind: "style", startLine: 10, endLine: 10, attrs: {} },
      { kind: "style", startLine: 14, endLine: 14, attrs: { scoped: "" } },
    ]);
  });

  it("does not end a template block at a nested template", () => {
    const source = [
      "<template>",
      "  <div>",
      '    <template v-if="ok">',
      "      <span>yes</span>",
      "    </template>",
      "  </div>",
      "</template>",
    ].join("\n");
    expect(splitVueSfc(source)).toEqual([
      { kind: "template", startLine: 2, endLine: 6, attrs: {} },
    ]);
  });

  it("supports same-line and empty blocks", () => {
    expect(splitVueSfc("<script setup>const x = 1;</script>")).toEqual([
      { kind: "script", startLine: 1, endLine: 1, attrs: { setup: "" } },
    ]);
    expect(splitVueSfc("<script></script>")).toEqual([
      { kind: "script", startLine: 1, endLine: 1, attrs: {} },
    ]);
    expect(splitVueSfc("")).toEqual([]);
  });

  it("parses boolean, quoted and unquoted attributes", () => {
    expect(
      splitVueSfc(`<script setup lang='ts' foo=bar>\nx\n</script>`)[0]?.attrs,
    ).toEqual({ setup: "", lang: "ts", foo: "bar" });
  });
});

describe("evidenceSlicesFor", () => {
  it("produces one region per Vue block", () => {
    expect(evidenceSlicesFor("vue/App.vue", APP_VUE)).toEqual([
      {
        path: "vue/App.vue",
        language: "vue",
        region: "script",
        startLine: 2,
        endLine: 2,
        bestEffort: false,
      },
      {
        path: "vue/App.vue",
        language: "vue",
        region: "template",
        startLine: 6,
        endLine: 6,
        bestEffort: false,
      },
      {
        path: "vue/App.vue",
        language: "vue",
        region: "style",
        startLine: 10,
        endLine: 12,
        bestEffort: false,
      },
    ]);
  });

  it("falls back to the whole file for a Vue file with no blocks", () => {
    expect(evidenceSlicesFor("vue/Empty.vue", "")).toEqual([
      {
        path: "vue/Empty.vue",
        language: "vue",
        region: "file",
        startLine: 1,
        endLine: 1,
        bestEffort: false,
      },
    ]);
  });

  it("marks non-preferred languages best-effort", () => {
    const go = fs.readFileSync(path.join(POLYGLOT, "go/main.go"), "utf8");
    expect(evidenceSlicesFor("go/main.go", go)).toEqual([
      {
        path: "go/main.go",
        language: "go",
        region: "file",
        startLine: 1,
        endLine: go.trimEnd().split(/\r?\n/u).length,
        bestEffort: true,
      },
    ]);

    const py = fs.readFileSync(path.join(POLYGLOT, "python/main.py"), "utf8");
    const [slice] = evidenceSlicesFor("python/main.py", py);
    expect(slice).toMatchObject({
      language: "python",
      region: "file",
      bestEffort: false,
    });
    expect(slice.endLine).toBe(py.trimEnd().split(/\r?\n/u).length);
  });

  it("treats an unknown file as best-effort 'other'", () => {
    const [slice] = evidenceSlicesFor("README.md", "one\ntwo\n");
    expect(slice).toEqual({
      path: "README.md",
      language: "other",
      region: "file",
      startLine: 1,
      endLine: 2,
      bestEffort: true,
    });
  });
});

describe("polyglot coverage", () => {
  it("labels every analysed file by language", async () => {
    const { report } = await reportForFixture("polyglot", normalizeScope());
    const languages = new Map(
      report.analyzed.map((entry) => [entry.path, entry.language]),
    );
    expect(languages.get("python/main.py")).toBe("python");
    expect(languages.get("java/Main.java")).toBe("java");
    expect(languages.get("ts/app.ts")).toBe("typescript");
    expect(languages.get("vue/App.vue")).toBe("vue");
    expect(languages.get("go/main.go")).toBe("go");
    expect(languages.get("README.md")).toBe("other");

    const go = report.languages.byLanguage.find(
      (entry) => entry.language === "go",
    );
    expect(go?.bestEffort).toBe(true);
    for (const language of ["python", "java", "typescript", "vue"] as const) {
      expect(
        report.languages.byLanguage.find((entry) => entry.language === language)
          ?.bestEffort,
      ).toBe(false);
    }
  });
});
