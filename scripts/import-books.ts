/**
 * Import Apple Books highlights (#6): reads copies of the Books DBs, upserts books and
 * highlights, and links highlights to posted quotes. Safe to re-run.
 *
 * Usage: bun run import:books
 *   QUOTES_DB_PATH picks the database; APPLE_BOOKS_DIR overrides the Books container
 *   (default ~/Library/Containers/com.apple.iBooksX/Data/Documents).
 */
import { formatImportSummary, importAppleBooks } from "../src/ingest/apple-books/import";
import { AppleBooksAccessError, locateBooksDbs } from "../src/ingest/apple-books/locate";
import { readAppleBooks } from "../src/ingest/apple-books/read";
import { openDb } from "../src/server/db/index";

let data: ReturnType<typeof readAppleBooks>;
try {
  data = readAppleBooks(locateBooksDbs({ baseDir: process.env.APPLE_BOOKS_DIR || undefined }));
} catch (err) {
  if (err instanceof AppleBooksAccessError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const db = openDb();
try {
  console.log(
    `Read ${data.highlights.length} highlights from ${data.books.length} books in Apple Books`,
  );
  console.log(formatImportSummary(importAppleBooks(db, data)));
} finally {
  db.close();
}
