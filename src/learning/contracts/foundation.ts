import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import type { ModelSettings } from "./store.js";

export interface DataPaths {
  /** Absolute, realpath-resolved. */
  root: string;
  /** <root>/db/codetrail.sqlite */
  db: string;
  /** <root>/mirrors */
  mirrors: string;
  /** <root>/work */
  work: string;
  /** <root>/knowledge */
  knowledge: string;
  /** <root>/staging — the ONLY per-job build area. */
  staging: string;
  /** <root>/external */
  external: string;
  /** <root>/logs */
  logs: string;
  /** <root>/backups */
  backups: string;
  /** <root>/credentials.json (0600). */
  credentials: string;
  /** <root>/session.json (0600). */
  session: string;
  /** <root>/openwiki-home */
  openwikiHome: string;
}

/**
 * Structural view of node:sqlite's `DatabaseSync`. Declared structurally so that
 * contracts/ carries no `node:*` import while `store/db.ts` returns the real
 * thing (a `DatabaseSync` is assignable to `SqliteHandle`).
 */
export interface SqlitePreparedStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
}

export interface SqliteHandle {
  prepare(sql: string): SqlitePreparedStatement;
  exec(sql: string): void;
  close(): void;
}

export interface Database {
  readonly raw: SqliteHandle;
  /** BEGIN IMMEDIATE / COMMIT / ROLLBACK. */
  transaction<T>(fn: () => T): T;
  /** BEGIN DEFERRED. */
  readTransaction<T>(fn: () => T): T;
  close(): void;
}

export type ModelRole = "repo_job" | "page_worker" | "lesson" | "qa" | "change";

/**
 * Type-only alias for @langchain/core's `BaseChatModel`; `import type` is
 * erased, so contracts/ keeps zero runtime dependencies and stays
 * browser-importable.
 */
export type ChatModelLike = BaseChatModel;

export interface ModelHandle {
  readonly modelId: string;
  readonly settings: ModelSettings;
  chat(): ChatModelLike;
  estimate(
    role: ModelRole,
    promptTokens: number,
  ): { calls: number; tokens: number };
}
