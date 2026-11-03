import { spawn } from "node:child_process";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { repoSourceId } from "../../../src/learning/evidence/registry.ts";
import type { ConversationView } from "../../../src/learning/contracts/index.ts";
import { startHarness } from "../helpers/http-client.ts";
import type { Harness } from "../helpers/http-client.ts";
import {
  answerEntry,
  cleanupTempDirs,
  scriptDir,
  COMMIT_A,
} from "./qa-helpers.ts";

/**
 * AC-QA-04: a **real process restart** over the same `CODETRAIL_DATA_DIR`
 * returns the identical conversation — the message sequence with
 * `answerPhase`, `unknownReason` and `incomplete` verbatim, the same
 * selections, the same generation binding and the reading position.
 *
 * The server under test is a child process. The parent only speaks HTTP, so
 * nothing can be restored from a cache in this process: phase `second` reads
 * the SQLite file the OS kept after `SIGKILL`.
 */

interface ChildHandle {
  port: number;
  conversationId: string;
  url: string;
  child: ReturnType<typeof spawn>;
  exited: Promise<void>;
}

const children: ChildHandle[] = [];

/** Three turns: cited/complete, uncited/failed, incomplete. */
function buildScripts(): string {
  const citationSource = repoSourceId("src/index.ts", COMMIT_A, {
    start: 1,
    end: 2,
  });
  return scriptDir([
    answerEntry(
      {
        answer: "旧快照会被淘汰，因为缓存超过了预算上限。",
        conclusion: "code_fact",
        citations: [{ sourceId: citationSource }],
      },
      1,
    ),
    answerEntry(
      {
        answer: "账本一定记录发票。",
        conclusion: "code_fact",
        citations: [],
      },
      2,
    ),
    answerEntry(
      {
        answer: "预算用尽后只能依据已有资料作答。",
        conclusion: "engineering_analysis",
        citations: [],
        notCovered: ["src/unread.ts"],
      },
      3,
    ),
  ]);
}

function runChild(
  phase: "first" | "second",
  scripts: string,
  conversationId = "",
): Promise<ChildHandle> {
  const childPath = path.join(
    import.meta.dirname,
    "conversation-restart-child.ts",
  );
  const tsxPath = path.join(
    process.cwd(),
    "node_modules",
    "tsx",
    "dist",
    "cli.mjs",
  );
  const child = spawn(process.execPath, [tsxPath, childPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODETRAIL_QA_PHASE: phase,
      CODETRAIL_QA_SCRIPT_DIR: scripts,
      CODETRAIL_QA_CONVERSATION_ID: conversationId,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  // `exitCode` stays null for a signal-killed child; the event is the only
  // reliable "the process is gone" signal.
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

  return new Promise<ChildHandle>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `restart child did not become ready in time\nstderr:\n${stderr}\nstdout:\n${stdout}`,
        ),
      );
    }, 20_000);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      for (const line of stdout.split("\n")) {
        if (!line.startsWith("READY ")) continue;
        const parsed = JSON.parse(line.slice("READY ".length)) as {
          port: number;
          conversationId: string;
        };
        clearTimeout(timer);
        const handle: ChildHandle = {
          port: parsed.port,
          conversationId: parsed.conversationId,
          url: `http://127.0.0.1:${String(parsed.port)}`,
          child,
          exited,
        };
        children.push(handle);
        resolve(handle);
        return;
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `restart child exited (${String(code)})\nstderr:\n${stderr}\nstdout:\n${stdout}`,
        ),
      );
    });
  });
}

async function stop(handle: ChildHandle): Promise<void> {
  if (handle.child.exitCode === null && handle.child.signalCode === null) {
    handle.child.kill("SIGKILL");
  }
  await handle.exited;
}

async function getConversation(
  harness: Harness,
  conversationId: string,
): Promise<ConversationView> {
  const response = await harness.request(
    `/api/conversations/${encodeURIComponent(conversationId)}`,
  );
  expect(response.status).toBe(200);
  return response.json as ConversationView;
}

afterEach(async () => {
  for (const handle of children.splice(0)) {
    await stop(handle);
  }
  cleanupTempDirs();
});

describe("conversation restore after a real process restart", () => {
  it("returns the identical messages, selections, binding and reading position", async () => {
    const citationSource = repoSourceId("src/index.ts", COMMIT_A, {
      start: 1,
      end: 2,
    });
    const scripts = buildScripts();

    const first = await runChild("first", scripts);
    const beforeHarness = await startHarness({ baseUrl: first.url });
    const before = await getConversation(beforeHarness, first.conversationId);

    // The three turns produced a complete answer, a failed/unknown one and an
    // incomplete one — exactly the state a restart must preserve verbatim.
    expect(before.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    const assistants = before.messages.filter(
      (message) => message.role === "assistant",
    );
    expect(assistants[0]).toMatchObject({
      status: "complete",
      answerPhase: "complete",
      unknownReason: null,
      incomplete: false,
    });
    expect(assistants[0].citations).toHaveLength(1);
    expect(assistants[0].citations[0]).toMatchObject({
      sourceId: citationSource,
      availability: "available",
    });
    expect(assistants[1]).toMatchObject({
      status: "failed",
      answerPhase: "failed",
      unknownReason: "uncited_conclusion",
      incomplete: false,
    });
    expect(assistants[2]).toMatchObject({
      status: "failed",
      unknownReason: "uncited_conclusion",
      incomplete: true,
    });
    expect(before.generationIds).toEqual(["g_restore"]);
    expect(before.selections.map((selection) => selection.moduleId)).toEqual([
      "m_restore",
      null,
    ]);
    expect(before.selections[1].lessonId).toBe("l_restore");
    expect(before.readingPosition).toMatchObject({
      lessonId: "l_restore",
      offset: 42,
    });

    // Kill the process; phase `second` is a new process over the same data dir.
    await stop(first);
    const second = await runChild("second", scripts, first.conversationId);
    const afterHarness = await startHarness({ baseUrl: second.url });
    const after = await getConversation(afterHarness, second.conversationId);

    expect(after).toEqual(before);
    expect(after.conversationId).toBe(first.conversationId);
    expect(after.generationIds).toEqual(["g_restore"]);
    expect(after.readingPosition?.offset).toBe(42);
  }, 60_000);

  it("serves the same message pages after a restart", async () => {
    const scripts = buildScripts();
    const first = await runChild("first", scripts);
    const beforeHarness = await startHarness({ baseUrl: first.url });

    const newest = await beforeHarness.request(
      `/api/conversations/${encodeURIComponent(first.conversationId)}/messages?limit=2`,
    );
    expect(newest.status).toBe(200);
    const page = newest.json as {
      messages: { messageId: string }[];
      nextBefore: string | null;
    };
    expect(page.messages).toHaveLength(2);
    expect(page.nextBefore).not.toBeNull();

    await stop(first);
    const second = await runChild("second", scripts, first.conversationId);
    const afterHarness = await startHarness({ baseUrl: second.url });

    const older = await afterHarness.request(
      `/api/conversations/${encodeURIComponent(first.conversationId)}/messages?limit=2&before=${encodeURIComponent(page.nextBefore!)}`,
    );
    expect(older.status).toBe(200);
    const olderPage = older.json as { messages: { messageId: string }[] };
    expect(olderPage.messages.length).toBeGreaterThan(0);
    const newestIds = new Set(page.messages.map((entry) => entry.messageId));
    for (const message of olderPage.messages) {
      expect(newestIds.has(message.messageId)).toBe(false);
    }
  });
});
