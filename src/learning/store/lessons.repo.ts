import type {
  Database,
  GenerationId,
  LessonId,
  LessonKind,
  LessonRow,
  LessonsRepo,
} from "../contracts/index.js";

interface LessonDbRow {
  lesson_id: string;
  generation_id: string;
  kind: string;
  title: string;
  rel_path: string;
  json_sha256: string;
  published_at: string;
  deleted_at: string | null;
}

const SELECT_COLUMNS = `SELECT lesson_id, generation_id, kind, title, rel_path,
  json_sha256, published_at, deleted_at FROM lessons`;

function toRecord(row: LessonDbRow): LessonRow {
  return {
    lessonId: row.lesson_id as LessonId,
    generationId: row.generation_id as GenerationId,
    kind: row.kind as LessonKind,
    title: row.title,
    relPath: row.rel_path,
    jsonSha256: row.json_sha256,
    publishedAt: row.published_at,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
  };
}

/** `LessonsRepo` — the only SQL that touches `lessons`. */
export function createLessonsRepo(db: Database): LessonsRepo {
  const insertStmt = db.raw.prepare(
    `INSERT INTO lessons (lesson_id, generation_id, kind, title, rel_path,
       json_sha256, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const listStmt = db.raw.prepare(
    `${SELECT_COLUMNS} WHERE generation_id = ? ORDER BY lesson_id ASC`,
  );
  const byIdStmt = db.raw.prepare(
    `${SELECT_COLUMNS} WHERE generation_id = ? AND lesson_id = ?`,
  );

  return {
    insertMany(rows: LessonRow[]): void {
      for (const row of rows) {
        insertStmt.run(
          row.lessonId,
          row.generationId,
          row.kind,
          row.title,
          row.relPath,
          row.jsonSha256,
          row.publishedAt,
        );
      }
    },
    listByGeneration(
      gid: GenerationId,
      opts?: { includeDeleted?: boolean },
    ): LessonRow[] {
      return (listStmt.all(gid) as LessonDbRow[])
        .filter((row) => opts?.includeDeleted || row.deleted_at === null)
        .map(toRecord);
    },
    byId(
      gid: GenerationId,
      lessonId: LessonId,
      opts?: { includeDeleted?: boolean },
    ): LessonRow | null {
      const row = byIdStmt.get(gid, lessonId) as LessonDbRow | undefined;
      return row && (opts?.includeDeleted || row.deleted_at === null)
        ? toRecord(row)
        : null;
    },
    setDeleted(gid: GenerationId, lessonId: LessonId, at: string | null): void {
      db.raw
        .prepare(
          "UPDATE lessons SET deleted_at = ? WHERE generation_id = ? AND lesson_id = ?",
        )
        .run(at, gid, lessonId);
    },
  };
}
