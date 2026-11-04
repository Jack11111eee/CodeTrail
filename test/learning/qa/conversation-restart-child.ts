/**
 * Child process for the refresh-restore suite.
 *
 * Two phases share one `CODETRAIL_DATA_DIR`:
 *
 * - `first` builds the published generation, runs three real answer turns
 *   (complete, failed/unknown, incomplete), appends a second selection and a
 *   reading position, then serves HTTP.
 * - `second` only serves HTTP — it is a genuinely new process over the same
 *   SQLite file, which is what AC-QA-04 means by a restart.
 *
 * The parent talks to both phases over HTTP and compares the two bodies.
 */

import type { LessonId } from "../../../src/learning/contracts/index.ts";
import {
  sourceHit,
  publishGeneration,
  REPO_ID,
  COMMIT_A,
} from "./qa-helpers.ts";
import { startConversationServer } from "./conversation-server.ts";

export const RESTORE_GENERATION = "g_restore";
export const RESTORE_LESSON = "l_restore";
export const RESTORE_MODULE = "m_restore";
export const RESTORE_FILES = {
  "src/index.ts": "export class SnapshotCache {\n  evict(): void {}\n}\n",
};

function announce(port: number, conversationId: string): void {
  process.stdout.write(`READY ${JSON.stringify({ port, conversationId })}\n`);
}

async function main(): Promise<void> {
  const phase = process.env.CODETRAIL_QA_PHASE ?? "first";
  const scriptDir = process.env.CODETRAIL_QA_SCRIPT_DIR;
  if (scriptDir === undefined || scriptDir === "") {
    throw new Error("CODETRAIL_QA_SCRIPT_DIR is required");
  }

  const server = await startConversationServer({
    scriptDir,
    hits: {
      [RESTORE_GENERATION]: [
        sourceHit(
          RESTORE_GENERATION,
          REPO_ID,
          COMMIT_A,
          "src/index.ts",
          "the snapshot cache evicts entries when the budget is exceeded",
          { start: 1, end: 2 },
        ),
      ],
    },
    filesByGeneration: { [RESTORE_GENERATION]: RESTORE_FILES },
    generationOfCommit: { [COMMIT_A]: RESTORE_GENERATION },
  });

  if (phase === "second") {
    const conversationId = process.env.CODETRAIL_QA_CONVERSATION_ID;
    if (conversationId === undefined || conversationId === "") {
      throw new Error(
        "CODETRAIL_QA_CONVERSATION_ID is required for phase second",
      );
    }
    announce(server.port, conversationId);
    return;
  }

  const fixture = publishGeneration(
    { repos: server.repos },
    {
      generationId: RESTORE_GENERATION,
      sources: [{ path: "src/index.ts", lines: { start: 1, end: 2 } }],
      lessons: [{ lessonId: RESTORE_LESSON, moduleIds: [RESTORE_MODULE] }],
      files: RESTORE_FILES,
    },
  );

  const conversation = await server.conversations.create({
    generationIds: [fixture.generationId],
    moduleId: RESTORE_MODULE,
  });

  const turns = [
    "旧快照为什么会被淘汰？",
    "账本一定记录发票吗？",
    "把预算用尽会怎样？",
  ];
  for (const text of turns) {
    for await (const event of server.answers.answer({
      conversationId: conversation.conversationId,
      text,
      selection: null,
      signal: new AbortController().signal,
    })) {
      void event;
    }
  }

  // A module switch appends a selection without creating a conversation.
  await server.conversations.addSelection(conversation.conversationId, {
    lessonId: RESTORE_LESSON as LessonId,
  });

  // The reader's last position, written by the preferences path in production.
  server.repos.prefs.putReadingPosition({
    generationId: fixture.generationId,
    lessonId: RESTORE_LESSON as LessonId,
    conversationId: conversation.conversationId,
    offset: 42,
    updatedAt: server.clock.now().toISOString(),
  });

  announce(server.port, conversation.conversationId);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `conversation-restart-child failed: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
