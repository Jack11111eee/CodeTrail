import type {
  Database,
  GenerationId,
  ProjectId,
  RepoId,
  SourceId,
  TermId,
  TermsRepo,
  TermView,
} from "../contracts/index.js";

interface TermRow {
  term_id: string;
  zh: string;
  en: string;
  symbols_json: string;
}

interface TermLinkRow {
  generation_id: string;
  source_id: string;
  repo_id: string;
  project_id: string;
}

const SELECT_TERMS = "SELECT term_id, zh, en, symbols_json FROM terms";

const SELECT_LINKS = `SELECT tl.generation_id, tl.source_id, g.repo_id, g.project_id
  FROM term_links tl
  JOIN generations g ON g.generation_id = tl.generation_id
  WHERE tl.term_id = ? AND g.project_id IS NOT NULL
  ORDER BY tl.generation_id ASC, tl.source_id ASC`;

/** `TermsRepo` — the only SQL that touches `terms` and `term_links`. */
export function createTermsRepo(db: Database): TermsRepo {
  const listStmt = db.raw.prepare(
    `${SELECT_TERMS} ORDER BY zh ASC, term_id ASC`,
  );
  const searchStmt = db.raw.prepare(
    `${SELECT_TERMS} WHERE zh LIKE ? OR en LIKE ? ORDER BY zh ASC, term_id ASC`,
  );
  const byIdStmt = db.raw.prepare(`${SELECT_TERMS} WHERE term_id = ?`);
  const linksStmt = db.raw.prepare(SELECT_LINKS);
  const linkStmt = db.raw.prepare(
    `INSERT OR IGNORE INTO term_links (term_id, generation_id, source_id)
     VALUES (?, ?, ?)`,
  );

  const toView = (row: TermRow): TermView => ({
    termId: row.term_id as TermId,
    zh: row.zh,
    en: row.en,
    symbols: JSON.parse(row.symbols_json) as string[],
    links: (linksStmt.all(row.term_id) as TermLinkRow[]).map((link) => ({
      generationId: link.generation_id as GenerationId,
      repoId: link.repo_id as RepoId,
      projectId: link.project_id as ProjectId,
      sourceId: link.source_id as SourceId,
    })),
  });

  return {
    list(q?: string): TermView[] {
      const rows = (
        q === undefined ? listStmt.all() : searchStmt.all(`%${q}%`, `%${q}%`)
      ) as TermRow[];
      return rows.map(toView);
    },
    byId(id: TermId): TermView | null {
      const row = byIdStmt.get(id) as TermRow | undefined;
      return row ? toView(row) : null;
    },
    linkTerm(i: {
      termId: TermId;
      generationId: GenerationId;
      sourceId: SourceId;
    }): void {
      linkStmt.run(i.termId, i.generationId, i.sourceId);
    },
  };
}
