import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  BaseChatModel,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import {
  HumanMessage,
  SystemMessage,
  type AIMessageChunk,
  type BaseMessage,
} from "@langchain/core/messages";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LearningError } from "../../../src/learning/contracts/index.js";
import type { ModelRole } from "../../../src/learning/contracts/index.js";
import {
  createScriptedModel,
  SCRIPT_FILE_NAME,
  type ScriptFile,
  type ScriptedModelOptions,
} from "../../../src/learning/testing/scripted-model.js";

/**
 * The deterministic scripted model (architecture §17.1, PRD §15.2 item 1).
 *
 * Every call-count and crash assertion in the learning suite rests on this
 * double being faithful: the worker kind must follow the offered tools, the
 * page path must come from the system prompt, occurrence indexing must be
 * exact, an unknown key must fail loudly, and two identical runs must produce
 * byte-identical message sequences without any network access.
 */

const VERSION = "codetrail-lesson-v1";

let temporaryDirs: string[] = [];

function makeDir(content: ScriptFile | string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-scripted-"));
  temporaryDirs.push(dir);
  const body =
    typeof content === "string" ? content : JSON.stringify(content, null, 2);
  fs.writeFileSync(path.join(dir, SCRIPT_FILE_NAME), body, "utf8");
  return dir;
}

function makeModel(
  dir: string,
  role: ModelRole = "lesson",
  onCall?: ScriptedModelOptions["onCall"],
): ReturnType<typeof createScriptedModel> {
  return createScriptedModel({
    dir,
    role,
    promptTemplateVersion: VERSION,
    onCall,
  });
}

function bind(
  model: ReturnType<typeof createScriptedModel>,
  tools: BindToolsInput[],
) {
  if (typeof model.bindTools !== "function") {
    throw new Error("scripted model must expose bindTools");
  }
  return model.bindTools(tools);
}

function pageMessages(pagePath: string): BaseMessage[] {
  return [
    new SystemMessage(
      `Write the page /openwiki/${pagePath}.md from the sources.`,
    ),
    new HumanMessage("Go."),
  ];
}

async function textOf(
  model: ReturnType<typeof createScriptedModel>,
  tools: BindToolsInput[],
  messages: BaseMessage[],
): Promise<string> {
  const output = await bind(model, tools).invoke(messages);
  return typeof output.content === "string" ? output.content : "";
}

function capture(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(
    () => null,
    (error: unknown) => error,
  );
}

function serialize(message: AIMessageChunk): unknown {
  return {
    type: message._getType(),
    content: message.content,
    toolCalls: (message.tool_calls ?? []).map((call) => ({
      name: call.name,
      args: call.args,
      id: call.id ?? null,
      type: call.type ?? null,
    })),
  };
}

afterEach(() => {
  for (const dir of temporaryDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  temporaryDirs = [];
  vi.restoreAllMocks();
});

describe("scripted model worker kind", () => {
  it("is a genuine BaseChatModel", () => {
    const dir = makeDir({ scripts: [] });
    expect(makeModel(dir)).toBeInstanceOf(BaseChatModel);
  });

  it("derives the kind from the offered tools and falls back to the role", async () => {
    const dir = makeDir({
      scripts: [
        { workerKind: "planner", steps: [{ content: "planner" }] },
        {
          workerKind: "page",
          pagePath: "guide/intro",
          steps: [{ content: "page" }],
        },
        { workerKind: "lesson", steps: [{ content: "lesson" }] },
        { workerKind: "qa", steps: [{ content: "qa" }] },
        { workerKind: "change", steps: [{ content: "change" }] },
      ],
    });

    const plain = [new HumanMessage("hi")];
    expect(
      await textOf(makeModel(dir, "change"), [{ name: "submit_plan" }], plain),
    ).toBe("planner");
    expect(
      await textOf(
        makeModel(dir, "change"),
        [{ name: "submit_page" }],
        pageMessages("guide/intro"),
      ),
    ).toBe("page");
    expect(
      await textOf(makeModel(dir, "lesson"), [{ name: "search" }], plain),
    ).toBe("lesson");
    expect(await textOf(makeModel(dir, "qa"), [], plain)).toBe("qa");
    expect(await textOf(makeModel(dir, "change"), [], plain)).toBe("change");
  });

  it("recognises provider-shaped and unnamed tool offers", async () => {
    const dir = makeDir({
      scripts: [
        { workerKind: "planner", steps: [{ content: "planner" }] },
        { workerKind: "page", pagePath: "a", steps: [{ content: "page" }] },
        { workerKind: "qa", steps: [{ content: "qa" }] },
      ],
    });

    expect(
      await textOf(
        makeModel(dir, "qa"),
        [
          {
            type: "function",
            function: { name: "submit_plan", parameters: {} },
          },
        ],
        [new HumanMessage("hi")],
      ),
    ).toBe("planner");

    expect(
      await textOf(
        makeModel(dir, "qa"),
        [{ description: "no name here" }],
        [new HumanMessage("hi")],
      ),
    ).toBe("qa");

    expect(
      await textOf(
        makeModel(dir, "qa"),
        [{ name: "submit_page" }],
        pageMessages("a"),
      ),
    ).toBe("page");
  });
});

describe("scripted model page path", () => {
  it("extracts the exact /openwiki/<path>.md from the system message", async () => {
    const dir = makeDir({
      scripts: [
        {
          workerKind: "page",
          pagePath: "guide/intro",
          steps: [{ content: "exact" }],
        },
      ],
    });

    expect(
      await textOf(
        makeModel(dir),
        [{ name: "submit_page" }],
        [
          new SystemMessage("Page: `/openwiki/guide/intro.md`."),
          new HumanMessage("Go."),
        ],
      ),
    ).toBe("exact");

    const wrongPath = await capture(() =>
      textOf(
        makeModel(dir),
        [{ name: "submit_page" }],
        pageMessages("guide/intro/other"),
      ),
    );
    expect(wrongPath).toBeInstanceOf(LearningError);
    expect((wrongPath as LearningError).details?.reason).toBe(
      "fixture_missing",
    );
  });

  it("treats a missing pagePath and a version pin as filters", async () => {
    const dir = makeDir({
      scripts: [
        {
          workerKind: "page",
          pagePath: "guide/intro",
          promptTemplateVersion: "other-version",
          steps: [{ content: "stale" }],
        },
      ],
    });

    const error = await capture(() =>
      textOf(
        makeModel(dir),
        [{ name: "submit_page" }],
        pageMessages("guide/intro"),
      ),
    );
    expect(error).toBeInstanceOf(LearningError);
    expect((error as LearningError).details?.promptTemplateVersion).toBe(
      VERSION,
    );
  });
});

describe("scripted model occurrence indexing", () => {
  it("consumes occurrences in call order and resets per model instance", async () => {
    const dir = makeDir({
      scripts: [
        { workerKind: "qa", occurrence: 1, steps: [{ content: "first" }] },
        { workerKind: "qa", occurrence: 2, steps: [{ content: "second" }] },
        { workerKind: "qa", occurrence: 3, steps: [{ content: "third" }] },
      ],
    });
    const messages = [new HumanMessage("question")];

    const one = makeModel(dir, "qa");
    expect(await textOf(one, [], messages)).toBe("first");
    expect(await textOf(one, [], messages)).toBe("second");
    expect(await textOf(one, [], messages)).toBe("third");

    const exhausted = await capture(() => textOf(one, [], messages));
    expect(exhausted).toBeInstanceOf(LearningError);
    expect((exhausted as LearningError).code).toBe("internal_error");
    expect((exhausted as LearningError).details?.reason).toBe(
      "fixture_missing",
    );
    expect((exhausted as LearningError).details?.occurrence).toBe(4);

    const two = makeModel(dir, "qa");
    expect(await textOf(two, [], messages)).toBe("first");
  });

  it("rejects a duplicate occurrence instead of picking one at random", async () => {
    const dir = makeDir({
      scripts: [
        { workerKind: "qa", occurrence: 1, steps: [{ content: "a" }] },
        { workerKind: "qa", occurrence: 1, steps: [{ content: "b" }] },
      ],
    });

    const error = await capture(() =>
      textOf(makeModel(dir, "qa"), [], [new HumanMessage("q")]),
    );
    expect(error).toBeInstanceOf(LearningError);
    expect((error as LearningError).code).toBe("invalid_input");
  });
});

describe("scripted model missing fixtures", () => {
  it("throws fixture_missing for an unknown key and never returns empty text", async () => {
    const dir = makeDir({
      scripts: [{ workerKind: "lesson", steps: [{ content: "known" }] }],
    });

    const error = await capture(() =>
      textOf(makeModel(dir, "qa"), [], [new HumanMessage("q")]),
    );
    expect(error).toBeInstanceOf(LearningError);
    const failure = error as LearningError;
    expect(failure.code).toBe("internal_error");
    expect(failure.details?.reason).toBe("fixture_missing");
    expect(failure.details?.workerKind).toBe("qa");
  });

  it("throws fixture_missing when the script file is absent", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-scripted-"));
    temporaryDirs.push(dir);

    const error = await capture(() =>
      textOf(makeModel(dir, "qa"), [], [new HumanMessage("q")]),
    );
    expect(error).toBeInstanceOf(LearningError);
    expect((error as LearningError).code).toBe("internal_error");
    expect((error as LearningError).details?.reason).toBe("fixture_missing");
  });

  it("treats an empty scripts array as no fixture", async () => {
    const dir = makeDir({ scripts: [] });
    const error = await capture(() =>
      textOf(makeModel(dir, "qa"), [], [new HumanMessage("q")]),
    );
    expect(error).toBeInstanceOf(LearningError);
    expect((error as LearningError).details?.reason).toBe("fixture_missing");
  });

  it("rejects malformed scripts with invalid_input", async () => {
    for (const body of [
      "{ not json",
      JSON.stringify({ scripts: "nope" }),
      JSON.stringify({ scripts: [{ workerKind: "nope", steps: [] }] }),
      JSON.stringify({ scripts: [{ workerKind: "qa", steps: "nope" }] }),
      JSON.stringify({
        scripts: [
          {
            workerKind: "qa",
            steps: [{ toolCalls: [{ name: "x", args: "not-an-object" }] }],
          },
        ],
      }),
    ]) {
      const dir = makeDir(body);
      const error = await capture(() =>
        textOf(makeModel(dir, "qa"), [], [new HumanMessage("q")]),
      );
      expect(error).toBeInstanceOf(LearningError);
      expect((error as LearningError).code, body).toBe("invalid_input");
    }
  });
});

describe("scripted model determinism", () => {
  it("produces an identical message sequence for identical input", async () => {
    const dir = makeDir({
      scripts: [
        {
          workerKind: "qa",
          occurrence: 1,
          steps: [
            {
              toolCalls: [
                { name: "search", args: { query: "ledger" } },
                { name: "search", args: { query: "invoice" } },
              ],
            },
          ],
        },
        {
          workerKind: "qa",
          occurrence: 2,
          steps: [{ content: "final answer" }],
        },
      ],
    });

    const run = async (): Promise<string> => {
      const model = makeModel(dir, "qa");
      const messages = [new HumanMessage("how does it work?")];
      const outputs: unknown[] = [];
      outputs.push(serialize(await bind(model, []).invoke(messages)));
      outputs.push(serialize(await bind(model, []).invoke(messages)));
      return createHash("sha256").update(JSON.stringify(outputs)).digest("hex");
    };

    const first = await run();
    const second = await run();
    expect(second).toBe(first);
  });

  it("performs no network I/O when generating", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const dir = makeDir({
      scripts: [{ workerKind: "lesson", steps: [{ content: "offline" }] }],
    });

    expect(await textOf(makeModel(dir), [], [new HumanMessage("hi")])).toBe(
      "offline",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports role, tools and token counts through onCall", async () => {
    const calls: Parameters<NonNullable<ScriptedModelOptions["onCall"]>>[0][] =
      [];
    const dir = makeDir({
      scripts: [{ workerKind: "qa", steps: [{ content: "answer" }] }],
    });
    const model = makeModel(dir, "qa", (info) => {
      calls.push(info);
    });

    // A cache-hit path that never consults the model keeps the count at zero.
    expect(calls).toHaveLength(0);

    await textOf(
      model,
      [{ name: "search" }, { name: "read" }],
      [new HumanMessage("question")],
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].role).toBe("qa");
    expect(calls[0].tools).toEqual(["search", "read"]);
    expect(calls[0].inputTokens).toBeGreaterThan(0);
    expect(calls[0].outputTokens).toBeGreaterThan(0);
  });
});
