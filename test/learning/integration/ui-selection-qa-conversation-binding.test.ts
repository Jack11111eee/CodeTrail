import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  Lesson,
  LessonBuilderPort,
  ProjectId,
} from "../../../src/learning/contracts/index.ts";
import {
  newLessonId,
  LearningError,
} from "../../../src/learning/contracts/index.ts";
import { validateBody } from "../../../src/learning/api/validate.ts";
import { createStaticUi } from "../../../src/learning/api/static.ts";
import { createConversationService } from "../../../src/learning/qa/conversations.ts";
import {
  createHarness,
  generationInput,
  runToCompletion,
  SHA_A,
  SHA_C,
  type Harness,
} from "../generation/harness.ts";
import { uiDepsFrom } from "./merge-ui-server.ts";

/**
 * Integration: the attributes `ui/render/diagram.ts` emits, the selection body
 * `ui/client.ts` builds from them, the strict request schema in
 * `api/validate.ts`, and the qa branch's server-side ownership check must
 * agree.
 *
 * A drift in any one of the four would either reject a legitimate selection
 * (AC-UI-04) or accept a source from a generation the conversation is not
 * bound to (AC-QA-02). The existing `diagram-selection-client` suite pins the
 * browser side against fixtures; this suite pins the server side against
 * lessons the real runner and publisher produced.
 */

const PROJECT_ID = "p_level8_selection" as ProjectId;

function richLesson(
  generation: { generationId: string; repoId: string; commitSha: string },
  sourceId: string,
): Lesson {
  return {
    lessonId: newLessonId(`${generation.generationId}:selection`),
    generationId: generation.generationId,
    kind: "research",
    context: {
      repoId: generation.repoId,
      commitSha: generation.commitSha,
      generationId: generation.generationId,
      scenarioId: "sc_selection",
      moduleIds: ["src"],
    },
    scenario: {
      id: "sc_selection",
      kind: "library_interface",
      inputs: ["label"],
      userAction: "点击图表节点",
      observableResult: "带来源与提交的追问",
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
    diagram: {
      kind: "component",
      mermaid: "flowchart LR",
      nodes: [
        {
          id: "n1",
          label: "src/index.ts",
          evidenceIds: [sourceId],
          status: "observed",
        },
      ],
      edges: [],
    },
    coverageGaps: [],
    checks: { structural: "pass", evidence: "pass", semantic: "pass" },
  } as unknown as Lesson;
}

function builder(): LessonBuilderPort {
  return {
    async buildResearchLessons(input) {
      const ref = await input.registry.registerRepo({
        generationId: input.generation.generationId,
        repoId: input.generation.repoId,
        commitSha: input.generation.commitSha,
        path: "src/index.ts",
        lines: { start: 1, end: 2 },
        snapshot: input.snapshot,
        scope: input.scope,
      });
      return {
        lessons: [
          richLesson(
            {
              generationId: input.generation.generationId,
              repoId: input.generation.repoId,
              commitSha: input.generation.commitSha,
            },
            ref.sourceId,
          ),
        ],
        failures: [],
        blankTeaching: false,
      };
    },
    buildChangeLesson() {
      return Promise.reject(new Error("not used"));
    },
    buildComparisonLesson() {
      return Promise.reject(new Error("not used"));
    },
  };
}

async function publish(
  harness: Harness,
  sha: string,
  options: { mode?: "init" | "update"; streamId?: string } = {},
): Promise<{ generationId: string; sourceId: string; lessonId: string }> {
  const job = await runToCompletion(harness, {
    ...generationInput(harness, {
      sha,
      mode: options.mode,
      streamId: options.streamId ?? null,
    }),
    projectId: PROJECT_ID,
  });
  expect(job.state).toBe("completed");
  const generationId = job.outputGenerationId!;
  const sources = harness.repos.sources.all(generationId);
  const lessons = harness.repos.lessons.listByGeneration(generationId);
  return {
    generationId,
    sourceId: sources[0].sourceId,
    lessonId: lessons[0].lessonId,
  };
}

async function readerHtml(
  harness: Harness,
  generationId: string,
): Promise<string> {
  const ui = createStaticUi(uiDepsFrom(harness));
  const response = await ui.handle({
    params: { path: "/learn/reader", pattern: "/learn/reader" },
    query: { generation: generationId },
    body: undefined,
    headers: {},
    signal: new AbortController().signal,
  });
  expect(response?.kind).toBe("json");
  if (response === null || response.kind !== "json") {
    throw new Error("reader page was not rendered");
  }
  return String(response.body);
}

let harness: Harness | undefined;

afterEach(() => {
  if (harness !== undefined) harness.close();
  harness = undefined;
});

describe("diagram selection through the reader, validator and QA service", () => {
  let first: { generationId: string; sourceId: string; lessonId: string };
  let second: { generationId: string; sourceId: string; lessonId: string };

  beforeEach(async () => {
    harness = await createHarness({ lessonBuilder: builder() });
    first = await publish(harness, SHA_A);
    second = await publish(harness, SHA_C, {
      mode: "update",
      streamId: "selection-second",
    });
    expect(first.sourceId).not.toBe(second.sourceId);
  });

  it("renders the published evidence ids and commit the client posts", async () => {
    const html = await readerHtml(harness!, first.generationId);
    const node = /data-diagram-node="true"[^>]*>/u.exec(html)?.[0];
    expect(node, "the published lesson must render a diagram node").toBeTruthy();
    const evidence = /data-evidence-ids="([^"]*)"/u.exec(node!)![1]
      .split(",")
      .filter(Boolean);
    const commitSha = /data-commit-sha="([^"]*)"/u.exec(node!)![1];

    expect(evidence).toEqual([first.sourceId]);
    expect(commitSha).toBe(SHA_A);

    // The exact body `ui/client.ts` builds from a click on that node.
    const createBody = validateBody("conversations.create", {
      generationIds: [first.generationId],
    }) as { generationIds: string[] };
    expect(createBody.generationIds).toEqual([first.generationId]);

    const messageBody = {
      text: "这个节点为什么这样实现？",
      selection: { sourceId: evidence[0], sourceIds: evidence, commitSha },
    };
    const validated = validateBody("conversations.post", messageBody) as {
      text: string;
      selection: {
        sourceId: string;
        sourceIds: string[];
        commitSha: string;
      };
    };
    expect(validated.selection.commitSha).toBe(SHA_A);

    // ...and the QA service stores it against the bound generation.
    const conversations = createConversationService({
      db: harness!.db,
      repos: harness!.repos,
      clock: harness!.clock,
    });
    const conversation = await conversations.create({
      generationIds: [first.generationId as never],
    });
    await conversations.appendUserMessage(
      conversation.conversationId,
      validated.text,
      validated.selection as never,
    );
    const snapshot = (await conversations.get(conversation.conversationId))!;
    const userMessage = snapshot.messages.find(
      (message) => message.role === "user",
    )!;
    expect(userMessage.selection?.sourceId).toBe(first.sourceId);
    expect(
      snapshot.selections.map((selection) => selection.sourceId),
    ).toContain(first.sourceId);
  });

  it("rejects a selection whose source belongs to another generation", async () => {
    const conversations = createConversationService({
      db: harness!.db,
      repos: harness!.repos,
      clock: harness!.clock,
    });
    const conversation = await conversations.create({
      generationIds: [first.generationId as never],
    });

    await expect(
      conversations.appendUserMessage(
        conversation.conversationId,
        "跨版本来源",
        { sourceId: second.sourceId as never },
      ),
    ).rejects.toMatchObject({ code: "version_mismatch" });

    // The write failed atomically: no user message and no selection row.
    const snapshot = (await conversations.get(conversation.conversationId))!;
    expect(snapshot.messages).toHaveLength(0);
    expect(snapshot.selections).toHaveLength(0);
  });

  it("accepts either generation's source in an explicit two-generation conversation", async () => {
    const conversations = createConversationService({
      db: harness!.db,
      repos: harness!.repos,
      clock: harness!.clock,
    });
    const conversation = await conversations.create({
      generationIds: [
        first.generationId as never,
        second.generationId as never,
      ],
    });

    await conversations.appendUserMessage(
      conversation.conversationId,
      "比较两个版本",
      {
        sourceId: second.sourceId as never,
        sourceIds: [second.sourceId as never],
      },
    );
    const snapshot = (await conversations.get(conversation.conversationId))!;
    expect(snapshot.messages[0].selection?.sourceId).toBe(second.sourceId);

    // A source from a generation that is not bound is still refused.
    await expect(
      conversations.appendUserMessage(conversation.conversationId, "未知来源", {
        sourceId: "s_not_bound" as never,
      }),
    ).rejects.toBeInstanceOf(LearningError);
  });

  it("rejects a selection body the browser could not have produced", () => {
    expect(() =>
      validateBody("conversations.post", {
        text: "问题",
        selection: { sourceId: "s_x", unknownField: true },
      }),
    ).toThrow();
    expect(() =>
      validateBody("conversations.post", { text: "", selection: undefined }),
    ).toThrow();
  });
});
