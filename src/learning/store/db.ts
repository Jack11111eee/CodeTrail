import { DatabaseSync } from "node:sqlite";

import type { Clock, Database, SqliteHandle } from "../contracts/index.js";

export type { Database };

export interface OpenDatabaseOptions {
  file: string;
  readOnly?: boolean;
  clock?: Clock;
}

/** Milliseconds a writer waits for a competing lock before failing (§13.1). */
export const BUSY_TIMEOUT_MS = 5000;

const SYSTEM_CLOCK: Clock = {
  now: () => new Date(),
  set: () => undefined,
  advance: () => undefined,
};

/**
 * The clock a `Database` was opened with. `openDatabase` stores it on the
 * handle, so repositories can derive `updated_at`/`applied_at` values from the
 * same source the caller injected (tests can freeze time without stubbing the
 * global `Date`).
 */
const CLOCK = Symbol.for("codetrail.store.clock");

interface ClockedDatabase extends Database {
  [CLOCK]?: Clock;
}

export function databaseClock(db: Database): Clock {
  return (db as ClockedDatabase)[CLOCK] ?? SYSTEM_CLOCK;
}

/**
 * Open the single writer connection (§13.1, §7.1).
 *
 * `journal_mode=WAL`, `foreign_keys=ON` and `busy_timeout=5000` are applied to
 * every connection. Transactions are serialised in-process: a nested
 * `transaction`/`readTransaction` call joins the transaction already open on the
 * connection instead of issuing a second `BEGIN`, so a publish transaction can
 * call repository methods without opening a second writer.
 */
export function openDatabase(opts: OpenDatabaseOptions): Database {
  const raw = new DatabaseSync(opts.file, {
    readOnly: opts.readOnly ?? false,
    enableForeignKeyConstraints: true,
    timeout: BUSY_TIMEOUT_MS,
  }) as unknown as SqliteHandle;

  if (!opts.readOnly) {
    // `:memory:` databases answer "memory"; a file database answers "wal".
    raw.exec("PRAGMA journal_mode = WAL");
  }
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);

  let inTransaction = false;

  const begin = (mode: "IMMEDIATE" | "DEFERRED"): void => {
    raw.exec(`BEGIN ${mode}`);
  };

  const runInTransaction = <T>(
    mode: "IMMEDIATE" | "DEFERRED",
    fn: () => T,
  ): T => {
    if (inTransaction) {
      return fn();
    }
    begin(mode);
    inTransaction = true;
    try {
      const result = fn();
      raw.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        raw.exec("ROLLBACK");
      } catch {
        // The transaction may already have been rolled back by SQLite.
      }
      throw error;
    } finally {
      inTransaction = false;
    }
  };

  const db: ClockedDatabase = {
    raw,
    transaction<T>(fn: () => T): T {
      return runInTransaction("IMMEDIATE", fn);
    },
    readTransaction<T>(fn: () => T): T {
      return runInTransaction("DEFERRED", fn);
    },
    close(): void {
      raw.close();
    },
  };
  db[CLOCK] = opts.clock ?? SYSTEM_CLOCK;
  return db;
}
