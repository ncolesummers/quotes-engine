/**
 * Import extraction result files from `data/extractions/*.json` (or `EXTRACTIONS_DIR`) into the
 * quotes DB. Processed files move to `imported/`, invalid ones to `failed/`.
 *
 * Usage: bun run import:extractions
 */
import { join } from "node:path";
import { importExtractions, listExtractionFiles } from "../src/ingest/extraction/import";
import { openDb } from "../src/server/db/index";

const dir = process.env.EXTRACTIONS_DIR ?? "data/extractions";
const files = listExtractionFiles(dir);

if (files.length === 0) {
  console.log(`No extraction files in ${dir}`);
} else {
  const db = openDb();
  try {
    const summary = importExtractions(db, files, {
      importedDir: join(dir, "imported"),
      failedDir: join(dir, "failed"),
    });
    const { errors, ...counts } = summary;
    console.log(counts);
    for (const e of errors) {
      console.error(`${e.file}${e.igMediaId ? ` [${e.igMediaId}]` : ""}: ${e.message}`);
    }
    if (errors.length > 0) process.exitCode = 1;
  } finally {
    db.close();
  }
}
