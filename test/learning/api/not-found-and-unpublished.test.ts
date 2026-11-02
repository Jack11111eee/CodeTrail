import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LearningError } from "../../../src/learning/contracts/index.ts";
import {
  errorCode,
  httpRequest,
  jsonBody,
  startStubServer,
  type StubServer,
} from "../helpers/stub-server.ts";

/**
 * Unknown ids and unpublished generations never return 200 with an empty body
 * (AC-API-03), and the four failure classes stay distinct (AC-API-06):
 * a missing row, an unpublished generation, an unconfigured model, and plain
 * published content that still reads.
 */

let server: StubServer | null = null;

beforeAll(async () => {
  server = await startStubServer({
    handlers: {
      "projects.get": () => () => {
        throw new LearningError("not_found", "项目不存在", {
          projectId: "prj_missing",
        });
      },
      "generations.lessons": () => () => {
        throw new LearningError("unpublished_generation", "该生成版本尚未发布", {
          generationId: "gen_staged",
          status: "staged",
        });
      },
      "analyses.create": () => () => {
        throw new LearningError("model_not_configured", "模型尚未配置", {
          reason: "no_model",
        });
      },
      "generations.lesson": () => () =>
        Promise.resolve({
          kind: "json",
          status: 200,
          body: { lesson: { title: "published" } },
        }),
    },
  });
});

afterAll(async () => {
  await server?.close();
  server = null;
});

describe("not found and unpublished", () => {
  it("returns 404 not_found for an unknown id", async () => {
    const response = await httpRequest(server!.port, {
      path: "/api/projects/prj_missing",
      headers: { ...server!.cookie },
    });
    expect(response.status).toBe(404);
    expect(errorCode(response)).toBe("not_found");
    expect(response.text.length).toBeGreaterThan(0);
  });

  it("returns 404 not_found for an unknown path", async () => {
    const response = await httpRequest(server!.port, {
      path: "/api/nothing-here",
      headers: { ...server!.cookie },
    });
    expect(response.status).toBe(404);
    expect(errorCode(response)).toBe("not_found");
  });

  it("returns 409 unpublished_generation for a staged generation", async () => {
    const response = await httpRequest(server!.port, {
      path: "/api/generations/gen_staged/lessons",
      headers: { ...server!.cookie },
    });
    expect(response.status).toBe(409);
    expect(errorCode(response)).toBe("unpublished_generation");
    const body = jsonBody(response) as {
      error?: { details?: { status?: string } };
    };
    expect(body.error?.details?.status).toBe("staged");
  });

  it("never answers an error with 200 and an empty body", async () => {
    for (const path of [
      "/api/projects/prj_missing",
      "/api/generations/gen_staged/lessons",
      "/api/nothing-here",
    ]) {
      const response = await httpRequest(server!.port, {
        path,
        headers: { ...server!.cookie },
      });
      expect(response.status).not.toBe(200);
      expect(errorCode(response)).toBeTypeOf("string");
    }
  });
});

describe("unconfigured model (AC-API-06)", () => {
  it("fails a new analysis with 400 model_not_configured", async () => {
    const response = await httpRequest(server!.port, {
      method: "POST",
      path: "/api/projects/prj_1/analyses",
      headers: { ...server!.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main" }),
    });
    expect(response.status).toBe(400);
    expect(errorCode(response)).toBe("model_not_configured");
  });

  it("still serves existing published content with 200", async () => {
    const response = await httpRequest(server!.port, {
      path: "/api/generations/gen_1/lessons/lesson_1",
      headers: { ...server!.cookie },
    });
    expect(response.status).toBe(200);
    expect(jsonBody(response)).toEqual({ lesson: { title: "published" } });
  });
});
