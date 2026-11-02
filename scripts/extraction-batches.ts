/**
 * Write unextracted posts into batch files for extraction subagents.
 *
 *   bun run extract:batches            # 20 posts per batch
 *   bun run extract:batches --size 10
 *
 * Writes `data/extractions/todo/batch-NNN.json` (or `$EXTRACTIONS_DIR/todo`), clearing `todo/`
 * first. Env: QUOTES_DB_PATH, MEDIA_DIR (default data/media), EXTRACTIONS_DIR.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_EXTRACTIONS_DIR,
  writeBatches,
} from "../src/ingest/extraction/batches";
import { DEFAULT_MEDIA_DIR } from "../src/ingest/instagram/sync";
import { openDb } from "../src/server/db/index";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { size: { type: "string", default: String(DEFAULT_BATCH_SIZE) } },
});
const size = Number(values.size);
if (!Number.isInteger(size) || size < 1) {
  console.error(`--size must be a positive integer, got ${values.size}`);
  process.exit(1);
}

const extractionsDir = process.env.EXTRACTIONS_DIR ?? DEFAULT_EXTRACTIONS_DIR;
const todoDir = join(extractionsDir, "todo");
const mediaDir = process.env.MEDIA_DIR ?? DEFAULT_MEDIA_DIR;

const db = openDb();
try {
  const { batches, posts, skipped, missingMedia } = writeBatches(db, { mediaDir, todoDir, size });
  console.log({
    batches: batches.length,
    posts,
    skipped,
    missingMedia: missingMedia.length,
    todoDir,
  });
  if (missingMedia.length > 0) {
    console.warn(
      `Left out ${missingMedia.length} post(s) whose images are not in ${mediaDir}; ` +
        `re-run sync:instagram, then batch again: ${missingMedia.join(", ")}`,
    );
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  db.close();
}
