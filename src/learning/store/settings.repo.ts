import type {
  Database,
  ModelSettings,
  SettingsRepo,
} from "../contracts/index.js";
import { databaseClock } from "./db.js";

const MODEL_KEY = "model";

interface SettingRow {
  value_json: string;
}

/** `SettingsRepo` — the only SQL that touches `app_settings`. */
export function createSettingsRepo(db: Database): SettingsRepo {
  const getStmt = db.raw.prepare(
    "SELECT value_json FROM app_settings WHERE key = ?",
  );
  const upsertStmt = db.raw.prepare(
    `INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at`,
  );

  return {
    model(): ModelSettings | null {
      const row = getStmt.get(MODEL_KEY) as SettingRow | undefined;
      return row ? (JSON.parse(row.value_json) as ModelSettings) : null;
    },
    putModel(s: ModelSettings): void {
      upsertStmt.run(
        MODEL_KEY,
        JSON.stringify(s),
        databaseClock(db).now().toISOString(),
      );
    },
  };
}
