import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runNativeRepositoryGeneration } from "../../../src/agent/repository-runner.ts";
import {
  meteredHandle,
  createModelGate,
} from "../../../src/learning/config/metered-model.ts";
import { createModelHandle } from "../../../src/learning/config/model.ts";
import { readRepositoryPageManifest } from "../../../src/generation/page-manifest.ts";
import type { OpenWikiRunEvent } from "../../../src/agent/types.ts";

interface Request {
  system?: string | { text?: string }[];
  messages: { role: string; content: unknown }[];
  tools?: {
    name: string;
    input_schema?: { properties?: Record<string, unknown> };
  }[];
  tool_choice?: { type: string };
  max_tokens: number;
}
const PAGES = [
  "/openwiki/architecture/core-and-adapters.md",
  "/openwiki/quickstart.md",
];
let gateway: http.Server, url: string, root: string;
let requests: Request[];
let planned: boolean,
  failFirstWrite: boolean,
  researchForever: boolean,
  blockFirstPage: boolean,
  malformedResponse: boolean;
let abortPageRequest: (() => void) | undefined;
let pageStates: Map<
  string,
  { reads: number; writes: number; submitted: boolean }
>;
beforeEach(async () => {
  requests = [];
  planned = false;
  failFirstWrite = false;
  researchForever = false;
  blockFirstPage = false;
  malformedResponse = false;
  abortPageRequest = undefined;
  pageStates = new Map();
  root = path.join(process.env.CODETRAIL_DATA_DIR!, "page-fixture");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "README.md"),
    "# Example\nThis repository has a README.\n",
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
      const names = body.tools?.map((tool) => tool.name) ?? [];
      let content: unknown[] = [{ type: "text", text: "Done." }],
        stop = "end_turn";
      const tool = (name: string, input: unknown) => {
        content = [
          { type: "tool_use", id: `tool_${requests.length}`, name, input },
        ];
        stop = "tool_use";
      };
      if (names.includes("submit_plan")) {
        if (!planned) {
          planned = true;
          tool("submit_plan", {
            pages: PAGES.map((page) => ({
              path: page,
              title: "Guide",
              purpose: "Document the example repository.",
              seedPaths: ["README.md"],
            })),
          });
        }
      } else if (
        names.includes("submit_page") ||
        names.includes("write_file")
      ) {
        const system =
          typeof body.system === "string"
            ? body.system
            : (body.system?.map((block) => block.text ?? "").join("\n") ?? "");
        const page = /You own exactly ([^\n]+)\./u.exec(system)?.[1] ?? "";
        if (abortPageRequest && page === PAGES[1]) {
          abortPageRequest();
          return;
        }
        const state = pageStates.get(page) ?? {
          reads: 0,
          writes: 0,
          submitted: false,
        };
        pageStates.set(page, state);
        if (
          malformedResponse &&
          page === PAGES[0] &&
          names.includes("read_file") &&
          body.messages.length > 1
        ) {
          malformedResponse = false;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"id":"incomplete-response","content":[');
          return;
        }
        if (names.length === 1 && names[0] === "write_file") {
          state.writes++;
          if (
            page === PAGES[0] &&
            (blockFirstPage || (failFirstWrite && state.writes === 1))
          ) {
            content = [{ type: "text", text: "still truncated" }];
            stop = "max_tokens";
          } else {
            const properties = body.tools?.[0].input_schema?.properties ?? {};
            const field = "file_path" in properties ? "file_path" : "path";
            tool("write_file", {
              [field]: page,
              content:
                "---\ntype: Guide\ntitle: Example guide\ndescription: A concise repository guide.\ntags: [example]\n---\n\n# Example\n\nThis repository has a README.\n",
            });
          }
        } else if (
          names.includes("submit_page") &&
          !names.includes("read_file")
        ) {
          tool("submit_page", {
            claims: [
              {
                statement: "This repository has a README.",
                evidence: [{ resource: "repo://README.md" }],
              },
            ],
          });
          state.submitted = true;
        } else if (!state.submitted) {
          if (body.messages.length === 1) {
            state.reads++;
            tool("ls", { path: "/" });
          } else if (researchForever) {
            tool("ls", { path: "/" });
          } else {
            content = [{ type: "text", text: "truncated-page-tail" }];
            stop = "max_tokens";
          }
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: `msg_${requests.length}`,
          type: "message",
          role: "assistant",
          model: "page-fixture",
          content,
          stop_reason: stop,
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: stop === "max_tokens" ? 256 : 40,
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

describe("page completion recovery through real SDK, agent, filesystem and Claims", () => {
  const nativeOptions = () => ({
    root,
    mode: "init" as const,
    language: "zh",
    modelId: "page-fixture",
    model: createModelHandle(
      {
        provider: "anthropic",
        model: "page-fixture",
        baseUrl: url,
        maxOutputTokens: 256,
        temperature: 0,
        pricing: null,
        quota: { maxCalls: 0, maxInputTokens: 0, maxOutputTokens: 0 },
      },
      {},
      "fixture-key",
      { maxRetries: 0 },
    ).chat(),
    writeRepoFiles: false,
    retainIncompleteRun: true,
  });

  it("recovers a malformed SDK response without repeating completed research", async () => {
    malformedResponse = true;
    const events: OpenWikiRunEvent[] = [];
    await runNativeRepositoryGeneration({
      ...nativeOptions(),
      onEvent: (event) => events.push(event),
    });
    expect(pageStates.get(PAGES[0])?.reads).toBe(1);
    expect(
      Object.keys((await readRepositoryPageManifest(root)).pages).sort(),
    ).toEqual([...PAGES].sort());
    expect(
      events.some(
        (event) =>
          event.type === "repository_progress" &&
          event.message?.includes("模型响应格式不完整"),
      ),
    ).toBe(true);
  });

  it("bounds repeated exploration and delivers the planned source excerpts up front", async () => {
    researchForever = true;
    await runNativeRepositoryGeneration(nativeOptions());
    expect(
      Object.keys((await readRepositoryPageManifest(root)).pages).sort(),
    ).toEqual([...PAGES].sort());
    for (const page of PAGES) {
      const pageRequests = requests.filter((request) =>
        JSON.stringify(request.system).includes(`You own exactly ${page}.`),
      );
      expect(pageRequests.length).toBeLessThanOrEqual(12);
      expect(JSON.stringify(pageRequests[0].messages)).toContain(
        "This repository has a README.",
      );
      expect(
        pageRequests.some((request) => request.tool_choice?.type === "any"),
      ).toBe(true);
    }
  });

  it("preserves completed modules and pending status when the real SDK request is aborted", async () => {
    const controller = new AbortController();
    abortPageRequest = () => controller.abort();
    const handle = createModelHandle(
      {
        provider: "anthropic",
        model: "page-fixture",
        baseUrl: url,
        maxOutputTokens: 256,
        temperature: 0,
        pricing: null,
        quota: { maxCalls: 0, maxInputTokens: 0, maxOutputTokens: 0 },
      },
      {},
      "fixture-key",
      { maxRetries: 0 },
    );
    const model = meteredHandle(handle, {
      kind: "initial",
      jobId: null,
      role: "repo_job",
      signal: controller.signal,
      gate: createModelGate(),
      usage: {
        canSpend: () => true,
        record: () => undefined,
        totals: () => ({
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          costCents: null,
        }),
      },
    }).chat();
    await expect(
      runNativeRepositoryGeneration({ ...nativeOptions(), model }),
    ).rejects.toMatchObject({ name: "AbortError" });
    const checkpoint = JSON.parse(
      fs.readFileSync(path.join(root, "openwiki/.run.json"), "utf8"),
    ) as { plan: { pages: { status: string }[] } };
    expect(checkpoint.plan.pages.map((page) => page.status)).toEqual([
      "complete",
      "pending",
    ]);
    expect(
      fs.readFileSync(path.join(root, PAGES[0].slice(1)), "utf8"),
    ).toContain("This repository has a README.");
  });

  it("keeps the native checkpoint if committing the next stage fails, and finishes without more model calls", async () => {
    await expect(
      runNativeRepositoryGeneration({
        ...nativeOptions(),
        onDocumentsReady: () =>
          Promise.reject(new Error("host checkpoint interrupted")),
      }),
    ).rejects.toThrow("host checkpoint interrupted");
    const checkpoint = JSON.parse(
      fs.readFileSync(path.join(root, "openwiki/.run.json"), "utf8"),
    ) as { plan: { pages: { status: string }[] } };
    expect(
      checkpoint.plan.pages.every(
        (page: { status: string }) => page.status === "complete",
      ),
    ).toBe(true);
    const calls = requests.length;
    await runNativeRepositoryGeneration(nativeOptions());
    expect(requests).toHaveLength(calls);
    expect(fs.existsSync(path.join(root, "openwiki/.run.json"))).toBe(false);
  });

  it("continues later pages after one fails, then resumes only the failed page without replanning", async () => {
    blockFirstPage = true;
    await expect(
      runNativeRepositoryGeneration(nativeOptions()),
    ).rejects.toThrow("已保存");
    const checkpoint = JSON.parse(
      fs.readFileSync(path.join(root, "openwiki/.run.json"), "utf8"),
    ) as { plan: { pages: { status: string }[] } };
    expect(
      checkpoint.plan.pages.map((page: { status: string }) => page.status),
    ).toEqual(["skipped", "complete"]);
    const plannerCalls = requests.filter((r) =>
      r.tools?.some((tool) => tool.name === "submit_plan"),
    ).length;
    const completedWrites = pageStates.get(PAGES[1])!.writes;
    blockFirstPage = false;
    await runNativeRepositoryGeneration(nativeOptions());
    expect(
      requests.filter((r) =>
        r.tools?.some((tool) => tool.name === "submit_plan"),
      ),
    ).toHaveLength(plannerCalls);
    expect(pageStates.get(PAGES[1])!.writes).toBe(completedWrites);
    expect(
      Object.keys((await readRepositoryPageManifest(root)).pages).sort(),
    ).toEqual([...PAGES].sort());
  });

  it.each([false, true])(
    "finishes nested pages after truncated writes/submissions; failed first correction=%s",
    async (fail) => {
      failFirstWrite = fail;
      const model = createModelHandle(
        {
          provider: "anthropic",
          model: "page-fixture",
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
      const events: OpenWikiRunEvent[] = [];
      const result = await runNativeRepositoryGeneration({
        root,
        mode: "init",
        language: "zh",
        modelId: "page-fixture",
        model,
        pageConcurrency: 1,
        writeRepoFiles: false,
        onEvent: (event) => events.push(event),
      });
      expect(result.skipped).toBe(false);
      const manifest = await readRepositoryPageManifest(root);
      expect(
        Object.keys(manifest.pages).sort(),
        JSON.stringify({
          states: [...pageStates.entries()],
          calls: requests.map((request) => ({
            tools: request.tools?.map((tool) => tool.name),
            last: request.messages.at(-1),
          })),
        }),
      ).toEqual([...PAGES].sort());
      for (const page of PAGES) {
        expect(
          fs.readFileSync(path.join(root, page.slice(1)), "utf8"),
        ).toContain("This repository has a README.");
        const state = pageStates.get(page)!;
        expect(state.submitted).toBe(true);
        expect(state.reads).toBe(fail && page === PAGES[0] ? 2 : 1);
      }
      expect(requests.every((request) => request.max_tokens === 256)).toBe(
        true,
      );
      const forced = requests.filter(
        (request) =>
          request.tools?.length === 1 &&
          ["write_file", "submit_page"].includes(request.tools[0].name),
      );
      expect(
        forced.every((request) => request.tool_choice?.type === "any"),
      ).toBe(true);
      expect(
        forced.every(
          (request) =>
            !JSON.stringify(request.messages).includes("truncated-page-tail"),
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "repository_progress" &&
            event.message?.includes("精简并写入页面"),
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "repository_progress" &&
            event.message?.includes("精简并提交页面"),
        ),
      ).toBe(true);
    },
  );
});
