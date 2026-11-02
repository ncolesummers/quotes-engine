/**
 * Turn classification results into extraction files for `bun run import:extractions`.
 *
 *   bun run extract:assemble
 *
 * Reads `data/extractions/classified/*.json` with the matching `todo/` batches and the OCR in
 * `data/ocr`, and writes `data/extractions/<batch-name>.json`. Env: EXTRACTIONS_DIR, OCR_DIR.
 */
import { join } from "node:path";
import { assembleClassifications } from "../src/ingest/extraction/assemble";
import { DEFAULT_EXTRACTIONS_DIR } from "../src/ingest/extraction/batches";
import { CLASSIFIED_SUBDIR } from "../src/ingest/extraction/classify-batches";
import { DEFAULT_OCR_DIR } from "../src/ingest/ocr/run";

const extractionsDir = process.env.EXTRACTIONS_DIR ?? DEFAULT_EXTRACTIONS_DIR;
const summary = assembleClassifications({
  classifiedDir: join(extractionsDir, CLASSIFIED_SUBDIR),
  todoDir: join(extractionsDir, "todo"),
  ocrDir: process.env.OCR_DIR ?? DEFAULT_OCR_DIR,
  extractionsDir,
});
console.log({ ...summary, errors: summary.errors.length });
for (const e of summary.errors) {
  console.warn(`${e.file}${e.igMediaId ? ` ${e.igMediaId}` : ""}: ${e.message}`);
}
if (summary.filesFailed > 0) process.exitCode = 1;
