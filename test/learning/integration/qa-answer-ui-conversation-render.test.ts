import { afterEach, describe, expect, it } from "vitest";

import type {
  AnswerEvent,
  AppDeps,
  MessageRecord,
} from "../../../src/learning/contracts/index.ts";
import { newMessageId } from "../../../src/learning/contracts/index.ts";
import { resolveDataPaths } from "../../../src/learning/config/paths.ts";
import { toConversationView } from "../../../src/learning/qa/conversations.ts";
import { summarizeMessages } from "../../../src/learning/qa/summarize.ts";
import {
  createRepositories,
  openDatabase,
} from "../../../src/learning/store/index.ts";
import {
  answerEntry,
  cleanupTempDirs,
  createHarness,
  publishGeneration,
  scriptDir,
  sourceHit,
  AT,
  COMMIT_A,
  REPO_ID,
  type GenerationFixture,
  type Harness as QaHarness,
} from "../qa/qa-helpers.ts";
import {
  countTestId,
  startUiServer,
  uiDepsFrom,
} from "./merge-ui-server.ts";
import type { UiServer } from "./merge-ui-server.ts";

/**
 * Integration: the qa branch's real streaming answer service persists its
 * messages, and the ui branch's static seam + reader page render that
 * conversation back.
 *
 * The revision-3 blocking defect lived exactly here: `answer_phase`,
 * `unknown_reason` and `incomplete` were added to the messages table so a
 * restart could restore what the streaming turn knew. `api/static.ts` builds
 * its own `ConversationView` from the repositories instead of calling
 * `qa/conversations.ts#toConversationView`, so this suite pins the two
 * mappings together against a real DB, and checks that assistant markdown
 * still goes through the merged sanitiser.
 */

const GENERATION_ID = "g_level8_qa";
const LESSON_ID = "l_level8_qa";
const FILES = {
  "src/index.ts": "export class SnapshotCache {\n  evict(): void {}\n}\n",
};

function readerLessonJson(sourceId: string): string {
  return JSON.stringify({
    lessonId: LESSON_ID,
    generationId: GENERATION_ID,
    kind: "research",
    context: {
      repoId: REPO_ID,
      commitSha: COMMIT_A,
      generationId: GENERATION_ID,
      scenarioId: "sc_qa_flow",
      moduleIds: ["src"],
    },
    scenario: {
      id: "sc_qa_flow",
      kind: "library_interface",
      inputs: ["budget"],
      userAction: "把预算用尽",
      observableResult: "缓存淘汰条目",
      isExample: true,
    },
    overview: [],
    plainExplanation: [],
    technicalExplanation: [],
    choices: [],
    choicesOmittedReason: null,
    boundaries: [],
    statements: [],
    evidence: [sourceId],
    diagram: { kind: "component", mermaid: "flowchart LR", nodes: [], edges: [] },
    coverageGaps: [],
    checks: { structural: "pass", evidence: "pass", semantic: "pass" },
  });
}

interface QaScenario {
  harness: QaHarness;
  fixture: GenerationFixture;
  sourceId: string;
  conversationId: string;
}

function buildScenario(): QaScenario {
  const hit = sourceHit(
    GENERATION_ID,
    REPO_ID,
    COMMIT_A,
    "src/index.ts",
    "the snapshot cache evicts entries when the budget is exceeded",
    { start: 1, end: 2 },
  );
  // `hitSourceId` is the id a citation uses; the model is scripted to cite it.
  const sourceId = "s_level8_citation";
  const dir = scriptDir([
    answerEntry(
      {
        answer:
          "旧快照会被淘汰。\n\n<script>alert(1)</script>\n\n[坏链接](javascript:alert(1))",
        conclusion: "code_fact",
        citations: [{ sourceId: sourceId }],
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
        answer: "这是一段很长的回答。".repeat(20),
        conclusion: "engineering_analysis",
        citations: [],
      },
      3,
    ),
  ]);
  const harness = createHarness({
    modelDir: dir,
    hits: { [GENERATION_ID]: [hit] },
    filesByGeneration: { [GENERATION_ID]: FILES },
    generationOfCommit: { [COMMIT_A]: GENERATION_ID },
  });
  const fixture = publishGeneration(harness.db, {
    generationId: GENERATION_ID,
    sources: [{ sourceId, path: "src/index.ts", lines: { start: 1, end: 2 } }],
    lessons: [{ lessonId: LESSON_ID }],
    files: { [`lessons/${LESSON_ID}.json`]: readerLessonJson(sourceId) },
  });
  return { harness, fixture, sourceId, conversationId: "" };
}

async function runAnswer(
  scenario: QaScenario,
  text: string,
  abortAfterFirstDelta = false,
): Promise<AnswerEvent[]> {
  const controller = new AbortController();
  const events: AnswerEvent[] = [];
  for await (const event of scenario.harness.answers.answer({
    conversationId: scenario.conversationId as never,
    text,
    selection: null,
    signal: controller.signal,
  })) {
    events.push(event);
    if (abortAfterFirstDelta && event.type === "delta") controller.abort();
  }
  return events;
}

function baseDeps(harness: QaHarness, file = ""): AppDeps {
  const paths = resolveDataPaths(process.env);
  if (file === "") {
    return uiDepsFrom({
      paths,
      clock: harness.db.clock,
      db: harness.db.db,
      repos: harness.db.repos,
    });
  }
  const db = openDatabase({ file });
  return uiDepsFrom({
    paths,
    clock: harness.db.clock,
    db,
    repos: createRepositories(db),
  });
}

let scenario: QaScenario | undefined;
let server: UiServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (scenario !== undefined) scenario.harness.db.close();
  scenario = undefined;
  cleanupTempDirs();
});

async function prepareConversation(): Promise<QaScenario> {
  const built = buildScenario();
  const conversation = await built.harness.conversations.create({
    generationIds: [built.fixture.generationId],
  });
  built.conversationId = conversation.conversationId;

  // Turn 1: a cited answer renders as `complete` with a citation.
  const first = await runAnswer(built, "旧快照为什么会被淘汰？");
  expect(first.at(-1)).toMatchObject({ type: "done", status: "complete" });

  // Turn 2: an uncited code_fact is downgraded to `failed` + unknown reason.
  await runAnswer(built, "账本一定记录发票吗？");

  // Turn 3: the client disconnects mid-stream → `cancelled`.
  const cancelled = await runAnswer(built, "把预算用尽", true);
  expect(cancelled.at(-1)).toMatchObject({ type: "done", status: "cancelled" });

  // A budget-exhausted turn writes `incomplete` through the production
  // finaliser (the same call the answer service makes).
  const exhausted: MessageRecord = {
    messageId: newMessageId(),
    conversationId: built.conversationId as never,
    role: "assistant",
    content: "预算耗尽，以下内容未覆盖：src/unread.ts",
    status: "streaming",
    answerPhase: "generating",
    citations: [],
    selection: null,
    checks: null,
    unknownReason: "budget_exhausted",
    incomplete: true,
    createdAt: AT,
  };
  built.harness.db.repos.conversations.insertMessage(exhausted);
  await built.harness.conversations.finalizeMessage(
    built.conversationId as never,
    exhausted.messageId,
    {
      status: "complete",
      answerPhase: "complete",
      citations: [],
      checks: null,
      unknownReason: "budget_exhausted",
      incomplete: true,
    },
  );
  return built;
}

describe("answered conversation rendered by the learning reader", () => {
  it("renders statuses, unknown reasons, incompleteness and citations from the DB", async () => {
    scenario = await prepareConversation();
    server = await startUiServer(baseDeps(scenario.harness));

    const page = await server.get(
      `/learn/reader?generation=${GENERATION_ID}&conversation=${scenario.conversationId}`,
    );
    expect(page.status).toBe(200);
    expect(countTestId(page.text, "reader-qa")).toBe(1);
    expect(countTestId(page.text, "qa-stream")).toBe(1);
    expect(countTestId(page.text, "qa-citations")).toBe(1);

    const snapshot = (await scenario.harness.conversations.get(
      scenario.conversationId as never,
    ))!;
    const renderedStatuses = [
      ...page.text.matchAll(/class="qa-message" data-role="([^"]+)" data-status="([^"]+)"/gu),
    ].map((match) => `${match[1]}:${match[2]}`);
    const expectedStatuses = snapshot.messages.map(
      (message) => `${message.role}:${message.status}`,
    );
    expect(
      renderedStatuses,
      "every persisted message must render with its own status",
    ).toEqual(expectedStatuses);

    expect(page.text).toContain("data-status=\"complete\"");
    expect(page.text).toContain("data-status=\"failed\"");
    expect(page.text).toContain("data-status=\"cancelled\"");
    // Unknown reason and incomplete come from the revision-3 columns.
    expect(page.text).toContain("未知：uncited_conclusion");
    expect(page.text).toContain("回答不完整。");

    // Citation links stay inside the bound generation.
    expect(page.text).toContain(`generation=${GENERATION_ID}`);
    expect(page.text).toContain(`source=${scenario.sourceId}`);
    expect(page.text).toContain("available");
  });

  it("sanitises the assistant answer while keeping its text", async () => {
    scenario = await prepareConversation();
    server = await startUiServer(baseDeps(scenario.harness));
    const page = await server.get(
      `/learn/reader?generation=${GENERATION_ID}&conversation=${scenario.conversationId}`,
    );

    expect(page.text).toContain("旧快照会被淘汰");
    expect(page.text).not.toContain("<script>alert(1)");
    expect(page.text).not.toContain("javascript:alert");
  });

  it("agrees with the qa branch's ConversationView mapping", async () => {
    scenario = await prepareConversation();
    const snapshot = (await scenario.harness.conversations.get(
      scenario.conversationId as never,
    ))!;
    const view = toConversationView(snapshot, () => "available");
    expect(view.messages).toHaveLength(snapshot.messages.length);

    const complete = view.messages.find(
      (message) => message.answerPhase === "complete" && message.status === "complete",
    );
    expect(complete, "the first turn must persist its final phase").toBeDefined();
    const failed = view.messages.find(
      (message) => message.unknownReason === "uncited_conclusion",
    );
    expect(failed?.status).toBe("failed");
    const incomplete = view.messages.find((message) => message.incomplete);
    expect(incomplete?.unknownReason).toBe("budget_exhausted");
    const cancelled = view.messages.find(
      (message) => message.status === "cancelled",
    );
    expect(cancelled?.answerPhase).toBe("cancelled");
  });

  it("keeps cancelled and failed content out of the summary but keeps cited sources", async () => {
    scenario = await prepareConversation();
    const snapshot = (await scenario.harness.conversations.get(
      scenario.conversationId as never,
    ))!;
    const summary = summarizeMessages(snapshot.messages);

    expect(summary.text).not.toContain("这是一段很长的回答");
    expect(summary.text).not.toContain("账本一定记录发票。");
    expect(summary.text).toContain("旧快照会被淘汰");
    expect(summary.sources).toContain(scenario.sourceId);
  });

  it("restores the rendered answer state after a restart", async () => {
    scenario = await prepareConversation();
    const file = scenario.harness.db.file;
    const conversationId = scenario.conversationId;

    // Close the first server and the first connection, then reopen the same
    // SQLite file — the boot path a restarted process follows.
    server = await startUiServer(baseDeps(scenario.harness));
    const before = await server.get(
      `/learn/reader?generation=${GENERATION_ID}&conversation=${conversationId}`,
    );
    expect(before.status).toBe(200);
    await server.close();
    server = undefined;
    scenario.harness.db.close();

    server = await startUiServer(baseDeps(scenario.harness, file));
    const after = await server.get(
      `/learn/reader?generation=${GENERATION_ID}&conversation=${conversationId}`,
    );
    expect(after.status).toBe(200);
    expect(after.text).toContain("未知：uncited_conclusion");
    expect(after.text).toContain("回答不完整。");
    expect(after.text).toContain("旧快照会被淘汰");
    // No new streaming row was cancelled by the restart: every message is
    // already terminal, so the boot normaliser has nothing to change.
    const statuses = [
      ...after.text.matchAll(/class="qa-message" data-role="[^"]+" data-status="([^"]+)"/gu),
    ].map((match) => match[1]);
    expect(statuses).toContain("cancelled");
    expect(statuses).not.toContain("streaming");
  });
});
