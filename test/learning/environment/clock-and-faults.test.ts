import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { LearningError } from "../../../src/learning/contracts/index.js";
import { createClock } from "../../../src/learning/testing/clock.js";
import {
  FAULT_POINT_NAMES,
  faultPoint,
  makeBareRemote,
  type FaultPointName,
} from "../../../src/learning/testing/faults.js";

/**
 * Clock, fault points and the bare Git remote (architecture §17.3, PRD §15.2
 * items 3–5).
 *
 * The fault switch must terminate exactly one process — the one whose
 * `CODETRAIL_FAULT_INJECT` matches — so every crash test runs it in a child.
 * Time is driven by `set`/`advance`; no test sleeps.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TSX_CLI = path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
const FAULTS_SOURCE = path.join(REPO_ROOT, "src/learning/testing/faults.ts");

let rootDir: string;
let childFile: string;

beforeAll(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-faults-"));
  childFile = path.join(rootDir, "fault-child.ts");
  fs.writeFileSync(
    childFile,
    [
      `import { faultPoint } from ${JSON.stringify(pathToFileURL(FAULTS_SOURCE).href)};`,
      "",
      'const point = process.env.CODETRAIL_TEST_POINT as "seal" | "rename" | "tx_before" | "tx_after";',
      "faultPoint(point);",
      "process.exitCode = 3;",
      "",
    ].join("\n"),
    "utf8",
  );
});

afterAll(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.CODETRAIL_FAULT_INJECT;
  delete process.env.CODETRAIL_NOW;
});

function runFaultChild(
  point: FaultPointName,
  injected: string | undefined,
): number | null {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODETRAIL_TEST_POINT: point,
  };
  if (injected === undefined) {
    delete env.CODETRAIL_FAULT_INJECT;
  } else {
    env.CODETRAIL_FAULT_INJECT = injected;
  }
  const result = spawnSync(process.execPath, [TSX_CLI, childFile], {
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  return result.status;
}

describe("createClock", () => {
  it("starts at the fixed instant and returns fresh Date values", () => {
    const clock = createClock("2025-01-02T03:04:05.000Z");

    expect(clock.now().toISOString()).toBe("2025-01-02T03:04:05.000Z");

    const handedOut = clock.now();
    handedOut.setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe("2025-01-02T03:04:05.000Z");
  });

  it("applies set and advance without touching the wall clock", () => {
    const clock = createClock("2025-01-02T03:04:05.000Z");

    clock.advance(1_500);
    expect(clock.now().toISOString()).toBe("2025-01-02T03:04:06.500Z");

    clock.set("2030-12-31T23:59:59.000Z");
    expect(clock.now().toISOString()).toBe("2030-12-31T23:59:59.000Z");

    clock.advance(-1_000);
    expect(clock.now().toISOString()).toBe("2030-12-31T23:59:58.000Z");
  });

  it("honours CODETRAIL_NOW when no fixed instant is given", () => {
    process.env.CODETRAIL_NOW = "2024-06-01T00:00:00.000Z";
    expect(createClock().now().toISOString()).toBe("2024-06-01T00:00:00.000Z");
  });

  it("rejects an invalid fixed instant or CODETRAIL_NOW with invalid_input", () => {
    expect(() => createClock("not-a-date")).toThrowError(LearningError);

    process.env.CODETRAIL_NOW = "not-a-date";
    let error: unknown = null;
    try {
      createClock();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LearningError);
    expect((error as LearningError).code).toBe("invalid_input");
  });

  it("prefers an explicit fixed instant over CODETRAIL_NOW", () => {
    process.env.CODETRAIL_NOW = "2024-06-01T00:00:00.000Z";
    expect(createClock("2025-01-02T03:04:05.000Z").now().toISOString()).toBe(
      "2025-01-02T03:04:05.000Z",
    );
  });

  it("rejects an invalid set instant", () => {
    const clock = createClock("2025-01-02T03:04:05.000Z");
    expect(() => clock.set("not-a-date")).toThrowError(LearningError);
    expect(clock.now().toISOString()).toBe("2025-01-02T03:04:05.000Z");
  });

  it("rejects a non-finite advance", () => {
    const clock = createClock("2025-01-02T03:04:05.000Z");
    expect(() => clock.advance(Number.NaN)).toThrowError(LearningError);
    expect(() => clock.advance(Number.POSITIVE_INFINITY)).toThrowError(
      LearningError,
    );
  });

  it("falls back to the live clock for a blank CODETRAIL_NOW", () => {
    const before = Date.now();
    process.env.CODETRAIL_NOW = "   ";
    const clock = createClock();
    expect(clock.now()).toBeInstanceOf(Date);
    expect(clock.now().getTime()).toBeGreaterThanOrEqual(before);
  });

  it("ignores malformed runtime variables other than CODETRAIL_NOW", () => {
    process.env.CODETRAIL_PORT = "abc";
    process.env.CODETRAIL_WATCH_INTERVAL_MS = "nope";
    try {
      expect(createClock("2025-01-02T03:04:05.000Z").now().toISOString()).toBe(
        "2025-01-02T03:04:05.000Z",
      );
    } finally {
      delete process.env.CODETRAIL_PORT;
      delete process.env.CODETRAIL_WATCH_INTERVAL_MS;
    }
  });
});

describe("faultPoint", () => {
  it("is a no-op when the injected fault is absent or different", () => {
    faultPoint("seal");

    process.env.CODETRAIL_FAULT_INJECT = "rename";
    faultPoint("seal");
    faultPoint("tx_before");
    faultPoint("tx_after");

    process.env.CODETRAIL_FAULT_INJECT = "seal ";
    expect(process.env.CODETRAIL_FAULT_INJECT.trim()).toBe("seal");
  });

  it("exits 1 in a child only when the injected fault matches", () => {
    for (const point of FAULT_POINT_NAMES) {
      expect(runFaultChild(point, point), `${point} match`).toBe(1);
      const other = FAULT_POINT_NAMES.find((name) => name !== point);
      expect(other, point).toBeDefined();
      expect(runFaultChild(point, other), `${point} mismatch`).toBe(3);
      expect(runFaultChild(point, undefined), `${point} unset`).toBe(3);
    }
  });

  it("ignores a fault-name typo", () => {
    expect(runFaultChild("seal", "seel")).toBe(3);
  });

  it("is case-sensitive", () => {
    expect(runFaultChild("seal", "SEAL")).toBe(3);
    expect(runFaultChild("tx_before", "TX_BEFORE")).toBe(3);
  });

  it("treats a blank injected value as no fault", () => {
    expect(runFaultChild("seal", "")).toBe(3);
    expect(runFaultChild("seal", "   ")).toBe(3);
  });

  it("trims surrounding whitespace like the env parser", () => {
    // `resolveEnv` trims every value it reads, so `CODETRAIL_FAULT_INJECT`
    // inherits the same normalisation.
    expect(runFaultChild("seal", " seal ")).toBe(1);
    expect(runFaultChild("rename", "\trename\n")).toBe(1);
  });

  it("lists exactly the four publish fault points", () => {
    expect([...FAULT_POINT_NAMES]).toEqual([
      "seal",
      "rename",
      "tx_before",
      "tx_after",
    ]);
  });
});

describe("makeBareRemote", () => {
  it("returns an absolute file:// URL and the repository is clone-able", () => {
    const fixturesDir = path.join(rootDir, "fixtures");
    const barePath = path.join(fixturesDir, "watch-remote.git");
    fs.mkdirSync(fixturesDir, { recursive: true });
    execFileSync("git", ["init", "--bare", "--quiet", barePath], {
      encoding: "utf8",
    });

    const remote = makeBareRemote(fixturesDir, "watch-remote");
    expect(remote.startsWith("file://")).toBe(true);
    expect(path.isAbsolute(fileURLToPath(remote))).toBe(true);
    expect(fileURLToPath(remote)).toBe(barePath);
    expect(makeBareRemote(fixturesDir, "watch-remote.git")).toBe(remote);

    const clonePath = path.join(rootDir, "clone");
    execFileSync("git", ["clone", "--quiet", remote, clonePath], {
      encoding: "utf8",
    });
    expect(fs.existsSync(path.join(clonePath, ".git"))).toBe(true);
  });

  it("defaults to the bare .git suffix when neither directory exists", () => {
    const missing = makeBareRemote(path.join(rootDir, "nothing-here"), "gone");
    expect(
      fileURLToPath(missing).endsWith(path.join("nothing-here", "gone.git")),
    ).toBe(true);
  });
});
