import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { sourceIdOf } from "../../../src/learning/contracts/index.ts";
import type { GenerationId } from "../../../src/learning/contracts/index.ts";
import { readWikiCitation } from "../../../src/learning/qa/wiki-citation.ts";
import { repoSourceId } from "../../../src/learning/evidence/registry.ts";
import { createQaToolset } from "../../../src/learning/qa/tools.ts";
import {
  cleanupTempDirs,
  createHarness,
  scriptDir,
  toolEntry,
  answerEntry,
  collect,
  createQaDb,
  publishGeneration,
  toolContextFor,
  tempDir,
} from "./qa-helpers.ts";
afterEach(cleanupTempDirs);
it("removes document-local alias metadata from page reads and gives the answer a usable canonical wiki citation", async () => {
  const db = createQaDb();
  try {
    const fixture = publishGeneration(db, {
      generationId: "g_wiki_alias",
      files: {
        "openwiki/concepts/splits.md":
          "---\ntitle: 分块\nsources:\n  - id: openwiki-source-old\n    resource: repo://src/splits.ts\n---\n# Splits\n\nData separation prevents leakage.\n## Training\n\nTrain on the training block.\n## Training\n\nDuplicate heading.\n",
      },
    });
    const ctx = toolContextFor(db, fixture);
    const result = await createQaToolset(ctx)
      .find((t) => t.name === "read_page")!
      .run({ page: "concepts/splits" }, ctx);
    expect(result.content).not.toContain("openwiki-source-old");
    expect(result.content).toContain("prevents leakage");
    expect(
      readWikiCitation(
        fixture.contentDir,
        fixture.generationId,
        result.citations[0],
      ),
    ).toMatchObject({
      label: "openwiki/concepts/splits.md",
      content: result.content,
    });
    const sectionId = sourceIdOf(
      "repo",
      `wiki\0${fixture.generationId}\0openwiki/concepts/splits.md\0training-1`,
    );
    expect(
      readWikiCitation(fixture.contentDir, fixture.generationId, sectionId)
        ?.label,
    ).toBe("openwiki/concepts/splits.md#training-1");
    expect(
      readWikiCitation(
        fixture.contentDir,
        "g_foreign" as GenerationId,
        result.citations[0],
      ),
    ).toBeNull();
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, "secret.md"), "# Secret");
    fs.symlinkSync(
      path.join(outside, "secret.md"),
      path.join(fixture.contentDir, "openwiki", "escape.md"),
    );
    expect(
      readWikiCitation(
        fixture.contentDir,
        fixture.generationId,
        sourceIdOf("repo", `wiki\0${fixture.generationId}\0escape\0`),
      ),
    ).toBeNull();
  } finally {
    db.close();
  }
});

it("keeps newly read snapshot ranges addressable without modifying sealed knowledge", async () => {
  const sourceId = repoSourceId("src/read.ts", "a".repeat(40), {
    start: 2,
    end: 2,
  });
  const files = { "src/read.ts": "// first\nexport const value=1;\n" };
  const h = createHarness({
    modelDir: scriptDir([
      toolEntry([
        {
          name: "read_snapshot_file",
          args: { path: "src/read.ts", lines: { start: 2, end: 2 } },
        },
      ]),
      answerEntry(
        {
          answer: "这个值为 1。",
          conclusion: "code_fact",
          citations: [{ sourceId }],
        },
        2,
      ),
    ]),
    filesByGeneration: { g_new_read: files },
    generationOfCommit: { ["a".repeat(40)]: "g_new_read" },
  });
  try {
    const fixture = publishGeneration(h.db, {
      generationId: "g_new_read",
      sources: [],
      files,
    });
    const c = await h.conversations.create({
      generationIds: [fixture.generationId],
    });
    expect(h.db.repos.sources.get(fixture.generationId, sourceId)).toBeNull();
    const events = await collect(
      h.answers.answer({
        conversationId: c.conversationId,
        text: "这个值是多少？",
        selection: null,
        signal: new AbortController().signal,
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: "done", status: "complete" });
    const row = h.db.repos.sources.get(fixture.generationId, sourceId)!;
    expect(JSON.parse(row.payloadJson)).toMatchObject({
      path: "src/read.ts",
      lines: { start: 2, end: 2 },
      commitSha: fixture.commitSha,
    });
  } finally {
    h.db.close();
  }
});
