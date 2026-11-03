import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createJsonLogger } from "../../../src/learning/api/log.ts";
import {
  assertInsideDataDir,
  ensureDataDir,
  resolveDataPaths,
} from "../../../src/learning/config/paths.ts";
import { migrate, openDatabase } from "../../../src/learning/store/index.ts";
import { createClock } from "../../../src/learning/testing/clock.ts";

/**
 * AC-OPS-07: the default root is `~/.codetrail`, `CODETRAIL_DATA_DIR` is
 * honoured, and every write the module performs lands inside that root. A
 * sibling directory's mtime and sha256 are the witness: if any path escaped,
 * they would change.
 */

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-boundary-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function isUnder(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Recursive `relative path -> {mtimeMs, sha256}` snapshot of a file tree. */
function snapshotTree(
  root: string,
  prefix = "",
): Record<string, { mtimeMs: number; sha256: string }> {
  const out: Record<string, { mtimeMs: number; sha256: string }> = {};
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      Object.assign(out, snapshotTree(absolute, relative));
    } else if (entry.isFile()) {
      out[relative] = {
        mtimeMs: fs.statSync(absolute).mtimeMs,
        sha256: sha256(absolute),
      };
    }
  }
  return out;
}

describe("data-directory boundary", () => {
  it("defaults to ~/.codetrail and honours CODETRAIL_DATA_DIR", () => {
    const realHome = fs.realpathSync(os.homedir());
    const defaultPaths = resolveDataPaths({});
    expect(defaultPaths.root).toBe(path.join(realHome, ".codetrail"));

    const configured = makeTempDir();
    const paths = resolveDataPaths({ CODETRAIL_DATA_DIR: configured });
    expect(paths.root).toBe(fs.realpathSync(configured));
    expect(paths.db).toBe(path.join(paths.root, "db", "codetrail.sqlite"));
    expect(paths.mirrors).toBe(path.join(paths.root, "mirrors"));
    expect(paths.work).toBe(path.join(paths.root, "work"));
    expect(paths.knowledge).toBe(path.join(paths.root, "knowledge"));
    expect(paths.staging).toBe(path.join(paths.root, "staging"));
    expect(paths.logs).toBe(path.join(paths.root, "logs"));
    expect(paths.credentials).toBe(path.join(paths.root, "credentials.json"));
    expect(paths.session).toBe(path.join(paths.root, "session.json"));
  });

  it("creates every managed directory inside the root only", async () => {
    const parent = makeTempDir();
    const dataDir = path.join(parent, "data");
    const sibling = path.join(parent, "sibling");
    fs.mkdirSync(sibling);
    const witness = path.join(sibling, "witness.txt");
    fs.writeFileSync(witness, "do not touch", "utf8");

    const beforeStat = fs.statSync(witness);
    const beforeSha = sha256(witness);

    const paths = resolveDataPaths({ CODETRAIL_DATA_DIR: dataDir });
    await ensureDataDir(paths);
    fs.writeFileSync(
      path.join(paths.knowledge, "written-inside.json"),
      JSON.stringify({ ok: true }),
      "utf8",
    );

    for (const value of Object.values(paths)) {
      if (typeof value !== "string") continue;
      expect(isUnder(paths.root, value)).toBe(true);
    }
    expect(fs.statSync(witness).mtimeMs).toBe(beforeStat.mtimeMs);
    expect(sha256(witness)).toBe(beforeSha);
  });

  it("leaves every path outside the data directory unchanged during a write cycle", async () => {
    const parent = makeTempDir();
    const dataDir = path.join(parent, "data");
    const outside = path.join(parent, "outside");
    fs.mkdirSync(path.join(outside, "nested"), { recursive: true });
    fs.writeFileSync(path.join(outside, "a.txt"), "alpha", "utf8");
    fs.writeFileSync(path.join(outside, "nested", "b.txt"), "beta", "utf8");
    const before = snapshotTree(outside);

    const paths = resolveDataPaths({ CODETRAIL_DATA_DIR: dataDir });
    await ensureDataDir(paths);

    const clock = createClock("2026-01-01T00:00:00.000Z");
    const db = openDatabase({ file: paths.db, clock });
    try {
      migrate(db);
    } finally {
      db.close();
    }

    createJsonLogger({
      file: path.join(paths.logs, "codetrail.jsonl"),
      clock,
      redact: (text) => text,
    }).event({ event: "boundary_check", level: "info" });
    fs.writeFileSync(
      path.join(paths.knowledge, "lesson.json"),
      JSON.stringify({ ok: true }),
      "utf8",
    );

    expect(snapshotTree(outside)).toEqual(before);
    for (const value of Object.values(paths)) {
      if (typeof value !== "string") continue;
      expect(isUnder(paths.root, value)).toBe(true);
    }
  });

  it("rejects every escape from the data directory", () => {
    const parent = makeTempDir();
    const dataDir = path.join(parent, "data");
    const paths = resolveDataPaths({ CODETRAIL_DATA_DIR: dataDir });
    fs.mkdirSync(dataDir, { recursive: true });

    expect(() => assertInsideDataDir(paths, "../escape")).toThrowError(
      /out_of_scope_path|超出允许范围/u,
    );
    expect(() =>
      assertInsideDataDir(paths, path.join(parent, "outside")),
    ).toThrow();
    const inside = path.join(paths.knowledge, "lesson.json");
    expect(assertInsideDataDir(paths, inside)).toBe(
      path.join(fs.realpathSync(dataDir), "knowledge", "lesson.json"),
    );
  });

  it("the operator scripts' sandbox mirror agrees with assertInsideDataDir", async () => {
    // The `.mjs` scripts cannot import the TypeScript module, so `backup.mjs`
    // mirrors `assertInsideDataDir`; this pins the two implementations
    // together so a future edit cannot silently weaken the restore sandbox.
    const { assertInsideRoot } =
      (await import("../../../scripts/backup.mjs")) as {
        assertInsideRoot: (
          paths: { root: string },
          candidate: string,
        ) => string;
      };
    const parent = makeTempDir();
    const paths = resolveDataPaths({
      CODETRAIL_DATA_DIR: path.join(parent, "data"),
    });
    await ensureDataDir(paths);

    const inside = path.join(paths.knowledge, "lesson.json");
    expect(assertInsideRoot(paths, inside)).toBe(
      assertInsideDataDir(paths, inside),
    );

    for (const escape of [
      "../escape",
      path.join(parent, "outside"),
      path.join(paths.root, "..", "sibling"),
      "knowledge/../../outside",
    ]) {
      expect(() => assertInsideDataDir(paths, escape)).toThrow();
      expect(() => assertInsideRoot(paths, escape)).toThrowError(
        /out_of_scope_path|outside the data directory/u,
      );
    }
  });
});
