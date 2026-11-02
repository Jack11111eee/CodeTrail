import {
  decodeCursor,
  type CursorJson,
  type CursorKind,
  type CursorUpdate,
  type CursorsRepo,
  type Database,
  type RepoId,
} from "../contracts/index.js";
import { databaseClock } from "./db.js";

interface CursorRow {
  cursor_json: string;
}

const SELECT_CURSOR =
  "SELECT cursor_json FROM watch_cursors WHERE repo_id = ? AND stream_id = ? AND kind = ?";

/** `CursorsRepo` — the only SQL that touches `watch_cursors`. */
export function createCursorsRepo(db: Database): CursorsRepo {
  const getStmt = db.raw.prepare(SELECT_CURSOR);
  const upsertStmt = db.raw.prepare(
    `INSERT INTO watch_cursors (repo_id, stream_id, kind, cursor_json, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, stream_id, kind) DO UPDATE SET
       cursor_json = excluded.cursor_json,
       updated_at = excluded.updated_at`,
  );

  return {
    get(repoId: RepoId, streamId: string, kind: CursorKind): CursorJson | null {
      const row = getStmt.get(repoId, streamId, kind) as CursorRow | undefined;
      return row ? decodeCursor(row.cursor_json) : null;
    },
    put(update: CursorUpdate): boolean {
      return db.transaction(() => {
        const row = getStmt.get(update.repoId, update.streamId, update.kind) as
          CursorRow | undefined;
        const current = row ? decodeCursor(row.cursor_json) : null;
        const expected = update.expectedPrevious;
        if (expected !== null) {
          const currentHead = current?.headSha ?? null;
          const currentUpdatedAt = current?.updatedAt ?? null;
          if (
            currentHead !== expected.headSha ||
            currentUpdatedAt !== expected.updatedAt
          ) {
            return false;
          }
        }
        const updatedAt =
          update.cursor.lastPollAt ?? databaseClock(db).now().toISOString();
        upsertStmt.run(
          update.repoId,
          update.streamId,
          update.kind,
          JSON.stringify(update.cursor),
          updatedAt,
        );
        return true;
      });
    },
  };
}
