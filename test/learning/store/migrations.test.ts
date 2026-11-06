import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MIGRATIONS,
  migrate,
  openDatabase,
} from "../../../src/learning/store/index.ts";
import { AT, closeTempDb, createTempDb, type TempDb } from "./helpers.ts";

/** The DDL's twenty-two tables; `migrations` is the bookkeeping one. */
const EXPECTED_TABLES = [
  "app_settings",
  "change_events",
  "conversation_selections",
  "conversations",
  "generations",
  "job_attempts",
  "jobs",
  "learner_preferences",
  "lessons",
  "learning_topics",
  "messages",
  "migrations",
  "preference_meta",
  "projects",
  "reading_positions",
  "repos",
  "snapshots",
  "sources",
  "term_links",
  "terms",
  "usage_records",
  "watch_cursors",
].sort();

const EXPECTED_INDEXES = [
  "idx_conversations_gens",
  "idx_events_linked",
  "idx_events_project",
  "idx_events_stream",
  "idx_generations_kind",
  "idx_generations_repo",
  "idx_generations_status",
  "idx_jobs_state",
  "idx_jobs_stream_running",
  "idx_lessons_generation",
  "idx_learning_topics_generation",
  "idx_messages_conversation",
  "idx_messages_streaming",
  "idx_projects_repo",
  "idx_selections_conversation",
  "idx_sources_commit",
].sort();

const STORE_DIR = fileURLToPath(
  new URL("../../../src/learning/store", import.meta.url),
);
const SRC_LEARNING = fileURLToPath(
  new URL("../../../src/learning", import.meta.url),
);

function tableNames(db: TempDb["db"]): string[] {
  const rows = db.raw
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

function indexNames(db: TempDb["db"]): string[] {
  const rows = db.raw
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

describe("store migrations", () => {
  let ctx: TempDb;

  beforeEach(() => {
    ctx = createTempDb();
  });

  afterEach(() => {
    closeTempDb(ctx);
  });

  it("creates the twenty-one domain tables plus the migrations table", () => {
    expect(tableNames(ctx.db)).toEqual(EXPECTED_TABLES);
    expect(
      EXPECTED_TABLES.filter((name) => name !== "migrations"),
    ).toHaveLength(21);
  });

  it("creates every listed index", () => {
    expect(indexNames(ctx.db)).toEqual(EXPECTED_INDEXES);
  });

  it("applies nothing on a second migrate()", () => {
    expect(migrate(ctx.db)).toEqual({ applied: 0, version: 3 });
    expect(migrate(ctx.db)).toEqual({ applied: 0, version: 3 });
    expect(tableNames(ctx.db)).toEqual(EXPECTED_TABLES);
  });

  it("applies migrations exactly once and records it durably across reconnects", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codetrail-migrate-"));
    const file = path.join(dir, "fresh.sqlite");

    const first = openDatabase({ file });
    try {
      expect(migrate(first)).toEqual({ applied: 3, version: 3 });
      const rows = first.raw
        .prepare("SELECT version, applied_at FROM migrations ORDER BY version")
        .all() as { version: number; applied_at: string }[];
      expect(rows.map((row) => row.version)).toEqual([1, 2, 3]);
      expect(Number.isNaN(Date.parse(rows[0]?.applied_at ?? ""))).toBe(false);
    } finally {
      first.close();
    }

    // A fresh connection (a restarted process) reads the bookkeeping row and
    // applies nothing, even though the connection is brand new.
    const second = openDatabase({ file });
    try {
      expect(migrate(second)).toEqual({ applied: 0, version: 3 });
      expect(tableNames(second)).toEqual(EXPECTED_TABLES);
    } finally {
      second.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upgrades an existing v1 lesson without changing its content metadata", () => {
    const db = openDatabase({ file: path.join(ctx.dir, "legacy.sqlite") });
    try {
      db.raw.exec(MIGRATIONS[0].sql);
      db.raw
        .prepare("INSERT INTO migrations(version,applied_at) VALUES (?,?)")
        .run(1, AT);
      db.raw
        .prepare(
          "INSERT INTO generations(generation_id,cache_key,repo_id,commit_sha,scope_hash,config_hash,prompt_template_version,preferences_version,upstream_version,status,content_dir,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          "g_old",
          "cache_old",
          "r_old",
          "a".repeat(40),
          "scope",
          "config",
          "prompt",
          1,
          "upstream",
          "published",
          "/tmp/old",
          AT,
        );
      db.raw
        .prepare(
          "INSERT INTO lessons(lesson_id,generation_id,kind,title,rel_path,json_sha256,published_at) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          "l_old",
          "g_old",
          "research",
          "Old title",
          "lessons/l_old.json",
          "unchanged-hash",
          AT,
        );
      expect(migrate(db)).toEqual({ applied: 2, version: 3 });
      expect(
        db.raw
          .prepare(
            "SELECT title,json_sha256,deleted_at FROM lessons WHERE lesson_id=?",
          )
          .get("l_old"),
      ).toEqual({
        title: "Old title",
        json_sha256: "unchanged-hash",
        deleted_at: null,
      });
      expect(migrate(db)).toEqual({ applied: 0, version: 3 });
    } finally {
      db.close();
    }
  });

  it("opens with WAL, foreign keys and a 5000 ms busy timeout", () => {
    const journal = ctx.db.raw.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    expect(journal.journal_mode).toBe("wal");

    const foreignKeys = ctx.db.raw.prepare("PRAGMA foreign_keys").get() as {
      foreign_keys: number;
    };
    expect(Number(foreignKeys.foreign_keys)).toBe(1);

    const busyTimeout = ctx.db.raw.prepare("PRAGMA busy_timeout").get() as {
      timeout: number;
    };
    expect(Number(busyTimeout.timeout)).toBe(5000);
  });

  it("enforces foreign keys", () => {
    expect(() =>
      ctx.db.raw
        .prepare(
          `INSERT INTO messages (message_id, conversation_id, role, content, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("m_orphan", "c_missing", "user", "hi", "complete", AT),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("has no column named or shaped as a mastery, proficiency or ability score", () => {
    const forbidden = /mastery|proficien|ability|score/i;
    const offenders: string[] = [];
    for (const table of tableNames(ctx.db)) {
      const columns = ctx.db.raw
        .prepare(`PRAGMA table_info(${table})`)
        .all() as { name: string }[];
      for (const column of columns) {
        if (forbidden.test(column.name)) {
          offenders.push(`${table}.${column.name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(MIGRATIONS[0]?.sql ?? "").not.toMatch(forbidden);
  });

  it("keeps every repository method synchronous", () => {
    for (const name of fs.readdirSync(STORE_DIR)) {
      if (!name.endsWith(".repo.ts")) {
        continue;
      }
      const source = fs.readFileSync(path.join(STORE_DIR, name), "utf8");
      expect(source, name).not.toMatch(/\basync\b/);
      expect(source, name).not.toMatch(/\bawait\b/);
    }
  });

  it("keeps all SQL inside store/*.repo.ts", () => {
    const sql =
      /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE)\b/i;
    const leaks: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (full !== STORE_DIR) {
            walk(full);
          }
          continue;
        }
        if (!entry.name.endsWith(".ts")) {
          continue;
        }
        if (sql.test(fs.readFileSync(full, "utf8"))) {
          leaks.push(path.relative(SRC_LEARNING, full));
        }
      }
    };
    walk(SRC_LEARNING);
    expect(leaks).toEqual([]);
  });
});
