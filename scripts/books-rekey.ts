/**
 * Recompute every book's `normalized_key` with the current `bookKey` (#34: "&" now folds into
 * "and"). Books whose new keys would clash are listed and left alone; merge them from the
 * book page ("Merge with…"). Safe to re-run.
 *
 * Usage: bun run books:rekey [--dry-run]   (QUOTES_DB_PATH picks the database)
 */
import { openDb } from "../src/server/db/index";
import { rekeyBooks } from "../src/server/repos/book-cleanup";

const dryRun = process.argv.includes("--dry-run");
const db = openDb();
try {
  const { rekeyed, unchanged, collisions } = rekeyBooks(db, { dryRun });
  console.log(
    `${dryRun ? "[dry run] " : ""}${rekeyed} books re-keyed, ${unchanged} unchanged, ${collisions.length} collisions`,
  );
  for (const c of collisions) {
    console.log(`\n  ${c.key}`);
    for (const b of c.books)
      console.log(`    #${b.id} ${b.title ?? "(untitled)"} — ${b.author ?? "?"}`);
  }
  if (collisions.length) console.log("\nMerge these from /books/<id> → “Merge with…”.");
} finally {
  db.close();
}
