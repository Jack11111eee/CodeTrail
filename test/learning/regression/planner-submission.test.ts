import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runNativeRepositoryGeneration } from "../../../src/agent/repository-runner.ts";
import { createModelHandle } from "../../../src/learning/config/model.ts";
import type { OpenWikiRunEvent } from "../../../src/agent/types.ts";

type Request = {
  messages: { role: string; content: unknown }[];
  tools?: { name: string }[];
  tool_choice?: { type: string };
  max_tokens: number;
};
let gateway: http.Server;
let url: string;
let requests: Request[];
let repairFails: boolean;
let initialStop: string;
let planned: boolean;
let root: string;
beforeEach(async () => {
  requests = [];
  repairFails = false;
  initialStop = "max_tokens";
  planned = false;
  root = path.join(process.env.CODETRAIL_DATA_DIR!, "planner-fixture");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "README.md"),
    "# Planner regression fixture\nA small standalone library.\n",
  );
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"],
    ["add", "."],
    ["commit", "-qm", "Initial"],
  ])
    execFileSync("git", args, { cwd: root });
  gateway = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Request;
      requests.push(body);
      let content: unknown[], stop: string;
      if (requests.length === 1) {
        content = [
          {
            type: "tool_use",
            id: "read_repo",
            name: "ls",
            input: { path: "/" },
          },
        ];
        stop = "tool_use";
      } else if (
        body.tools?.length === 1 &&
        body.tools[0].name === "submit_plan"
      ) {
        if (repairFails) {
          content = [{ type: "text", text: "truncated again" }];
          stop = "max_tokens";
        } else {
          content = [
            {
              type: "tool_use",
              id: "submit_repaired",
              name: "submit_plan",
              input: {
                pages: [
                  {
                    path: "/openwiki/quickstart.md",
                    title: "Quickstart",
                    purpose:
                      "Understand the standalone library and its entry point.",
                  },
                ],
              },
            },
          ];
          stop = "tool_use";
          planned = true;
        }
      } else if (planned) {
        content = [{ type: "text", text: "Done." }];
        stop = "end_turn";
      } else {
        content = [
          { type: "text", text: "incomplete-plan-must-not-be-replayed" },
        ];
        stop = initialStop;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: `msg_${requests.length}`,
          type: "message",
          role: "assistant",
          model: "planner-fixture",
          content,
          stop_reason: stop,
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: stop === "max_tokens" ? 256 : 20,
          },
        }),
      );
    });
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  url = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
});
afterEach(async () => {
  gateway.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    gateway.close((error) => (error ? reject(error) : resolve())),
  );
});

async function run(events: OpenWikiRunEvent[]) {
  const model = createModelHandle(
    {
      provider: "anthropic",
      model: "planner-fixture",
      baseUrl: url,
      maxOutputTokens: 256,
      temperature: 0,
      pricing: null,
      quota: { maxCalls: 0, maxInputTokens: 0, maxOutputTokens: 0 },
    },
    {},
    "fixture-key",
    { maxRetries: 0 },
  ).chat();
  model.disableStreaming = true;
  const stopped = new Error("planning verified; stop before page generation");
  try {
    await runNativeRepositoryGeneration({
      root,
      mode: "init",
      language: "zh",
      modelId: "planner-fixture",
      model,
      pageConcurrency: 1,
      writeRepoFiles: false,
      onEvent: (event) => {
        events.push(event);
        if (
          event.type === "repository_progress" &&
          event.stage === "generating"
        )
          throw stopped;
      },
    });
  } catch (error) {
    if (error !== stopped) throw error;
  }
}

describe("planner submission recovery through real SDK and agent", () => {
  it.each(["max_tokens", "end_turn"])(
    "recovers once after %s without repeating research or replaying a broken assistant tail",
    async (stop) => {
      initialStop = stop;
      const events: OpenWikiRunEvent[] = [];
      await run(events);
      expect(planned).toBe(true);
      const repairs = requests.filter(
        (req) => req.tools?.length === 1 && req.tools[0].name === "submit_plan",
      );
      expect(repairs).toHaveLength(1);
      expect(repairs[0].tool_choice?.type).toBe("any");
      expect(repairs[0].max_tokens).toBe(256);
      const history = JSON.stringify(repairs[0].messages);
      expect(history).toContain("README.md");
      expect(history).not.toContain("incomplete-plan-must-not-be-replayed");
      expect(history).toContain("Do not explore or read files again");
      expect(
        events.filter(
          (event) => event.type === "tool_start" && event.name === "ls",
        ),
      ).toHaveLength(1);
      expect(
        events.some(
          (event) =>
            event.type === "repository_progress" &&
            event.stage === "replanning",
        ),
      ).toBe(true);
      const state = JSON.parse(
        fs.readFileSync(path.join(root, "openwiki", ".run.json"), "utf8"),
      ) as { phase: string; plan: { pages: { path: string }[] } };
      expect(state.phase).toBe("generating");
      expect(state.plan.pages.map((page) => page.path)).toEqual([
        "/openwiki/quickstart.md",
      ]);
    },
  );

  it("stops after one failed correction with an actionable output-limit error", async () => {
    repairFails = true;
    await expect(run([])).rejects.toThrow("单次输出上限");
    expect(requests).toHaveLength(3);
    expect(
      requests.filter(
        (req) => req.tools?.length === 1 && req.tools[0].name === "submit_plan",
      ),
    ).toHaveLength(1);
    expect(planned).toBe(false);
    const state = JSON.parse(
      fs.readFileSync(path.join(root, "openwiki", ".run.json"), "utf8"),
    ) as { phase: string; plan?: unknown };
    expect(state.phase).toBe("planning");
    expect(state.plan).toBeUndefined();
  });
});
