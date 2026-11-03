import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { listUnextractedPosts, requeuePosts } from "../../server/repos/posts";
import { type OcrRunner, runOcr as runOcrStep } from "../ocr/run";
import { assembleClassifications } from "./assemble";
import { DEFAULT_BATCH_SIZE } from "./batches";
import { buildClassificationPrompt } from "./classification-prompt";
import { CLASSIFIED_SUBDIR, writeClassificationBatches } from "./classify-batches";
import { importExtractions, listExtractionFiles, moveInto } from "./import";

export interface IncrementalPaths {
  mediaDir: string;
  ocrDir: string;
  /** e.g. `data/extractions`; holds `todo/`, `classified/`, `imported/`, ... */
  extractionsDir: string;
}

/**
 * The classifier's working directory, under the extractions dir. Each agent gets a fresh one
 * holding only a copy of its batch, and writes its result there; the result moves to
 * `classified/` only once the run has been verified. Anything found here at start-up is from an
 * interrupted, unverified run and is discarded.
 */
export const STAGING_SUBDIR = "classifying";

/** One classification batch for one headless agent run. */
export interface ClassifyRequest {
  batchPath: string;
  /** Where the agent must write its result (inside `cwd`). */
  outPath: string;
  /** The full classification prompt for this batch. */
  prompt: string;
  cwd: string;
  /** Directories outside `cwd` the agent may read and write (none for the incremental run). */
  addDirs: string[];
}

export interface ClassifyOutcome {
  /** null when the process was killed. */
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** The agent's own error flag (`is_error` in `--output-format json`). */
  isError?: boolean;
  /** The agent's final reply. */
  result?: string;
  costUsd?: number;
  durationMs?: number;
}

/** Runs one agent on one batch. Should resolve, not reject; a rejection is treated as a failure. */
export type Classifier = (req: ClassifyRequest) => Promise<ClassifyOutcome>;

export interface ExtractNewOptions {
  db: Database;
  paths: IncrementalPaths;
  /** Per-image OCR (the Vision CLI in production). */
  runOcr: OcrRunner;
  runClassifier: Classifier;
  now?: () => Date;
  batchSize?: number;
  log?: (message: string) => void;
  /**
   * `ig_media_id`s to extract again even though they were extracted (e.g. wrongly marked
   * `no_quote`): they are queued before the run looks for new posts. Unknown ids are errors.
   */
  redo?: readonly string[];
}

export type IncrementalStage =
  | "redo"
  | "stale"
  | "ocr"
  | "batches"
  | "classify"
  | "assemble"
  | "import";

export interface IncrementalError {
  stage: IncrementalStage;
  /** Batch file name, or `ig_media_id`, when the error is about one. */
  subject?: string;
  message: string;
}

export interface BatchRun {
  batch: string;
  ok: boolean;
  durationMs: number;
  costUsd?: number;
  result?: string;
}

export interface StaleSummary {
  /** Classification files left by an earlier run, assembled before anything else. */
  classified: number;
  /** Extraction files left by an earlier run (including those just assembled). */
  extractionFiles: number;
  postsExtracted: number;
}

export interface ExtractNewSummary {
  /** Set when results from an earlier run were waiting. */
  stale?: StaleSummary;
  /** Posts queued again by `redo`. */
  requeued: number;
  /** Unextracted posts after any stale results were imported (and `redo` posts queued). */
  unextracted: number;
  /** Images OCR'd in this run (already-OCR'd images are skipped). */
  ocrImages: number;
  batches: number;
  /** Batches whose agent succeeded and wrote a result file. */
  classified: number;
  batchRuns: BatchRun[];
  postsExtracted: number;
  /** Quotes newly created in the catalog. */
  quotesImported: number;
  /** Post–quote links written. */
  quotesLinked: number;
  needsReview: number;
  costUsd: number;
  errors: IncrementalError[];
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Extract quotes from posts that haven't been extracted yet, with no Claude Code session: OCR →
 * classification batches → one headless Haiku run per batch (line refs and metadata only, never
 * quote text) → assemble → import. Batches run one at a time.
 *
 * Posts are only marked extracted by the import of an assembled result, so any failure (OCR, a
 * non-zero exit, a timeout, a missing or invalid result file) leaves them queued for the next run.
 * Results left by an earlier, interrupted run are assembled and imported first.
 */
export async function extractNewPosts({
  db,
  paths,
  runOcr,
  runClassifier,
  now = () => new Date(),
  batchSize = DEFAULT_BATCH_SIZE,
  log = () => {},
  redo = [],
}: ExtractNewOptions): Promise<ExtractNewSummary> {
  const { extractionsDir, mediaDir, ocrDir } = paths;
  const todoDir = join(extractionsDir, "todo");
  const classifiedDir = join(extractionsDir, CLASSIFIED_SUBDIR);
  const stagingDir = resolve(extractionsDir, STAGING_SUBDIR);
  const summary: ExtractNewSummary = {
    requeued: 0,
    unextracted: 0,
    ocrImages: 0,
    batches: 0,
    classified: 0,
    batchRuns: [],
    postsExtracted: 0,
    quotesImported: 0,
    quotesLinked: 0,
    needsReview: 0,
    costUsd: 0,
    errors: [],
  };
  const fail = (stage: IncrementalStage, message: string, subject?: string) => {
    summary.errors.push({ stage, message, ...(subject ? { subject } : {}) });
    log(`[${stage}]${subject ? ` ${subject}` : ""} ${message}`);
  };

  /** Assemble every waiting classification file, then import every waiting extraction file. */
  const assembleAndImport = (stage: "stale" | "assemble") => {
    const assembled = assembleClassifications({ classifiedDir, todoDir, ocrDir, extractionsDir });
    for (const e of assembled.errors) fail(stage, e.message, e.igMediaId ?? e.file);
    const files = listExtractionFiles(extractionsDir);
    const imported = importExtractions(db, files, {
      importedDir: join(extractionsDir, "imported"),
      failedDir: join(extractionsDir, "failed"),
      now,
    });
    for (const e of imported.errors) {
      fail(stage === "stale" ? "stale" : "import", e.message, e.igMediaId ?? e.file);
    }
    return { files: files.length, imported };
  };

  // 0. A result in staging was never verified (the run was killed during or right after its
  // agent): never assemble it, keep it in classified/failed/ for inspection.
  for (const file of listExtractionFiles(stagingDir)) {
    const message = "result of an interrupted, unverified run; discarded (its posts stay queued)";
    const dest = moveInto(file, join(classifiedDir, "failed"));
    writeFileSync(`${dest}.error.txt`, `${message}\n`);
    fail("stale", message, basename(file));
  }
  rmSync(stagingDir, { recursive: true, force: true });

  // 1. Results an earlier run left behind (e.g. it crashed between classifying and importing).
  const staleClassified = listExtractionFiles(classifiedDir).length;
  const staleExtractions = listExtractionFiles(extractionsDir).length;
  if (staleClassified > 0 || staleExtractions > 0) {
    log(
      `Found ${staleClassified} classification and ${staleExtractions} extraction file(s) ` +
        "from an earlier run; assembling and importing them first",
    );
    const { files, imported } = assembleAndImport("stale");
    summary.stale = {
      classified: staleClassified,
      extractionFiles: files,
      postsExtracted: imported.postsExtracted,
    };
    addImport(summary, imported);
  }

  // 2. Posts to extract again (`--redo`), after the stale import so it can't re-mark them.
  if (redo.length > 0) {
    const { requeued, missing } = requeuePosts(db, redo);
    summary.requeued = requeued.length;
    for (const id of missing) fail("redo", "no post with this ig_media_id", id);
    if (requeued.length > 0) log(`Queued ${requeued.length} post(s) for extraction again`);
  }

  // Nothing new: stop before OCR or any spawn.
  summary.unextracted = listUnextractedPosts(db).length;
  if (summary.unextracted === 0) return summary;

  // 3. OCR (idempotent: only images not OCR'd before).
  try {
    const ocr = await runOcrStep(db, { mediaDir, ocrDir, runner: runOcr });
    summary.ocrImages = ocr.images;
    for (const f of ocr.failures) fail("ocr", `${f.path}: ${f.message}`, f.igMediaId);
    for (const id of ocr.noMedia) fail("ocr", "no media on disk; re-run sync:instagram", id);
  } catch (err) {
    fail("ocr", errorMessage(err));
    return summary;
  }

  // 4. Batches (posts not fully OCR'd are left out and stay queued).
  let batches: string[];
  try {
    batches = writeClassificationBatches(db, {
      mediaDir,
      ocrDir,
      todoDir,
      size: batchSize,
    }).batches;
  } catch (err) {
    fail("batches", errorMessage(err));
    return summary;
  }
  summary.batches = batches.length;
  if (batches.length === 0) return summary;

  // 5. One agent per batch, sequentially.
  for (const batchPath of batches) {
    const batch = basename(batchPath);
    // The agent only sees its own copy of the batch: the assembler reads the one in todo/.
    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(join(stagingDir, "input"), { recursive: true });
    const inputPath = join(stagingDir, "input", batch);
    copyFileSync(batchPath, inputPath);
    const outPath = join(stagingDir, batch);
    const req: ClassifyRequest = {
      batchPath: inputPath,
      outPath,
      prompt: buildClassificationPrompt({ batchPath: inputPath, outPath }),
      cwd: stagingDir,
      addDirs: [],
    };
    const started = performance.now();
    let outcome: ClassifyOutcome;
    try {
      outcome = await runClassifier(req);
    } catch (err) {
      outcome = { exitCode: null, timedOut: false, stdout: "", stderr: errorMessage(err) };
    }
    const run: BatchRun = {
      batch,
      ok: false,
      // Wall-clock, including CLI start-up: what CLASSIFY_TIMEOUT_MS is measured against.
      durationMs: Math.round(performance.now() - started),
      ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
      ...(outcome.result !== undefined ? { result: outcome.result } : {}),
    };
    summary.costUsd += outcome.costUsd ?? 0;
    summary.batchRuns.push(run);

    const problem = classifyProblem(outcome, existsSync(outPath));
    if (problem) {
      fail("classify", problem, batch);
      // Never assemble a result from a failed run; keep it for inspection.
      if (existsSync(outPath)) {
        const dest = moveInto(outPath, join(classifiedDir, "failed"));
        writeFileSync(`${dest}.error.txt`, `${problem}\n`);
      }
      continue;
    }
    mkdirSync(classifiedDir, { recursive: true });
    renameSync(outPath, join(classifiedDir, batch));
    run.ok = true;
    summary.classified++;
  }
  rmSync(stagingDir, { recursive: true, force: true });

  // 6–7. Assemble and import whatever was classified.
  if (summary.classified > 0) addImport(summary, assembleAndImport("assemble").imported);
  return summary;
}

function addImport(
  summary: ExtractNewSummary,
  imported: ReturnType<typeof importExtractions>,
): void {
  summary.postsExtracted += imported.postsExtracted;
  summary.quotesImported += imported.quotesCreated;
  summary.quotesLinked += imported.quotesLinked;
  summary.needsReview += imported.needsReview;
}

/** Why a classifier run counts as failed, or null when it succeeded. */
function classifyProblem(o: ClassifyOutcome, wroteResult: boolean): string | null {
  const detail = (o.stderr.trim() || o.result?.trim() || o.stdout.trim()).slice(0, 2000);
  const suffix = detail ? `: ${detail}` : "";
  if (o.timedOut) return `timed out${suffix}`;
  if (o.exitCode !== 0) return `exited ${o.exitCode ?? "(killed)"}${suffix}`;
  if (o.isError) return `agent reported an error${suffix}`;
  if (!wroteResult) return `exited 0 but wrote no result file${suffix}`;
  return null;
}
