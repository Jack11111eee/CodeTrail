import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRepositories } from "../../../src/learning/store/index.ts";
import type { Repositories } from "../../../src/learning/contracts/index.ts";
import {
  closeTempDb,
  createTempDb,
  makeChange,
  makeGeneration,
  makeJob,
  makeRepo,
  type TempDb,
} from "./helpers.ts";

/**
 * Writes a `running`/`cancelling` job from a *separate OS process*.
 *
 * An in-process check would pass even if `idx_jobs_stream_running` were
 * missing, because the application never inserts twice. Only a second process
 * exercises the database-level guarantee AC-GEN-06 relies on.
 */
const CHILD_SCRIPT = `
import { DatabaseSync } from "node:sqlite";

const [, , file, jobId, dedupeKey, state, streamArg] = process.argv;
const streamId = streamArg === "NULL" ? null : streamArg;
const db = new DatabaseSync(file, { timeout: 5000 });
db.exec("PRAGMA busy_timeout = 5000");
try {
  db.prepare(
    "INSERT INTO jobs (job_id, dedupe_key, kind, repo_id, project_id, stream_id, state, payload_json, attempt, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    jobId,
    dedupeKey,
    "change_analysis",
    "r_child",
    null,
    streamId,
    state,
    "{}",
    0,
    new Date().toISOString(),
  );
  process.stdout.write("INSERTED");
} catch (error) {
  process.stdout.write("CONSTRAINT:" + (error && error.message ? error.message : String(error)));
} finally {
  db.close();
}
`;

let childCounter = 0;

function insertFromChild(
  ctx: TempDb,
  jobId: string,
  state: string,
  streamId: string | null,
): string {
  childCounter += 1;
  const scriptPath = path.join(
    ctx.dir,
    `child-${process.pid}-${childCounter}.mjs`,
  );
  fs.writeFileSync(scriptPath, CHILD_SCRIPT, "utf8");
  return execFileSync(
    process.execPath,
    [scriptPath, ctx.file, jobId, `dk_${jobId}`, state, streamId ?? "NULL"],
    { encoding: "utf8" },
  );
}

describe("store constraints", () => {
  let ctx: TempDb;
  let repos: Repositories;

  beforeEach(() => {
    ctx = createTempDb();
    repos = createRepositories(ctx.db);
  });

  afterEach(() => {
    closeTempDb(ctx);
  });

  it("rejects a second running row for one stream across two processes", () => {
    repos.jobs.insert(
      makeJob({ jobId: "j_local", streamId: "stream-1", state: "running" }),
    );

    const output = insertFromChild(ctx, "j_child", "running", "stream-1");

    expect(output).toMatch(/^CONSTRAINT:/);
    expect(output).toMatch(/UNIQUE constraint failed: jobs\.stream_id/);
    expect(repos.jobs.listByStream("stream-1")).toHaveLength(1);
  });

  it("rejects a second cancelling row for one stream across two processes", () => {
    repos.jobs.insert(
      makeJob({ jobId: "j_local", streamId: "stream-2", state: "running" }),
    );

    const output = insertFromChild(ctx, "j_child", "cancelling", "stream-2");

    expect(output).toMatch(/^CONSTRAINT:/);
  });

  it("declares idx_jobs_stream_running as a partial unique index on stream_id", () => {
    const indexes = ctx.db.raw.prepare("PRAGMA index_list('jobs')").all() as {
      name: string;
      unique: number;
      partial: number;
    }[];
    const running = indexes.find(
      (index) => index.name === "idx_jobs_stream_running",
    );
    expect(running).toBeDefined();
    expect(Number(running?.unique)).toBe(1);
    expect(Number(running?.partial)).toBe(1);

    const columns = ctx.db.raw
      .prepare("PRAGMA index_info('idx_jobs_stream_running')")
      .all() as { name: string }[];
    expect(columns.map((column) => column.name)).toEqual(["stream_id"]);

    const row = ctx.db.raw
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_jobs_stream_running'",
      )
      .get() as { sql: string };
    expect(row.sql).toMatch(/CREATE\s+UNIQUE\s+INDEX[\s\S]*ON\s+jobs\s*\(\s*stream_id\s*\)/);
    expect(row.sql).toMatch(
      /WHERE\s+state\s+IN\s*\(\s*'running'\s*,\s*'cancelling'\s*\)\s+AND\s+stream_id\s+IS\s+NOT\s+NULL/,
    );
  });

  it("leaves NULL stream_id rows unconstrained", () => {
    repos.jobs.insert(
      makeJob({ jobId: "j_local", streamId: null, state: "running" }),
    );

    expect(insertFromChild(ctx, "j_child_a", "running", null)).toBe("INSERTED");
    expect(insertFromChild(ctx, "j_child_b", "running", null)).toBe("INSERTED");
  });

  it("allows a second row when the first is not running or cancelling", () => {
    repos.jobs.insert(
      makeJob({ jobId: "j_local", streamId: "stream-3", state: "running" }),
    );

    expect(insertFromChild(ctx, "j_child", "completed", "stream-3")).toBe(
      "INSERTED",
    );
  });

  it("rejects a duplicate change_events.event_key", () => {
    repos.changes.insertMany([makeChange({ eventId: "e_a", eventKey: "ek" })]);
    expect(() =>
      repos.changes.insertMany([
        makeChange({ eventId: "e_b", eventKey: "ek" }),
      ]),
    ).toThrow(/UNIQUE constraint failed: change_events\.event_key/);
  });

  it("rejects a duplicate jobs.dedupe_key", () => {
    repos.jobs.insert(makeJob({ jobId: "j_a", dedupeKey: "dk" }));
    expect(() =>
      repos.jobs.insert(makeJob({ jobId: "j_b", dedupeKey: "dk" })),
    ).toThrow(/UNIQUE constraint failed: jobs\.dedupe_key/);
  });

  it("rejects a duplicate repos.identity", () => {
    const insert = ctx.db.raw.prepare(
      `INSERT INTO repos (repo_id, identity, kind, mirror_path, remote_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run("r_a", "github:owner/repo", "github", "/tmp/a", null, "t");
    expect(() =>
      insert.run("r_b", "github:owner/repo", "github", "/tmp/b", null, "t"),
    ).toThrow(/UNIQUE constraint failed: repos\.identity/);
  });

  it("rejects a duplicate generations.cache_key", () => {
    repos.generations.insertPublished(
      makeGeneration({ generationId: "g_a", cacheKey: "ck" }),
    );
    expect(() =>
      repos.generations.insertPublished(
        makeGeneration({ generationId: "g_b", cacheKey: "ck" }),
      ),
    ).toThrow(/UNIQUE constraint failed: generations\.cache_key/);
  });

  it("reuses an existing repo on upsert instead of duplicating it", () => {
    const first = makeRepo({ repoId: "r_a", identity: "github:owner/repo" });
    expect(repos.repos.upsert(first)).toEqual(first);
    expect(
      repos.repos.upsert({ ...first, repoId: "r_b" as typeof first.repoId }),
    ).toEqual(first);
    expect(repos.repos.byIdentity("github:owner/repo")?.repoId).toBe("r_a");
  });
});
