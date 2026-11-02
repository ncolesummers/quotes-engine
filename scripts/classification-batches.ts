/**
 * Write unextracted posts, with their numbered OCR lines, into batch files for classification
 * subagents. Run `bun run ocr` first.
 *
 *   bun run extract:classify-batches            # 20 posts per batch
 *   bun run extract:classify-batches --size 10
 *
 * Writes `data/extractions/todo/batch-NNN.json` (or `$EXTRACTIONS_DIR/todo`), clearing `todo/`
 * first. Env: QUOTES_DB_PATH, MEDIA_DIR (default data/media), OCR_DIR (default data/ocr),
 * EXTRACTIONS_DIR.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_BATCH_SIZE, DEFAULT_EXTRACTIONS_DIR } from "../src/ingest/extraction/batches";
import { writeClassificationBatches } from "../src/ingest/extraction/classify-batches";
import { DEFAULT_MEDIA_DIR } from "../src/ingest/instagram/sync";
import { DEFAULT_OCR_DIR } from "../src/ingest/ocr/run";
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
const ocrDir = process.env.OCR_DIR ?? DEFAULT_OCR_DIR;

const db = openDb();
try {
  const s = writeClassificationBatches(db, { mediaDir, ocrDir, todoDir, size });
  console.log({
    batches: s.batches.length,
    posts: s.posts,
    skipped: s.skipped,
    missingMedia: s.missingMedia.length,
    missingOcr: s.missingOcr.length,
    todoDir,
  });
  if (s.missingMedia.length > 0) {
    console.warn(
      `Left out ${s.missingMedia.length} post(s) whose images are not in ${mediaDir}; ` +
        `re-run sync:instagram: ${s.missingMedia.join(", ")}`,
    );
  }
  if (s.missingOcr.length > 0) {
    console.warn(
      `Left out ${s.missingOcr.length} post(s) not fully OCR'd; run \`bun run ocr\`: ` +
        s.missingOcr.join(", "),
    );
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  db.close();
}
