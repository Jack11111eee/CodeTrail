import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FIXTURE_NAMES,
  fixtureGit,
  fixtureManifest,
  fixturePath,
  fixtureRemote,
  fixtureSha,
  requireFixtures,
} from "../helpers/git-fixture.ts";

/**
 * Deterministic fixtures (PRD §15.3, architecture §17.4).
 *
 * The script runs twice into the same directory and once into a second one; the
 * three SHA manifests must agree. Each fixture's content is then asserted
 * against the semantic role later suites depend on.
 */

// Restated here rather than imported from the script: the test asserts the
// contract independently, so a change to the generator cannot silently move
// the goalposts.
const FIXTURE_AUTHOR = {
  name: "Codetrail Fixtures",
  email: "fixtures@codetrail.invalid",
};
const FIXTURE_EPOCH = Date.UTC(2024, 0, 1, 0, 0, 0);

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = path.join(REPO_ROOT, "scripts/make-fixtures.mjs");

let outDir: string;
let firstManifest: ReturnType<typeof fixtureManifest>;

function runFixtures(out: string): void {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "--out", out, "--quiet"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  if (result.status !== 0) {
    throw new Error(`fixtures failed: ${result.stdout}\n${result.stderr}`);
  }
}

function read(name: string, relative: string): string {
  return fs.readFileSync(path.join(fixturePath(name), relative), "utf8");
}

beforeAll(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-fixtures-"));
  process.env.CODETRAIL_FIXTURES_DIR = outDir;
  runFixtures(outDir);
  firstManifest = fixtureManifest();
}, 180_000);

afterAll(() => {
  delete process.env.CODETRAIL_FIXTURES_DIR;
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
});

describe("fixture determinism", () => {
  it("emits all ten fixtures under fixtures/", () => {
    expect(Object.keys(firstManifest.fixtures).sort()).toEqual(
      [...FIXTURE_NAMES].sort(),
    );
    for (const name of FIXTURE_NAMES) {
      expect(fs.existsSync(fixturePath(name)), name).toBe(true);
    }
  });

  it("leaves every SHA unchanged on a second run and across output directories", () => {
    runFixtures(outDir);
    const second = fixtureManifest();
    expect(second.fixtures).toEqual(firstManifest.fixtures);

    const other = fs.mkdtempSync(
      path.join(os.tmpdir(), "codetrail-fixtures-b-"),
    );
    try {
      runFixtures(other);
      const previous = process.env.CODETRAIL_FIXTURES_DIR;
      process.env.CODETRAIL_FIXTURES_DIR = other;
      try {
        expect(fixtureManifest().fixtures).toEqual(firstManifest.fixtures);
      } finally {
        process.env.CODETRAIL_FIXTURES_DIR = previous;
      }
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  }, 180_000);

  it("records the fixed metadata and a head/refs entry for every fixture", () => {
    expect(firstManifest.generatedBy).toBe("scripts/make-fixtures.mjs");
    expect(firstManifest.author).toEqual(FIXTURE_AUTHOR);
    expect(new Date(firstManifest.epoch).getTime()).toBe(FIXTURE_EPOCH);
    for (const name of FIXTURE_NAMES) {
      const entry = firstManifest.fixtures[name];
      expect(entry, name).toBeTruthy();
      expect(entry.head, name).toMatch(/^[0-9a-f]{40}$/u);
      expect(entry.bare, name).toBe(name.endsWith(".git"));
      expect(Object.keys(entry.refs).length, name).toBeGreaterThan(0);
      for (const sha of Object.values(entry.refs)) {
        expect(sha, name).toMatch(/^[0-9a-f]{40}$/u);
      }
    }
  });

  it("records the fixed author, committer and dates on every commit", () => {
    const expectedDate = new Date(FIXTURE_EPOCH).toISOString().slice(0, 10);
    for (const name of FIXTURE_NAMES) {
      const log = fixtureGit(name, [
        "log",
        "--all",
        "--format=%an|%ae|%cn|%ce|%aI|%cI",
      ]);
      for (const line of log.split("\n")) {
        const [
          authorName,
          authorEmail,
          committerName,
          committerEmail,
          authorDate,
          committerDate,
        ] = line.split("|");
        expect(authorName, `${name}: ${line}`).toBe(FIXTURE_AUTHOR.name);
        expect(authorEmail, `${name}: ${line}`).toBe(FIXTURE_AUTHOR.email);
        expect(committerName, `${name}: ${line}`).toBe(FIXTURE_AUTHOR.name);
        expect(committerEmail, `${name}: ${line}`).toBe(FIXTURE_AUTHOR.email);
        expect(authorDate.startsWith(expectedDate), `${name}: ${line}`).toBe(
          true,
        );
        expect(committerDate.startsWith(expectedDate), `${name}: ${line}`).toBe(
          true,
        );
      }
    }
  });
});

describe("fixture semantic roles (PRD §15.3)", () => {
  it("last-mile-mini carries the three-layer approval contrast", () => {
    const screens = read("last-mile-mini", "app/screens.py");
    expect(screens).toContain("class Approve");
    expect(screens.toLowerCase()).toContain("evicted");
    expect(read("last-mile-mini", "src/lmp/adapters/mock/server.py")).toMatch(
      /approves? directly|re-validat/iu,
    );
    const decisions = read("last-mile-mini", "docs/decisions/decision-log.md");
    expect(decisions).toContain("D-057");
    expect(decisions).toContain("D-063");
    const cache = read("last-mile-mini", "src/lmp/state/snapshot_cache.py");
    expect(cache).toContain("class SnapshotCache");
    expect(cache).toContain("def evict");
  });

  it("numbering-schema has a format-valid but non-existent object", () => {
    const ids = read("numbering-schema", "schemas/ids.py");
    expect(ids).toContain("^ord_[0-9]{6}$");
    expect(read("numbering-schema", "service/orders.py")).toContain(
      "ord_000042",
    );
    expect(read("numbering-schema", "data/orders.json")).not.toContain(
      "ord_000042",
    );
  });

  it("evolution renames copies to quantity and inventory.ts to stock.ts", () => {
    const first = fixtureGit("evolution", [
      "rev-list",
      "--max-parents=0",
      "HEAD",
    ]);
    expect(
      fixtureGit("evolution", ["show", `${first}:src/inventory.ts`]),
    ).toContain("copies");
    expect(
      fixtureGit("evolution", ["show", `${first}:src/inventory.ts`]),
    ).toContain("legacySku");
    const head = fixtureSha("evolution");
    expect(fixtureGit("evolution", ["show", `${head}:src/stock.ts`])).toContain(
      "quantity",
    );
    expect(
      fixtureGit("evolution", ["show", `${head}:src/stock.ts`]),
    ).not.toContain("legacySku");
    expect(() =>
      fixtureGit("evolution", ["cat-file", "-e", `${head}:src/inventory.ts`]),
    ).toThrow();
    expect(
      fixtureGit("evolution", ["diff", "--name-status", `${first}..${head}`]),
    ).toMatch(/^R\d+\tsrc\/inventory\.ts\tsrc\/stock\.ts$/mu);
    expect(
      fixtureGit("evolution", ["show", `${head}:src/checkout.ts`]),
    ).toContain("./stock.js");
  });

  it("planned-vs-implemented documents a feature the code lacks", () => {
    expect(
      read("planned-vs-implemented", "docs/design/future_upload.md"),
    ).toMatch(/not implemented/iu);
    const code = read("planned-vs-implemented", "src/app/notes.py");
    expect(code.toLowerCase()).not.toContain("upload");
  });

  it("injection-repo carries the payload but never executes it", () => {
    expect(read("injection-repo", "README.md")).toContain(
      "Ignore all previous instructions",
    );
    expect(read("injection-repo", "src/injected.py")).toContain("rm -rf");
    const manifest = JSON.parse(read("injection-repo", "package.json")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts.postinstall).toContain("postinstall-marker.mjs");
    expect(
      fs.existsSync(
        path.join(fixturePath("injection-repo"), "injection-marker.txt"),
      ),
    ).toBe(false);
  });

  it("scope-hygiene contains every excluded artifact plus a canary .env", () => {
    const root = fixturePath("scope-hygiene");
    expect(fs.readFileSync(path.join(root, ".env"), "utf8")).toContain(
      "ct-canary-do-not-leak-0001",
    );
    for (const relative of [
      "node_modules/left-pad/index.js",
      "model.bin",
      "dist/bundle.js",
      ".gitmodules",
      "assets/model.lfs",
      "src/app.py",
    ]) {
      expect(fs.existsSync(path.join(root, relative)), relative).toBe(true);
    }
    expect(
      fs.readFileSync(path.join(root, "assets/model.lfs"), "utf8"),
    ).toContain("version https://git-lfs.github.com/spec/v1");
    expect(fs.readFileSync(path.join(root, ".gitmodules"), "utf8")).toContain(
      '[submodule "vendor"]',
    );
  });

  it("library-noui is a pure library with a public API and tests", () => {
    const root = fixturePath("library-noui");
    expect(read("library-noui", "src/index.ts")).toContain(
      "export function slugify",
    );
    expect(read("library-noui", "src/index.ts")).toContain(
      "export function parseQuery",
    );
    expect(fs.existsSync(path.join(root, "test/index.test.ts"))).toBe(true);
    const uiFiles = fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => /\.(?:tsx|vue|html)$/u.test(name));
    expect(uiFiles).toEqual([]);
  });

  it("polyglot covers python, java, typescript, vue and go", () => {
    const root = fixturePath("polyglot");
    for (const relative of [
      "python/main.py",
      "java/Main.java",
      "ts/app.ts",
      "vue/App.vue",
      "go/main.go",
    ]) {
      expect(fs.existsSync(path.join(root, relative)), relative).toBe(true);
    }
    const vue = read("polyglot", "vue/App.vue");
    expect(vue).toContain("<script");
    expect(vue).toContain("<template>");
    expect(vue).toContain("<style");
  });

  it("local-unpushed derives from evolution and adds local-only work", () => {
    const evolutionHead = fixtureSha("evolution");
    expect(() =>
      fixtureGit("local-unpushed", [
        "merge-base",
        "--is-ancestor",
        evolutionHead,
        "HEAD",
      ]),
    ).not.toThrow();
    expect(fixtureSha("local-unpushed")).not.toBe(evolutionHead);

    const status = fixtureGit("local-unpushed", ["status", "--porcelain"]);
    expect(status).toMatch(/^\s*M src\/stock\.ts$/mu);
    expect(status).toMatch(/^\?\? notes\/$/mu);

    const evolutionCount = Number(
      fixtureGit("evolution", ["rev-list", "--count", "HEAD"]),
    );
    const localCount = Number(
      fixtureGit("local-unpushed", ["rev-list", "--count", "HEAD"]),
    );
    expect(localCount).toBe(evolutionCount + 1);
  });

  it("watch-remote.git is bare and models merge, squash and open-PR branches", () => {
    expect(
      fixtureGit("watch-remote.git", ["rev-parse", "--is-bare-repository"]),
    ).toBe("true");
    const refs = fixtureGit("watch-remote.git", ["show-ref", "--heads"]);
    expect(refs).toContain("refs/heads/main");
    expect(refs).toContain("refs/heads/feature-open");
    expect(refs).toContain("refs/heads/feature-merge");

    const parents = fixtureGit("watch-remote.git", [
      "rev-list",
      "--parents",
      "-n",
      "1",
      "main",
    ]);
    expect(parents.trim().split(/\s+/u)).toHaveLength(3); // commit + two parents

    expect(
      fixtureGit("watch-remote.git", ["log", "--format=%s", "main"]),
    ).toContain("squash-merged");
    expect(() =>
      fixtureGit("watch-remote.git", [
        "merge-base",
        "--is-ancestor",
        "feature-open",
        "main",
      ]),
    ).toThrow();
  });
});

describe("fixture helpers", () => {
  it("exposes a file:// remote URL for each fixture", () => {
    expect(fixtureRemote("evolution")).toMatch(/^file:\/\//u);
    expect(fixtureRemote("evolution")).toContain("evolution");
  });

  it("resolves revisions through fixtureSha", () => {
    expect(fixtureSha("polyglot")).toMatch(/^[0-9a-f]{40}$/u);
    expect(fixtureSha("polyglot", "HEAD")).toBe(fixtureSha("polyglot"));
  });

  it("fails with a runnable hint when the fixtures are missing", () => {
    const empty = fs.mkdtempSync(
      path.join(os.tmpdir(), "codetrail-nofixtures-"),
    );
    const previous = process.env.CODETRAIL_FIXTURES_DIR;
    process.env.CODETRAIL_FIXTURES_DIR = empty;
    try {
      expect(() => fixtureManifest()).toThrow(/pnpm run fixtures/u);
      expect(() => requireFixtures()).toThrow(/pnpm run fixtures/u);
    } finally {
      if (previous === undefined) {
        delete process.env.CODETRAIL_FIXTURES_DIR;
      } else {
        process.env.CODETRAIL_FIXTURES_DIR = previous;
      }
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
