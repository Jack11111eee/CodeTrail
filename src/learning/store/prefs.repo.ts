import type {
  ConversationId,
  Database,
  GenerationId,
  LearnerPreferences,
  LessonId,
  PreferencesRepo,
  ReadingPosition,
} from "../contracts/index.js";
import { databaseClock } from "./db.js";

interface PreferenceRow {
  key: string;
  value: string;
}

interface PositionRow {
  generation_id: string;
  lesson_id: string;
  conversation_id: string | null;
  offset: number;
  updated_at: string;
}

const DEFAULT_EXPLAIN_LEVEL: LearnerPreferences["explainLevel"] = "plain_first";
const DEFAULT_LANGUAGE: LearnerPreferences["language"] = "zh";

function readJson<T>(raw: string | undefined, fallback: T): T {
  if (raw === undefined) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** `PreferencesRepo` — the only SQL that touches `learner_preferences`,
 *  `preference_meta` and `reading_positions`. */
export function createPreferencesRepo(db: Database): PreferencesRepo {
  const listStmt = db.raw.prepare(
    "SELECT key, value FROM learner_preferences ORDER BY key ASC",
  );
  const upsertStmt = db.raw.prepare(
    `INSERT INTO learner_preferences (key, value, version, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       version = excluded.version,
       updated_at = excluded.updated_at`,
  );
  const metaStmt = db.raw.prepare(
    "SELECT version FROM preference_meta WHERE id = 1",
  );
  const upsertMetaStmt = db.raw.prepare(
    `INSERT INTO preference_meta (id, version) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET version = excluded.version`,
  );
  const positionsStmt = db.raw.prepare(
    `SELECT generation_id, lesson_id, conversation_id, offset, updated_at
     FROM reading_positions ORDER BY generation_id ASC, lesson_id ASC`,
  );
  const upsertPositionStmt = db.raw.prepare(
    `INSERT INTO reading_positions (generation_id, lesson_id, conversation_id, offset, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(generation_id, lesson_id) DO UPDATE SET
       conversation_id = excluded.conversation_id,
       offset = excluded.offset,
       updated_at = excluded.updated_at`,
  );

  const version = (): number => {
    const row = metaStmt.get() as { version: number } | undefined;
    return row ? row.version : 0;
  };

  const get = (): LearnerPreferences => {
    const rows = listStmt.all() as PreferenceRow[];
    const values = new Map(rows.map((row) => [row.key, row.value]));
    return {
      explainLevel: readJson<LearnerPreferences["explainLevel"]>(
        values.get("explain_level"),
        DEFAULT_EXPLAIN_LEVEL,
      ),
      background: readJson<LearnerPreferences["background"]>(
        values.get("background"),
        null,
      ),
      language: readJson<LearnerPreferences["language"]>(
        values.get("language"),
        DEFAULT_LANGUAGE,
      ),
      version: version(),
    };
  };

  return {
    get,
    put(patch: Partial<LearnerPreferences>): LearnerPreferences {
      return db.transaction(() => {
        const current = get();
        const entries: [string, unknown][] = [];
        if (patch.explainLevel !== undefined) {
          entries.push(["explain_level", patch.explainLevel]);
        }
        if (patch.background !== undefined) {
          entries.push(["background", patch.background]);
        }
        if (patch.language !== undefined) {
          entries.push(["language", patch.language]);
        }
        if (entries.length === 0) {
          return current;
        }
        const nextVersion = current.version + 1;
        const updatedAt = databaseClock(db).now().toISOString();
        for (const [key, value] of entries) {
          upsertStmt.run(key, JSON.stringify(value), nextVersion, updatedAt);
        }
        upsertMetaStmt.run(nextVersion);
        return get();
      });
    },
    version,
    readingPositions(): ReadingPosition[] {
      return (positionsStmt.all() as PositionRow[]).map((row) => ({
        generationId: row.generation_id as GenerationId,
        lessonId: row.lesson_id as LessonId,
        conversationId: row.conversation_id as ConversationId | null,
        offset: row.offset,
        updatedAt: row.updated_at,
      }));
    },
    clearReadingPosition(gid: GenerationId, lessonId: LessonId): void {
      db.raw
        .prepare(
          "DELETE FROM reading_positions WHERE generation_id = ? AND lesson_id = ?",
        )
        .run(gid, lessonId);
    },
    putReadingPosition(pos: ReadingPosition): void {
      upsertPositionStmt.run(
        pos.generationId,
        pos.lessonId,
        pos.conversationId,
        pos.offset,
        pos.updatedAt,
      );
    },
  };
}
