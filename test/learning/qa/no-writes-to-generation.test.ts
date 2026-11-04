import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { repoSourceId } from "../../../src/learning/evidence/index.ts";
import {
  answerEntry,
  cleanupTempDirs,
  collect,
  createHarness,
  publishGeneration,
  scriptDir,
  tempDir,
  toolEntry,
  writeTree,
  COMMIT_A,
} from "./qa-helpers.ts";

/**
 * AC-QA-08: a full answer turn — including a tool call — leaves the published
 * generation byte-identical (recursive sha256 and mtimes) and creates no
 * staging directory.
 */

afterEach(() => {
  cleanupTempDirs();
});

interface TreeState {
  hash: string;
  mtimes: Record<string, number>;
}

function treeState(root: string): TreeState {
  const hash = createHash("sha256");
  const mtimes: Record<string, number> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      const bytes = fs.readFileSync(absolute);
      hash.update(relative).update(bytes);
      mtimes[relative] = fs.statSync(absolute).mtimeMs;
    }
  };
  walk(root);
  return { hash: hash.digest("hex"), mtimes };
}

describe("no writes to a published generation", () => {
  it("keeps the knowledge directory byte-identical through a full turn", async () => {
    const root = tempDir("codetrail-qa-generation-");
    const files = {
      "openwiki/intro.md": "# Intro\nThe ledger records invoices.",
      "lessons/l_1.json": JSON.stringify({
        lessonId: "l_1",
        context: { moduleIds: ["m_ledger"] },
      }),
      "src/index.ts": "export const ledger = 1;\n",
    };
    writeTree(root, files);
    const staging = path.join(root, "staging");

    const sourceId = repoSourceId("src/index.ts", COMMIT_A, null);
    const dir = scriptDir([
      toolEntry([{ name: "read_snapshot_file", args: { path: "src/index.ts" } }], 1),
      answerEntry(
        {
          answer: "账本记录发票。",
          conclusion: "code_fact",
          citations: [{ sourceId }],
        },
        2,
      ),
    ]);
    const harness = createHarness({
      modelDir: dir,
      hits: { g_immutable: [] },
      filesByGeneration: { g_immutable: files },
      generationOfCommit: { [COMMIT_A]: "g_immutable" },
    });
    const fixture = publishGeneration(harness.db, {
      generationId: "g_immutable",
      contentDir: root,
      sources: [{ path: "src/index.ts" }],
      lessons: [{ lessonId: "l_1", relPath: "lessons/l_1.json", moduleIds: ["m_ledger"] }],
    });

    const before = treeState(root);
    try {
      const conversation = await harness.conversations.create({
        generationIds: [fixture.generationId],
        moduleId: "m_ledger",
      });
      const events = await collect(
        harness.answers.answer({
          conversationId: conversation.conversationId,
          text: "账本做什么？",
          selection: { moduleId: "m_ledger" },
          signal: new AbortController().signal,
        }),
      );

      expect(events.at(-1)).toMatchObject({ type: "done", status: "complete" });
      const after = treeState(root);
      expect(after.hash).toBe(before.hash);
      expect(after.mtimes).toEqual(before.mtimes);
      expect(fs.existsSync(staging)).toBe(false);
    } finally {
      harness.db.close();
    }
  });
});
