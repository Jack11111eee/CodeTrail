import { describe, expect, it, vi } from "vitest";

import {
  ALLOWED_EXTERNAL_HOSTS,
  assertPublicUrl,
  isBlockedAddress,
} from "../../../src/learning/evidence/ssrf.js";
import { createExternalDocService } from "../../../src/learning/evidence/external.js";
import { createEvidenceHarness } from "../retrieval/evidence-harness.js";

const BLOCKED = [
  "127.0.0.1",
  "127.255.255.254",
  "0.0.0.0",
  "10.0.0.7",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.1.5",
  "169.254.169.254",
  "169.254.1.1",
  "100.64.0.1",
  "100.127.255.255",
  "224.0.0.1",
  "255.255.255.255",
  "::",
  "::1",
  "fe80::1",
  "febf::1",
  "fc00::1",
  "fd12:3456:789a::1",
  "ff02::1",
  "::ffff:127.0.0.1",
  "::ffff:10.0.0.7",
  "::ffff:7f00:1",
  "64:ff9b::10.0.0.7",
  "not-an-ip",
];

const PUBLIC = [
  "8.8.8.8",
  "1.1.1.1",
  "93.184.216.34",
  "172.32.0.1",
  "2606:4700:4700::1111",
  "2001:4860:4860::8888",
];

describe("isBlockedAddress", () => {
  it.each(BLOCKED)("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(PUBLIC)("allows %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  it("accepts https on an allowlisted host", () => {
    expect(() =>
      assertPublicUrl(
        new URL("https://docs.python.org/3/library/asyncio.html"),
      ),
    ).not.toThrow();
    expect(ALLOWED_EXTERNAL_HOSTS).toContain("docs.python.org");
  });

  it.each([
    "file:///etc/passwd",
    "http://docs.python.org/3/library/asyncio.html",
    "https://evil.example/x",
    "https://127.0.0.1/x",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/x",
  ])("refuses %s with external_source_unavailable", (url) => {
    expect(() => assertPublicUrl(new URL(url))).toThrowError(
      expect.objectContaining({ code: "external_source_unavailable" }),
    );
  });
});

describe("DNS rebinding", () => {
  it("checks the resolved IP after DNS, before any socket is opened", async () => {
    const harness = await createEvidenceHarness();
    const resolve = vi.fn(() => Promise.resolve(["93.184.216.34", "10.0.0.7"]));
    const fetchImpl = vi.fn();
    try {
      const external = createExternalDocService({
        paths: harness.paths,
        clock: harness.clock,
        resolve,
        fetchImpl: fetchImpl,
      });

      await expect(
        external.fetchExact({
          url: "https://docs.python.org/3/library/asyncio.html",
          locator: "x",
        }),
      ).rejects.toMatchObject({ code: "external_source_unavailable" });

      expect(resolve).toHaveBeenCalledWith("docs.python.org");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      harness.close();
    }
  });

  it("applies the same resolved-IP check to IPv6 loopback", async () => {
    const harness = await createEvidenceHarness();
    try {
      const external = createExternalDocService({
        paths: harness.paths,
        clock: harness.clock,
        resolve: () => Promise.resolve(["::1"]),
        fetchImpl: () => Promise.reject(new Error("must not fetch")),
      });
      await expect(
        external.fetchExact({
          url: "https://docs.python.org/3/library/asyncio.html",
          locator: "x",
        }),
      ).rejects.toMatchObject({ code: "external_source_unavailable" });
    } finally {
      harness.close();
    }
  });
});
