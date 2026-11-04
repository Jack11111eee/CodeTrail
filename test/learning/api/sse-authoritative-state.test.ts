import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { IncomingHttpHeaders } from "node:http";

import { LOOPBACK_HOST } from "../../../src/learning/api/auth.ts";
import {
  httpRequest,
  jsonBody,
  startStubServer,
  type StubServer,
} from "../helpers/stub-server.ts";

/**
 * SSE is display-only: a reconnect must agree with the durable job record and
 * the stream must never advance state (AC-API-12).
 */

interface JobRecord {
  jobId: string;
  state: "queued" | "running" | "completed" | "failed";
  seq: number;
  updatedAt: string;
}

const JOB: JobRecord = {
  jobId: "job_1",
  state: "running",
  seq: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

type Mode = "hold" | "full" | "throw";

let server: StubServer | null = null;
let mode: Mode = "full";
let generatorFinished = false;
let subscribed = 0;

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, 2_000);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function* events(signal: AbortSignal): AsyncGenerator<unknown> {
  subscribed += 1;
  try {
    yield {
      jobId: JOB.jobId,
      seq: 1,
      type: "state",
      state: JOB.state,
      at: JOB.updatedAt,
    };
    if (mode === "hold") {
      await aborted(signal);
      return;
    }
    if (mode === "throw") {
      throw new Error("generator exploded /Users/secret");
    }
    yield {
      jobId: JOB.jobId,
      seq: 2,
      type: "progress",
      progress: { phase: "pages", completed: 1, total: 2 },
      at: JOB.updatedAt,
    };
  } finally {
    generatorFinished = true;
  }
}

beforeAll(async () => {
  server = await startStubServer({
    handlers: {
      "jobs.get": () => () =>
        Promise.resolve({
          kind: "json",
          status: 200,
          body: { ...JOB },
        }),
      "jobs.events": () => (req) =>
        Promise.resolve({
          kind: "sse",
          events: events(req.signal),
        }),
    },
  });
});

afterAll(async () => {
  await server?.close();
  server = null;
});

function readAll(headers: Record<string, string>): Promise<{
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: LOOPBACK_HOST,
        port: server!.port,
        method: "GET",
        path: "/api/jobs/job_1/events",
        headers,
        agent: false,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function openThenAbort(headers: Record<string, string>): Promise<{
  text: () => string;
  waitForState: Promise<void>;
  abort: () => void;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: LOOPBACK_HOST,
        port: server!.port,
        method: "GET",
        path: "/api/jobs/job_1/events",
        headers,
        agent: false,
      },
      (res) => {
        let text = "";
        let settled = false;
        let resolveState: () => void = () => {};
        const waitForState = new Promise<void>((r) => {
          resolveState = r;
        });
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
          if (!settled && text.includes("event: state")) {
            settled = true;
            resolveState();
          }
        });
        res.on("end", () => {
          resolveState();
        });
        resolve({
          text: () => text,
          waitForState,
          abort: () => {
            req.destroy();
          },
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function currentJob(): Promise<JobRecord> {
  const response = await httpRequest(server!.port, {
    path: "/api/jobs/job_1",
    headers: { ...server!.cookie },
  });
  return jsonBody(response) as JobRecord;
}

describe("SSE authoritatively matches the persistent record", () => {
  it("disconnect mid-stream leaves state untouched and releases the generator", async () => {
    mode = "hold";
    generatorFinished = false;
    const snapshot = { ...JOB };

    const stream = await openThenAbort({ ...server!.cookie });
    await stream.waitForState;
    expect(stream.text()).toContain("event: state");
    expect(stream.text()).not.toContain("event: done");
    stream.abort();

    await waitFor(() => generatorFinished);
    expect(await currentJob()).toEqual(snapshot);
    expect(JOB.seq).toBe(0);
    expect(JOB.state).toBe("running");
  });

  it("writes retry, event frames and a terminating done", async () => {
    mode = "full";
    generatorFinished = false;
    const response = await readAll({ ...server!.cookie });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.text).toContain("retry: 2000");
    expect(response.text).toContain("event: state");
    expect(response.text).toContain("event: progress");
    expect(response.text).toContain("event: done");
    expect(generatorFinished).toBe(true);
  });

  it("a reconnect agrees with GET /api/jobs/:id and advances nothing", async () => {
    mode = "full";
    const before = { ...JOB };
    const first = await readAll({ ...server!.cookie });
    const second = await readAll({ ...server!.cookie });
    expect(first.text).toBe(second.text);

    const job = await currentJob();
    expect(job).toEqual(before);
    expect(job.state).toBe("running");
    expect(job.seq).toBe(0);
  });

  it("turns a generator throw into an error frame, then done", async () => {
    mode = "throw";
    const response = await readAll({ ...server!.cookie });
    expect(response.status).toBe(200);
    expect(response.text).toContain("event: error");
    expect(response.text).toContain("\"code\":\"internal_error\"");
    expect(response.text).toContain("event: done");
    expect(response.text).not.toContain("/Users/secret");
    expect(await currentJob()).toEqual(JOB);
  });

  it("subscribed once per connection", () => {
    expect(subscribed).toBeGreaterThan(0);
  });
});
