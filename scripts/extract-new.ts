/**
 * Extract quotes from new (unextracted) posts end to end, with no Claude Code session:
 * OCR → classification batches → `claude -p --model haiku` per batch → assemble → import.
 *
 *   bun run extract:new
 *   bun run extract:new --size 10
 *
 * Exits early, without OCR or spawning anything, when every post is extracted. Posts stay
 * unextracted on any failure, so the next run retries them. Exits 1 when anything failed.
 *
 * Env: QUOTES_DB_PATH, MEDIA_DIR (default data/media), OCR_DIR (default data/ocr),
 * EXTRACTIONS_DIR (default data/extractions), OCR_BIN (default data/bin/ocr),
 * CLAUDE_BIN (default `claude` from PATH), CLASSIFY_TIMEOUT_MS (default 300000).
 * Relative paths are resolved against the repo root, which is also the agents' cwd.
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_BATCH_SIZE, DEFAULT_EXTRACTIONS_DIR } from "../src/ingest/extraction/batches";
import {
  createClaudeClassifier,
  DEFAULT_CLASSIFY_TIMEOUT_MS,
} from "../src/ingest/extraction/claude";
import { extractNewPosts } from "../src/ingest/extraction/incremental";
import { DEFAULT_MEDIA_DIR } from "../src/ingest/instagram/sync";
import { DEFAULT_OCR_DIR, type OcrRunner } from "../src/ingest/ocr/run";
import {
  createSwiftOcrRunner,
  DEFAULT_OCR_BIN_PATH,
  ensureOcrBinary,
  isVisionOcrAvailable,
} from "../src/ingest/ocr/swift";
import { DEFAULT_DB_PATH, openDb } from "../src/server/db/index";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { size: { type: "string", default: String(DEFAULT_BATCH_SIZE) } },
});
const batchSize = Number(values.size);
if (!Number.isInteger(batchSize) || batchSize < 1) {
  console.error(`--size must be a positive integer, got ${values.size}`);
  process.exit(1);
}
const timeoutMs = Number(process.env.CLASSIFY_TIMEOUT_MS ?? DEFAULT_CLASSIFY_TIMEOUT_MS);

const repoRoot = resolve(import.meta.dir, "..");
const fromRoot = (p: string) => resolve(repoRoot, p);
const paths = {
  mediaDir: fromRoot(process.env.MEDIA_DIR ?? DEFAULT_MEDIA_DIR),
  ocrDir: fromRoot(process.env.OCR_DIR ?? DEFAULT_OCR_DIR),
  extractionsDir: fromRoot(process.env.EXTRACTIONS_DIR ?? DEFAULT_EXTRACTIONS_DIR),
  cwd: repoRoot,
};

// Compiled on first use only, so a run with nothing new stays cheap.
let ocrRunner: OcrRunner | undefined;
const runOcr: OcrRunner = (images) => {
  if (!ocrRunner) {
    if (!isVisionOcrAvailable()) {
      throw new Error("OCR needs the Swift toolchain and Apple's Vision framework (macOS).");
    }
    const binPath = ensureOcrBinary({
      binPath: fromRoot(process.env.OCR_BIN ?? DEFAULT_OCR_BIN_PATH),
    });
    ocrRunner = createSwiftOcrRunner({ binPath });
  }
  return ocrRunner(images);
};

const claudeBin = process.env.CLAUDE_BIN ?? Bun.which("claude");
if (!claudeBin) {
  console.error("`claude` (Claude Code CLI) is not on PATH; set CLAUDE_BIN to its full path.");
  process.exit(1);
}

const db = openDb(fromRoot(process.env.QUOTES_DB_PATH ?? DEFAULT_DB_PATH));
const started = performance.now();
try {
  const summary = await extractNewPosts({
    db,
    paths,
    runOcr,
    runClassifier: createClaudeClassifier({ bin: claudeBin, timeoutMs }),
    batchSize,
    log: (m) => console.warn(m),
  });
  const { errors, batchRuns, ...counts } = summary;
  for (const r of batchRuns) {
    const cost = r.costUsd === undefined ? "" : ` $${r.costUsd.toFixed(4)}`;
    console.log(
      `${r.ok ? "ok    " : "FAILED"} ${r.batch} ${(r.durationMs / 1000).toFixed(1)}s${cost}${r.result ? ` — ${r.result}` : ""}`,
    );
  }
  console.log({
    ...counts,
    costUsd: Number(summary.costUsd.toFixed(4)),
    errors: errors.length,
    seconds: Number(((performance.now() - started) / 1000).toFixed(1)),
    extractionsDir: paths.extractionsDir,
  });
  if (errors.length > 0) process.exitCode = 1;
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  db.close();
}
