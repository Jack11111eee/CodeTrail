import { describe, expect, it, vi } from "vitest";

import { sliceHash } from "../../../src/learning/contracts/index.js";
import {
  MAX_EXTERNAL_BYTES,
  createExternalDocService,
} from "../../../src/learning/evidence/external.js";
import { createEvidenceHarness } from "./evidence-harness.js";

const ALLOWED_URL = "https://docs.python.org/3/library/asyncio-task.html";

function html(body: string, title = "Coroutines and Tasks"): Response {
  return new Response(
    `<html><head><title>${title}</title></head><body>${body}</body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

async function service(
  fetchImpl: (
    input: URL | RequestInfo,
    init?: RequestInit,
  ) => Promise<Response>,
  resolve: (hostname: string) => Promise<string[]>,
) {
  const harness = await createEvidenceHarness();
  const external = createExternalDocService({
    paths: harness.paths,
    clock: harness.clock,
    resolve,
    fetchImpl: fetchImpl,
  });
  return { harness, external };
}

describe("external document service", () => {
  it("fetches an allowlisted document, reduces HTML and caches it", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(html("<h1>Hi</h1><p>Task &amp; body</p>")),
    );
    const { harness, external } = await service(fetchImpl, () =>
      Promise.resolve(["93.184.216.34"]),
    );
    try {
      const result = await external.fetchExact({
        url: ALLOWED_URL,
        locator: "coroutines",
        expectedVersion: "v3.12.0",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("expected a successful fetch");
      }
      expect(result.canonicalUrl).toBe(ALLOWED_URL);
      expect(result.versionOrRetrievedAt).toBe("v3.12.0");
      expect(result.locator).toBe("coroutines");
      expect(result.title).toBe("Coroutines and Tasks");
      expect(result.text).toContain("Task & body");
      expect(result.text).not.toContain("<p>");
      expect(result.contentHash).toBe(sliceHash(result.text));
      expect(await external.cached(result.contentHash)).toBe(result.text);
    } finally {
      harness.close();
    }
  });

  it("defaults versionOrRetrievedAt to the injected clock", async () => {
    const fetchImpl = () =>
      Promise.resolve(
        new Response("plain body", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      );
    const { harness, external } = await service(fetchImpl, () =>
      Promise.resolve(["93.184.216.34"]),
    );
    try {
      const result = await external.fetchExact({
        url: ALLOWED_URL,
        locator: "",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.versionOrRetrievedAt).toBe("2026-01-01T00:00:00.000Z");
        expect(result.text).toBe("plain body");
      }
    } finally {
      harness.close();
    }
  });

  it("refuses file:// URLs with external_source_unavailable before DNS", async () => {
    const resolve = vi.fn(() => Promise.resolve(["93.184.216.34"]));
    const fetchImpl = vi.fn();
    const { harness, external } = await service(fetchImpl as never, resolve);
    try {
      await expect(
        external.fetchExact({ url: "file:///etc/passwd", locator: "x" }),
      ).rejects.toMatchObject({ code: "external_source_unavailable" });
      expect(resolve).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      harness.close();
    }
  });

  it("rejects non-allowlisted hosts", async () => {
    const fetchImpl = vi.fn();
    const { harness, external } = await service(fetchImpl as never, () =>
      Promise.resolve(["93.184.216.34"]),
    );
    try {
      await expect(
        external.fetchExact({ url: "https://evil.example/x", locator: "x" }),
      ).rejects.toMatchObject({ code: "external_source_unavailable" });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      harness.close();
    }
  });

  it.each([
    "127.0.0.1",
    "::1",
    "10.0.0.7",
    "169.254.169.254",
    "192.168.1.5",
    "100.64.0.1",
    "fe80::1",
    "fd12:3456::1",
  ])("blocks a rebinding resolve to %s after DNS", async (address) => {
    const fetchImpl = vi.fn();
    const { harness, external } = await service(fetchImpl as never, () =>
      Promise.resolve([address]),
    );
    try {
      await expect(
        external.fetchExact({ url: ALLOWED_URL, locator: "x" }),
      ).rejects.toMatchObject({
        code: "external_source_unavailable",
        details: { reason: "blocked_host", address },
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      harness.close();
    }
  });

  it("re-validates every redirect hop and refuses a hop into private space", async () => {
    let resolutions = 0;
    const resolve = vi.fn(() => {
      resolutions += 1;
      return Promise.resolve(
        resolutions === 1 ? ["93.184.216.34"] : ["10.0.0.7"],
      );
    });
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://docs.python.org/private" },
        }),
      ),
    );
    const { harness, external } = await service(fetchImpl, resolve);
    try {
      await expect(
        external.fetchExact({ url: ALLOWED_URL, locator: "x" }),
      ).rejects.toMatchObject({ code: "external_source_unavailable" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledTimes(2);
    } finally {
      harness.close();
    }
  });

  it("refuses a redirect to a non-allowlisted host", async () => {
    const resolve = vi.fn(() => Promise.resolve(["93.184.216.34"]));
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(null, {
          status: 301,
          headers: { location: "https://evil.example/x" },
        }),
      ),
    );
    const { harness, external } = await service(fetchImpl, resolve);
    try {
      await expect(
        external.fetchExact({ url: ALLOWED_URL, locator: "x" }),
      ).rejects.toMatchObject({ code: "external_source_unavailable" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      harness.close();
    }
  });

  it("follows at most two redirect hops", async () => {
    const resolve = vi.fn(() => Promise.resolve(["93.184.216.34"]));
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(null, {
          status: 307,
          headers: { location: "https://docs.python.org/next" },
        }),
      ),
    );
    const { harness, external } = await service(fetchImpl, resolve);
    try {
      await expect(
        external.fetchExact({ url: ALLOWED_URL, locator: "x" }),
      ).rejects.toMatchObject({
        code: "external_source_unavailable",
        details: { reason: "redirect_blocked" },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      harness.close();
    }
  });

  it("returns source_missing for non-200 responses", async () => {
    const cases: [number, string][] = [
      [401, "auth_required"],
      [403, "auth_required"],
      [402, "paywalled"],
      [404, "not_found"],
      [410, "not_found"],
      [500, "network"],
    ];
    for (const [status, reason] of cases) {
      const { harness, external } = await service(
        () => Promise.resolve(new Response("x", { status })),
        () => Promise.resolve(["93.184.216.34"]),
      );
      try {
        expect(
          await external.fetchExact({ url: ALLOWED_URL, locator: "x" }),
        ).toEqual({ ok: false, status: "source_missing", reason });
      } finally {
        harness.close();
      }
    }
  });

  it("rejects non-text bodies and oversized bodies", async () => {
    const nonText = await service(
      () =>
        Promise.resolve(
          new Response("binary", {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
        ),
      () => Promise.resolve(["93.184.216.34"]),
    );
    try {
      expect(
        await nonText.external.fetchExact({ url: ALLOWED_URL, locator: "x" }),
      ).toEqual({ ok: false, status: "source_missing", reason: "non_text" });
    } finally {
      nonText.harness.close();
    }

    const tooLarge = await service(
      () =>
        Promise.resolve(
          new Response("x", {
            status: 200,
            headers: {
              "content-type": "text/plain",
              "content-length": String(MAX_EXTERNAL_BYTES + 1),
            },
          }),
        ),
      () => Promise.resolve(["93.184.216.34"]),
    );
    try {
      expect(
        await tooLarge.external.fetchExact({ url: ALLOWED_URL, locator: "x" }),
      ).toEqual({ ok: false, status: "source_missing", reason: "too_large" });
    } finally {
      tooLarge.harness.close();
    }
  });

  it("accepts a body exactly at the 2 MiB boundary", async () => {
    const body = "a".repeat(MAX_EXTERNAL_BYTES);
    const { harness, external } = await service(
      () =>
        Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
        ),
      () => Promise.resolve(["93.184.216.34"]),
    );
    try {
      const result = await external.fetchExact({
        url: ALLOWED_URL,
        locator: "x",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.text.length).toBe(MAX_EXTERNAL_BYTES);
      }
    } finally {
      harness.close();
    }
  });

  it("maps transport and DNS failures to source_missing/network", async () => {
    const fetchFails = await service(
      () => Promise.reject(new Error("socket hang up")),
      () => Promise.resolve(["93.184.216.34"]),
    );
    try {
      expect(
        await fetchFails.external.fetchExact({
          url: ALLOWED_URL,
          locator: "x",
        }),
      ).toEqual({ ok: false, status: "source_missing", reason: "network" });
    } finally {
      fetchFails.harness.close();
    }

    const dnsFails = await service(
      () => Promise.resolve(html("never")),
      () => Promise.reject(new Error("ENOTFOUND")),
    );
    try {
      expect(
        await dnsFails.external.fetchExact({ url: ALLOWED_URL, locator: "x" }),
      ).toEqual({ ok: false, status: "source_missing", reason: "network" });
    } finally {
      dnsFails.harness.close();
    }
  });
});
