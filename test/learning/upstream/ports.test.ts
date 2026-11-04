import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type {
  GenerationId,
  PublishedWikiRef,
  StagedWikiRef,
} from "../../../src/learning/contracts/index.js";
import { createUpstreamClaimsPort } from "../../../src/learning/upstream/claims.js";
import {
  createUpstreamRetrievalPort,
  splitWikiRef,
} from "../../../src/learning/upstream/retrieval.js";

/**
 * Read/build port conversions (architecture §6.3).
 *
 * The adapter owns every upstream shape: search refs (`openwiki/x.md#anchor`)
 * become `{page, anchor}` pairs, claims become `ClaimView`s with the opaque
 * evidence version preserved verbatim, and only a published ref reaches the
 * read-side retrieval port.
 */

const temporaryDirectories: string[] = [];

async function wikiFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "codetrail-ports-"));
  temporaryDirectories.push(root);
  const wiki = path.join(root, "openwiki");
  await mkdir(path.join(wiki, ".claims"), { recursive: true });
  const markdown =
    "---\ntype: Guide\ntitle: Cache Guide\n---\n\n# Cache Guide\n\nIntro.\n\n" +
    "## Cache strategy\n\nUse a bounded cache.\n";
  await writeFile(path.join(wiki, "guide.md"), markdown, "utf8");
  await writeFile(
    path.join(wiki, ".claims", "guide.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      pageVersion: `sha256:${createHash("sha256").update(markdown).digest("hex")}`,
      claims: [
        {
          id: "c_cache",
          statement: "The cache is bounded.",
          evidence: [
            { resource: "repo://src/cache.ts#L1-L5", version: "sha256:abc" },
          ],
        },
      ],
    })}\n`,
    "utf8",
  );
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("splitWikiRef", () => {
  test.each([
    { ref: "/openwiki/x.md#anchor", page: "openwiki/x.md", anchor: "anchor" },
    { ref: "/openwiki/x.md", page: "openwiki/x.md", anchor: "" },
    { ref: "openwiki/x.md#a#b", page: "openwiki/x.md", anchor: "a#b" },
  ])("splits $ref on the first #", ({ ref, page, anchor }) => {
    expect(splitWikiRef(ref)).toEqual({ page, anchor });
  });
});

describe("claims port", () => {
  const stagedRef = (knowledgeDir: string): StagedWikiRef => ({
    state: "staged",
    generationId: `g_${randomUUID().replace(/-/gu, "")}` as GenerationId,
    commitSha: "0".repeat(40),
    knowledgeDir,
  });

  test("discovers pages and converts evidence without interpreting versions", async () => {
    const knowledgeDir = await wikiFixture();
    const port = createUpstreamClaimsPort();
    const ref = stagedRef(knowledgeDir);

    await expect(port.pages(ref)).resolves.toEqual(["/openwiki/guide.md"]);
    await expect(port.claimsFor(ref, "/openwiki/guide.md")).resolves.toEqual([
      {
        id: "c_cache",
        statement: "The cache is bounded.",
        evidence: [
          { resource: "repo://src/cache.ts#L1-L5", version: "sha256:abc" },
        ],
      },
    ]);
    await expect(port.markdown(ref, "/openwiki/guide.md")).resolves.toContain(
      "## Cache strategy",
    );
  });

  test("returns an empty claim list for a page without a sidecar", async () => {
    const knowledgeDir = await wikiFixture();
    const port = createUpstreamClaimsPort();

    await expect(
      port.claimsFor(stagedRef(knowledgeDir), "/openwiki/missing.md"),
    ).resolves.toEqual([]);
  });
});

describe("retrieval port", () => {
  const publishedRef = (knowledgeDir: string): PublishedWikiRef => ({
    state: "published",
    generationId: `g_${randomUUID().replace(/-/gu, "")}` as GenerationId,
    commitSha: "0".repeat(40),
    knowledgeDir,
    sealedTreeHash: `sha256:${"0".repeat(64)}`,
  });

  test("maps search refs, anchors and frontmatter titles", async () => {
    const knowledgeDir = await wikiFixture();
    const port = createUpstreamRetrievalPort();
    const hits = await port.search(publishedRef(knowledgeDir), "cache");

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({
      page: "openwiki/guide.md",
      title: "Cache Guide",
    });
    expect(hits[0]?.anchor.length).toBeGreaterThan(0);
    expect(hits[0]?.preview.length).toBeGreaterThan(0);
  });

  test("reads the requested sections and the page title", async () => {
    const knowledgeDir = await wikiFixture();
    const port = createUpstreamRetrievalPort();
    const ref = publishedRef(knowledgeDir);

    await expect(port.pageTitle(ref, "/openwiki/guide.md")).resolves.toBe(
      "Cache Guide",
    );
    const sections = await port.readSections(ref, "/openwiki/guide.md", [
      "cache-strategy",
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      page: "openwiki/guide.md",
      anchor: "cache-strategy",
    });
    expect(sections[0]?.content).toContain("Use a bounded cache.");
  });
});
