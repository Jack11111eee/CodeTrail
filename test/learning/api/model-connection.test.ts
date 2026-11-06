import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsModule } from "../../../src/learning/api/routes/settings.ts";
import { saveModelKey } from "../../../src/learning/config/model-credentials.ts";
import { startHarness, type Harness } from "../helpers/http-client.ts";
import {
  startRoutesServer,
  type RoutesServer,
} from "../helpers/routes-server.ts";

let gateway: http.Server;
let server: RoutesServer;
let harness: Harness;
let root: string;
let gatewayStatus: number;
let emptyResponse: boolean;
let requests: {
  path: string | undefined;
  key: string | undefined;
  body: Record<string, unknown>;
}[];
const KEY = "test-only-unsaved-key";

beforeEach(async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("CODETRAIL_ANTHROPIC_API_KEY", "");
  gatewayStatus = 200;
  emptyResponse = false;
  requests = [];
  gateway = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        path: req.url,
        key: req.headers["x-api-key"] as string | undefined,
        body: JSON.parse(Buffer.concat(chunks).toString()) as Record<
          string,
          unknown
        >,
      });
      res.writeHead(gatewayStatus, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          gatewayStatus !== 200
            ? {
                type: "error",
                error: {
                  type: "api_error",
                  message: `Do not return this: ${KEY}`,
                },
              }
            : {
                id: "msg_probe",
                type: "message",
                role: "assistant",
                model: "test-model",
                content: emptyResponse ? [] : [{ type: "text", text: "OK" }],
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: { input_tokens: 5, output_tokens: 1 },
              },
        ),
      );
    });
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  root = `http://127.0.0.1:${(gateway.address() as { port: number }).port}/anthropic`;
  server = await startRoutesServer([settingsModule]);
  harness = await startHarness({ start: () => server });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await harness?.close();
  gateway?.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    gateway.close((error) => (error ? reject(error) : resolve())),
  );
});

function probe(patch: Record<string, unknown> = {}) {
  return harness.request("/api/settings/model/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "anthropic",
      model: "test-model",
      baseUrl: root,
      apiKey: KEY,
      ...patch,
    }),
  });
}

describe("POST /api/settings/model/test", () => {
  it("tests unsaved inputs through the real SDK without saving settings or keys", async () => {
    const result = await probe();
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({
      ok: true,
    });
    expect(typeof (result.json as { latencyMs: unknown }).latencyMs).toBe(
      "number",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: "/anthropic/v1/messages",
      key: KEY,
      body: {
        model: "test-model",
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply only with OK." }],
      },
    });
    expect(server.repos.settings.model()).toBeNull();
    expect(
      fs.existsSync(path.join(server.paths.root, "model-credentials.json")),
    ).toBe(false);
    expect(result.text).not.toContain(KEY);
  });

  it("uses a saved key when the key field is omitted, and an unsaved key wins", async () => {
    const saved = {
      provider: "anthropic",
      model: "saved-model",
      baseUrl: "https://saved.example",
      maxOutputTokens: 1024,
      temperature: 0.2,
      pricing: null,
      quota: { maxCalls: 0, maxInputTokens: 0, maxOutputTokens: 0 },
    };
    server.repos.settings.putModel(saved);
    saveModelKey(server.paths, "stored-test-key");
    expect((await probe({ apiKey: undefined })).status).toBe(200);
    expect(requests[0].key).toBe("stored-test-key");
    expect((await probe()).status).toBe(200);
    expect(requests[1].key).toBe(KEY);
    expect(server.repos.settings.model()).toEqual(saved);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(server.paths.root, "model-credentials.json"),
          "utf8",
        ),
      ),
    ).toEqual({ anthropicApiKey: "stored-test-key" });
  });

  it("uses an environment key when no key was saved or entered", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "env-test-key");
    expect((await probe({ apiKey: undefined })).status).toBe(200);
    expect(requests[0].key).toBe("env-test-key");
  });

  it("rejects missing keys and unsupported providers before contacting the service", async () => {
    expect((await probe({ apiKey: undefined })).status).toBe(400);
    expect((await probe({ provider: "fixture" })).status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it.each([
    [401, "authentication_failed"],
    [403, "authentication_failed"],
    [404, "endpoint_or_model_not_found"],
    [429, "rate_limited"],
    [400, "unsupported_request"],
    [503, "service_unavailable"],
  ])("reports HTTP %s safely without retrying", async (status, reason) => {
    gatewayStatus = Number(status);
    const response = await probe();
    expect(response.status).toBe(502);
    expect(response.json).toMatchObject({
      error: { details: { reason, providerStatus: status } },
    });
    expect(requests).toHaveLength(1);
    expect(response.text).not.toContain(KEY);
    expect(response.text).not.toContain("Do not return this");
  });

  it("rejects an empty model response", async () => {
    emptyResponse = true;
    const response = await probe();
    expect(response.status).toBe(502);
    expect(response.json).toMatchObject({
      error: { details: { reason: "invalid_response" } },
    });
  });

  it("handles the ten-second deadline with a clear timeout result", async () => {
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(
        AbortSignal.abort(new DOMException("Timed out", "TimeoutError")),
      );
    const response = await probe();
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(response.status).toBe(502);
    expect(response.json).toMatchObject({
      error: { details: { reason: "timeout" } },
    });
  });

  it("requires a local session and rejects invalid addresses or unrelated payloads", async () => {
    const unauthenticated = await fetch(
      `${server.url}/api/settings/model/test`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: server.url },
        body: JSON.stringify({
          provider: "anthropic",
          model: "test-model",
          apiKey: KEY,
          baseUrl: root,
        }),
      },
    );
    expect(unauthenticated.status).toBe(401);
    expect((await probe({ baseUrl: "file:///tmp/model" })).status).toBe(400);
    expect((await probe({ projectId: "p_not_sent" })).status).toBe(400);
    expect(requests).toHaveLength(0);
  });
});
