/**
 * OCR every unextracted post's images locally with Apple Vision (macOS only).
 *
 *   bun run ocr                    # concurrency 4
 *   bun run ocr --concurrency 2
 *
 * Compiles scripts/ocr/ocr.swift to `$OCR_BIN` (default data/bin/ocr) on first use, then writes
 * `$OCR_DIR/<ig_media_id>.json` (default data/ocr). Images already OCR'd are skipped, so it is
 * safe to re-run. Env: QUOTES_DB_PATH, MEDIA_DIR (default data/media), OCR_DIR, OCR_BIN.
 */
import { parseArgs } from "node:util";
import { DEFAULT_MEDIA_DIR } from "../src/ingest/instagram/sync";
import { DEFAULT_OCR_CONCURRENCY, DEFAULT_OCR_DIR, runOcr } from "../src/ingest/ocr/run";
import {
  createSwiftOcrRunner,
  DEFAULT_OCR_BIN_PATH,
  ensureOcrBinary,
  isVisionOcrAvailable,
} from "../src/ingest/ocr/swift";
import { openDb } from "../src/server/db/index";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { concurrency: { type: "string", default: String(DEFAULT_OCR_CONCURRENCY) } },
});
const concurrency = Number(values.concurrency);
if (!Number.isInteger(concurrency) || concurrency < 1) {
  console.error(`--concurrency must be a positive integer, got ${values.concurrency}`);
  process.exit(1);
}
if (!isVisionOcrAvailable()) {
  console.error("OCR needs the Swift toolchain and Apple's Vision framework (macOS).");
  process.exit(1);
}

const mediaDir = process.env.MEDIA_DIR ?? DEFAULT_MEDIA_DIR;
const ocrDir = process.env.OCR_DIR ?? DEFAULT_OCR_DIR;
const binPath = ensureOcrBinary({ binPath: process.env.OCR_BIN ?? DEFAULT_OCR_BIN_PATH });

const db = openDb();
const started = performance.now();
try {
  const summary = await runOcr(db, {
    mediaDir,
    ocrDir,
    concurrency,
    runner: createSwiftOcrRunner({ binPath }),
    onPost: (_id, done, total) => {
      if (done % 25 === 0 || done === total) console.log(`OCR'd ${done}/${total} posts`);
    },
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log({
    ...summary,
    failures: summary.failures.length,
    noMedia: summary.noMedia.length,
    seconds,
    ocrDir,
  });
  for (const f of summary.failures) console.warn(`FAILED ${f.igMediaId} ${f.path}: ${f.message}`);
  if (summary.noMedia.length > 0) {
    console.warn(
      `No media on disk for ${summary.noMedia.length} post(s); re-run sync:instagram: ${summary.noMedia.join(", ")}`,
    );
  }
  if (summary.failures.length > 0) process.exitCode = 1;
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  db.close();
}
