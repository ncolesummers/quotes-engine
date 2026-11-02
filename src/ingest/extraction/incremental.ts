import type { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listUnextractedPosts } from "../../server/repos/posts";
import { type OcrRunner, runOcr as runOcrStep } from "../ocr/run";
import { assembleClassifications } from "./assemble";
import { DEFAULT_BATCH_SIZE } from "./batches";
import { buildClassificationPrompt, classifiedPathForBatch } from "./classification-prompt";
import { CLASSIFIED_SUBDIR, writeClassificationBatches } from "./classify-batches";
import { importExtractions, listExtractionFiles, moveInto } from "./import";

export interface IncrementalPaths {
  mediaDir: string;
  ocrDir: string;
  /** e.g. `data/extractions`; holds `todo/`, `classified/`, `imported/`, ... */
  extractionsDir: string;
  /** Working directory for the classifier (the repo root). */
  cwd: string;
}

/** One classification batch for one headless agent run. */
export interface ClassifyRequest {
  batchPath: string;
  /** Where the agent must write its result. */
  outPath: string;
  /** The full classification prompt for this batch. */
  prompt: string;
  cwd: string;
  /** Directories outside `cwd` the agent needs to read and write. */
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
}

export type IncrementalStage = "stale" | "ocr" | "batches" | "classify" | "assemble" | "import";

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
  /** Unextracted posts after any stale results were imported. */
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
}: ExtractNewOptions): Promise<ExtractNewSummary> {
  const { extractionsDir, mediaDir, ocrDir } = paths;
  const todoDir = join(extractionsDir, "todo");
  const classifiedDir = join(extractionsDir, CLASSIFIED_SUBDIR);
  const summary: ExtractNewSummary = {
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

  // 2. Nothing new: stop before OCR or any spawn.
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
    const outPath = classifiedPathForBatch(batchPath, extractionsDir);
    const batch = batchPath.split("/").at(-1) as string;
    const req: ClassifyRequest = {
      batchPath,
      outPath,
      prompt: buildClassificationPrompt({ batchPath, outPath }),
      cwd: paths.cwd,
      addDirs: [resolve(extractionsDir)],
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
      durationMs: outcome.durationMs ?? Math.round(performance.now() - started),
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
    run.ok = true;
    summary.classified++;
  }

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
