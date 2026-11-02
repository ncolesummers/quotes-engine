import type { Database } from "bun:sqlite";

/** One author of `GET /api/authors`. */
export interface AuthorSummary {
  name: string;
  quoteCount: number;
}

/** Distinct `quotes.author` values (blank ones skipped), with quote counts, by name. */
export function listAuthors(db: Database): AuthorSummary[] {
  return db
    .query<AuthorSummary, []>(
      `SELECT trim(author) AS name, COUNT(*) AS quoteCount
       FROM quotes
       WHERE author IS NOT NULL AND trim(author) <> ''
       GROUP BY trim(author)
       ORDER BY name COLLATE NOCASE, name`,
    )
    .all();
}
