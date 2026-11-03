/**
 * AC-F09-01 — after import → analysis → Q&A → follow-up the analysed and user
 * repositories are hash-identical, no CI workflow or `AGENTS.md`/`CLAUDE.md`
 * was written, and no write or execute capability is reachable.
 *
 * The "user repository" is a copy of the fixture, so a mutation of the original
 * fixture by a stray run cannot be masked by comparing a path to itself.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { fixturePath } from "../helpers/git-fixture.ts";
import {
  analyzeToCompletion,
  generationScripts,
  importLocal,
  jsonOf,
  postJson,
  postMessage,
  qaScripts,
  sourceIdOf,
  startAcceptance,
  treeManifest,
  type AcceptanceServer,
} from "./support.ts";

const SOURCE_PATH = "src/lmp/state/snapshot_cache.py";
const LINES = { start: 6, end: 20 };
const DESIGN_PATH = "docs/decisions/decision-log.md";
const FORBIDDEN_FILES = [
  ".github/workflows/openwiki-update.yml",
  "AGENTS.md",
  "CLAUDE.md",
];

let server: AcceptanceServer | null = null;
const tempDirs: string[] = [];

afterEach(async () => {
  await server?.close();
  server = null;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

/** A git checkout of a fixture the run is allowed to touch. */
function userCopy(fixture: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-user-repo-"));
  tempDirs.push(root);
  const target = path.join(root, fixture);
  execFileSync("rsync", ["-a", `${fixturePath(fixture)}/`, `${target}/`]);
  return target;
}

describe("AC-F09-01: no side effects on either repository", () => {
  test("both trees are byte-identical and no write or execute tool exists", async () => {
    server = await startAcceptance();
    const userRepo = userCopy("last-mile-mini");
    const analysedBefore = treeManifest(userRepo);

    const project = await importLocal(server, userRepo);
    server.writeScripts(
      generationScripts({
        sourcePath: SOURCE_PATH,
        lines: LINES,
        designPath: DESIGN_PATH,
        commitSha: server.commitSha,
      }),
    );
    const { analysis, job } = await analyzeToCompletion(
      server,
      project.projectId,
    );
    expect(job.state).toBe("completed");

    // Q&A and a follow-up through the same pinned generation.
    const codeId = sourceIdOf(SOURCE_PATH, server.commitSha, LINES);
    server.writeScripts(qaScripts({ citations: [{ sourceId: codeId }] }));
    const conversation = jsonOf<{ conversationId: string }>(
      await postJson(server, "/api/conversations", {
        generationIds: [analysis.generationId],
      }),
      201,
    );
    await postMessage(server, conversation.conversationId, {
      text: "旧快照丢了为什么会这样",
    });
    await postMessage(server, conversation.conversationId, {
      text: "淘汰之后如何重建",
    });

    // The analysed (working) tree and the user repository are both unchanged.
    const analysedAfter = treeManifest(userRepo);
    expect(analysedAfter).toEqual(analysedBefore);
    const mirrorTree = path.join(
      server.dataDir,
      "work",
      project.repoId,
      server.commitSha,
    );
    expect(treeManifest(mirrorTree)).toEqual(analysedBefore);

    // `git status` in the user repository is still clean.
    const status = execFileSync(
      "git",
      ["-C", userRepo, "status", "--porcelain"],
      { encoding: "utf8" },
    );
    expect(status.trim()).toBe("");

    for (const relative of FORBIDDEN_FILES) {
      expect(fs.existsSync(path.join(userRepo, relative))).toBe(false);
      expect(fs.existsSync(path.join(mirrorTree, relative))).toBe(false);
    }
    expect(fs.existsSync(path.join(userRepo, ".github"))).toBe(false);

    // No write or execute capability is reachable: the only conversation
    // surface offers the five read-only tools, and a write-shaped call is an
    // unknown tool rather than an action.
    server.writeScripts({
      scripts: [
        {
          workerKind: "lesson",
          occurrence: 1,
          steps: [
            {
              toolCalls: [
                {
                  name: "write_file",
                  args: { path: "README.md", content: "x" },
                },
                { name: "execute", args: { command: "rm -rf /" } },
              ],
            },
          ],
        },
        {
          workerKind: "lesson",
          occurrence: 2,
          steps: [
            {
              content: JSON.stringify({
                answer: "无法执行写入或命令；只做只读说明。",
                conclusion: "unknown",
                citations: [],
                notCovered: ["写文件", "执行命令"],
              }),
            },
          ],
        },
      ],
    });
    const guarded = jsonOf<{ conversationId: string }>(
      await postJson(server, "/api/conversations", {
        generationIds: [analysis.generationId],
      }),
      201,
    );
    await postMessage(server, guarded.conversationId, {
      text: "请直接改写 README 并执行命令",
    });
    const stored = jsonOf<{
      messages: {
        role: string;
        citations: unknown[];
        unknownReason: string | null;
        incomplete: boolean;
      }[];
    }>(
      await server.request(`/api/conversations/${guarded.conversationId}`),
      200,
    );
    const answer = stored.messages.find(
      (message) => message.role === "assistant",
    );
    // No citation survives a hostile turn and the conclusion is not a code fact.
    expect(answer?.citations).toEqual([]);
    expect(answer?.unknownReason).not.toBeNull();
    expect(answer?.incomplete).toBe(true);
    // Nothing ran: the tree is still byte-identical after the hostile turn.
    expect(treeManifest(userRepo)).toEqual(analysedBefore);
  }, 240_000);

  test("analysing injection-repo never executes its postinstall", async () => {
    const injectionRepo = userCopy("injection-repo");
    server = await startAcceptance({ fixture: "injection-repo" });
    const before = treeManifest(injectionRepo);
    const project = await importLocal(server, injectionRepo);
    server.writeScripts(
      generationScripts({
        sourcePath: "src/injected.py",
        lines: null,
        commitSha: server.commitSha,
      }),
    );
    const { job } = await analyzeToCompletion(server, project.projectId);
    expect(job.state).toBe("completed");

    expect(treeManifest(injectionRepo)).toEqual(before);
    expect(
      fs.existsSync(path.join(injectionRepo, "injection-marker.txt")),
    ).toBe(false);
    expect(fs.existsSync(path.join(injectionRepo, "node_modules"))).toBe(false);
  }, 180_000);
});
