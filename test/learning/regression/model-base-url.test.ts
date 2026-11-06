import http from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createAppDeps } from "../../../src/learning/api/cli.ts";
import { handlers as settings } from "../../../src/learning/api/routes/settings.ts";
import { mergeGenerationConfig } from "../../../src/learning/api/routes/projects.ts";
import { createModelHandle } from "../../../src/learning/config/model.ts";
import type {
  ModelSettings,
  RouteRequest,
} from "../../../src/learning/contracts/index.ts";

const defaults: ModelSettings = {
  provider: "anthropic",
  model: "gateway-model",
  temperature: 0,
  maxOutputTokens: 512,
  pricing: null,
  quota: { maxCalls: 0, maxInputTokens: 0, maxOutputTokens: 0 },
};

describe("Base URL runtime", () => {
  it("sends a real Messages API request to the saved service root and pins submitted configuration", async () => {
    const received: { path?: string; model?: string; key?: string } = {};
    const gateway = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received.path = req.url;
        received.key = String(req.headers["x-api-key"]);
        received.model = (
          JSON.parse(Buffer.concat(chunks).toString()) as { model: string }
        ).model;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_mock",
            type: "message",
            role: "assistant",
            model: "gateway-model",
            content: [{ type: "text", text: "gateway reached" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 2, output_tokens: 2 },
          }),
        );
      });
    });
    gateway.listen(0, "127.0.0.1");
    await once(gateway, "listening");
    const address = gateway.address() as { port: number };
    const root = `http://127.0.0.1:${address.port}/anthropic`;
    const deps = await createAppDeps({
      CODETRAIL_DATA_DIR: process.env.CODETRAIL_DATA_DIR!,
    });
    const put = (body: unknown) =>
      settings["settings.model.put"]!(deps)({ body } as RouteRequest);
    try {
      await put({
        provider: "anthropic",
        model: "gateway-model",
        baseUrl: `${root}/`,
        apiKey: "test-gateway-key",
      });
      const pinned = deps.model!;
      const config = mergeGenerationConfig(deps, undefined);
      expect(config.model.baseUrl).toBe(root);
      await put({
        provider: "anthropic",
        model: "other-model",
        baseUrl: "http://127.0.0.1:1",
      });
      expect(deps.model!.settings.baseUrl).toBe("http://127.0.0.1:1");
      expect(config.model.baseUrl).toBe(root);
      const response = await pinned.chat().invoke("ping");
      expect(response.content).toBe("gateway reached");
      expect(received).toEqual({
        path: "/anthropic/v1/messages",
        model: "gateway-model",
        key: "test-gateway-key",
      });
    } finally {
      deps.watch.stop();
      deps.db.close();
      gateway.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        gateway.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("uses startup environment as fallback while a saved override wins", () => {
    const env = { ANTHROPIC_BASE_URL: "https://env.example/anthropic/" };
    expect(createModelHandle(defaults, env).settings.baseUrl).toBe(
      "https://env.example/anthropic",
    );
    expect(
      createModelHandle({ ...defaults, baseUrl: "https://saved.example/" }, env)
        .settings.baseUrl,
    ).toBe("https://saved.example");
    expect(
      createModelHandle({ ...defaults, baseUrl: null }, env).settings.baseUrl,
    ).toBe("https://env.example/anthropic");
  });
});
