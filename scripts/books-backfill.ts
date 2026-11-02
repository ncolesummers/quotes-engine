/**
 * Link existing quotes to books (#25): keys Apple Books records, then links quotes by
 * `source_title`/`author` and through linked highlights. Safe to re-run.
 *
 * Usage: bun run books:backfill   (QUOTES_DB_PATH picks the database)
 */
import { openDb } from "../src/server/db/index";
import { backfillBooks } from "../src/server/repos/books";

const db = openDb();
try {
  const summary = backfillBooks(db);
  const { quotes, linked, books } = db
    .query<{ quotes: number; linked: number; books: number }, []>(
      `SELECT (SELECT COUNT(*) FROM quotes) AS quotes,
         (SELECT COUNT(*) FROM quotes WHERE book_id IS NOT NULL) AS linked,
         (SELECT COUNT(*) FROM books) AS books`,
    )
    .get() ?? { quotes: 0, linked: 0, books: 0 };
  console.log(summary);
  console.log(`${linked}/${quotes} quotes linked to a book; ${books} books total`);
} finally {
  db.close();
}
