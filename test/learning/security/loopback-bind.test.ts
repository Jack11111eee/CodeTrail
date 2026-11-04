import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertLoopbackListenHost,
  assertLoopbackPeer,
  LOOPBACK_HOST,
} from "../../../src/learning/api/auth.ts";
import { LearningError } from "../../../src/learning/contracts/index.ts";

/**
 * Loopback-only binding (AC-SEC-01).
 *
 * The listener address is fixed at `127.0.0.1`; the guard refuses every other
 * value, which is what `api/cli.ts` uses for `--host`. A non-loopback socket
 * peer is refused as well.
 */

function expectCode(run: () => void, code: string, status: number): void {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LearningError);
  const error = caught as LearningError;
  expect(error.code).toBe(code);
  expect(error.status).toBe(status);
}

describe("assertLoopbackListenHost", () => {
  it("allows the default and explicit 127.0.0.1", () => {
    expect(() => {
      assertLoopbackListenHost();
    }).not.toThrow();
    expect(() => {
      assertLoopbackListenHost(undefined);
    }).not.toThrow();
    expect(() => {
      assertLoopbackListenHost(null);
    }).not.toThrow();
    expect(() => {
      assertLoopbackListenHost("");
    }).not.toThrow();
    expect(() => {
      assertLoopbackListenHost("127.0.0.1");
    }).not.toThrow();
  });

  it("rejects --host 0.0.0.0 with invalid_input", () => {
    expectCode(
      () => {
        assertLoopbackListenHost("0.0.0.0");
      },
      "invalid_input",
      400,
    );
  });

  it("rejects every other bind address", () => {
    for (const host of [
      "::",
      "[::]",
      "::1",
      "localhost",
      "192.168.1.10",
      "10.0.0.1",
      "127.0.0.2",
      "127.0.0.1.evil.example",
      "example.com",
    ]) {
      expectCode(
        () => {
          assertLoopbackListenHost(host);
        },
        "invalid_input",
        400,
      );
    }
  });

  it("has no environment seam: an external host env value is ignored", () => {
    const previous = process.env.CODETRAIL_HOST;
    process.env.CODETRAIL_HOST = "0.0.0.0";
    try {
      // The guard is driven by argv only; the presence of an env var cannot
      // widen the bind.
      expect(() => {
        assertLoopbackListenHost();
      }).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.CODETRAIL_HOST;
      else process.env.CODETRAIL_HOST = previous;
    }
  });
});

describe("assertLoopbackPeer", () => {
  it("accepts loopback peers and a missing address", () => {
    for (const address of [
      undefined,
      null,
      "",
      "127.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
    ]) {
      expect(() => {
        assertLoopbackPeer(address);
      }).not.toThrow();
    }
  });

  it("rejects a remote peer with forbidden_origin", () => {
    for (const address of ["192.168.1.9", "8.8.8.8", "::ffff:8.8.8.8"]) {
      expectCode(
        () => {
          assertLoopbackPeer(address);
        },
        "forbidden_origin",
        403,
      );
    }
  });
});

describe("the listener really binds 127.0.0.1", () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    if (server !== null) {
      const closing = server;
      server = null;
      await new Promise<void>((resolve, reject) => {
        closing.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it("binds the loopback interface on an ephemeral port", async () => {
    assertLoopbackListenHost(LOOPBACK_HOST);
    const created = http.createServer((_req, res) => {
      res.end("ok");
    });
    server = created;
    await new Promise<void>((resolve, reject) => {
      created.once("error", reject);
      created.listen(0, LOOPBACK_HOST, () => {
        created.off("error", reject);
        resolve();
      });
    });

    const address = created.address() as AddressInfo;
    expect(address.address).toBe("127.0.0.1");
    expect(address.family).toBe("IPv4");
    expect(address.port).toBeGreaterThan(0);
  });
});
