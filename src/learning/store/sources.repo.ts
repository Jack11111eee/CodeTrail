import type {
  Database,
  GenerationId,
  SourceId,
  SourceKind,
  SourceRow,
  SourcesRepo,
} from "../contracts/index.js";

interface SourceDbRow {
  generation_id: string;
  source_id: string;
  kind: string;
  commit_sha: string;
  payload_json: string;
  content_hash: string;
}

const SELECT_COLUMNS = `SELECT generation_id, source_id, kind, commit_sha, payload_json,
  content_hash FROM sources`;

function toRecord(row: SourceDbRow): SourceRow {
  return {
    generationId: row.generation_id as GenerationId,
    sourceId: row.source_id as SourceId,
    kind: row.kind as SourceKind,
    commitSha: row.commit_sha,
    payloadJson: row.payload_json,
    contentHash: row.content_hash,
  };
}

/** `SourcesRepo` — the only SQL that touches `sources`. */
export function createSourcesRepo(db: Database): SourcesRepo {
  const insertStmt = db.raw.prepare(
    `INSERT INTO sources (generation_id, source_id, kind, commit_sha, payload_json,
       content_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const allStmt = db.raw.prepare(
    `${SELECT_COLUMNS} WHERE generation_id = ? ORDER BY source_id ASC`,
  );
  const getStmt = db.raw.prepare(
    `${SELECT_COLUMNS} WHERE generation_id = ? AND source_id = ?`,
  );

  return {
    insertMany(rows: SourceRow[]): void {
      for (const row of rows) {
        insertStmt.run(
          row.generationId,
          row.sourceId,
          row.kind,
          row.commitSha,
          row.payloadJson,
          row.contentHash,
        );
      }
    },
    all(gid: GenerationId): SourceRow[] {
      return (allStmt.all(gid) as SourceDbRow[]).map(toRecord);
    },
    get(gid: GenerationId, sourceId: SourceId): SourceRow | null {
      const row = getStmt.get(gid, sourceId) as SourceDbRow | undefined;
      return row ? toRecord(row) : null;
    },
  };
}
