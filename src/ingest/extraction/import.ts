import type { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import { getPostByIgMediaId, markExtracted } from "../../server/repos/posts";
import { type LinkStatus, linkPostQuote, upsertQuote } from "../../server/repos/quotes";
import { ExtractionFileSchema, type ExtractionResult } from "./schema";

/** Links below this confidence are queued for review. */
export const REVIEW_CONFIDENCE_THRESHOLD = 0.8;

export interface ImportOptions {
  /** Where successfully processed files are moved, e.g. `data/extractions/imported`. */
  importedDir: string;
  /** Where invalid files are moved, next to a `<name>.error.txt`, e.g. `data/extractions/failed`. */
  failedDir: string;
  now?: () => Date;
}

export interface ImportError {
  file: string;
  /** Set for per-result errors; absent when the whole file was rejected. */
  igMediaId?: string;
  message: string;
}

export interface ImportSummary {
  filesImported: number;
  filesFailed: number;
  /** Posts marked extracted (including `no_quote` posts). */
  postsExtracted: number;
  /** Quotes inserted (a `likely` match is a new row, so it counts). */
  quotesCreated: number;
  /** Post–quote links written or already present. */
  quotesLinked: number;
  needsReview: number;
  errors: ImportError[];
}

interface ResultCounts {
  quotesCreated: number;
  quotesLinked: number;
  needsReview: number;
}

/**
 * Import extraction result files: upsert each quote, link it to its post, and mark the post
 * extracted. Each result is applied in its own transaction, so a bad result (e.g. an unknown
 * `ig_media_id`) is reported in `errors` without affecting the rest of the file. Files that fail
 * to parse or validate are moved to `failedDir` untouched; all others go to `importedDir`.
 * Re-importing a file is idempotent.
 */
export function importExtractions(
  db: Database,
  files: string[],
  { importedDir, failedDir, now = () => new Date() }: ImportOptions,
): ImportSummary {
  const summary: ImportSummary = {
    filesImported: 0,
    filesFailed: 0,
    postsExtracted: 0,
    quotesCreated: 0,
    quotesLinked: 0,
    needsReview: 0,
    errors: [],
  };

  for (const file of files) {
    let results: ExtractionResult[];
    try {
      results = parseExtractionFile(readFileSync(file, "utf8"));
    } catch (err) {
      const message = errorMessage(err);
      const dest = moveInto(file, failedDir);
      writeFileSync(`${dest}.error.txt`, `${message}\n`);
      summary.filesFailed++;
      summary.errors.push({ file, message });
      continue;
    }

    const extractedAt = now().toISOString();
    for (const result of results) {
      try {
        const counts = db.transaction(() => importResult(db, result, extractedAt))();
        summary.postsExtracted++;
        summary.quotesCreated += counts.quotesCreated;
        summary.quotesLinked += counts.quotesLinked;
        summary.needsReview += counts.needsReview;
      } catch (err) {
        summary.errors.push({ file, igMediaId: result.ig_media_id, message: errorMessage(err) });
      }
    }
    moveInto(file, importedDir);
    summary.filesImported++;
  }
  return summary;
}

/** Parse and validate a result file's contents; throws with a readable message when invalid. */
export function parseExtractionFile(content: string): ExtractionResult[] {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (err) {
    throw new Error(`Invalid JSON: ${errorMessage(err)}`);
  }
  const parsed = ExtractionFileSchema.safeParse(json);
  if (!parsed.success)
    throw new Error(`Invalid extraction file:\n${z.prettifyError(parsed.error)}`);
  return parsed.data.results;
}

/** Top-level `*.json` files in `dir`, sorted; `[]` if the directory doesn't exist. */
export function listExtractionFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(dir, entry.name))
    .sort();
}

function importResult(db: Database, result: ExtractionResult, extractedAt: string): ResultCounts {
  const post = getPostByIgMediaId(db, result.ig_media_id);
  if (!post) throw new Error(`No post with ig_media_id ${result.ig_media_id}`);

  const counts: ResultCounts = { quotesCreated: 0, quotesLinked: 0, needsReview: 0 };
  for (const q of result.quotes) {
    const { quote, match } = upsertQuote(db, {
      text: q.text,
      author: q.author,
      sourceTitle: q.source,
      // Links the quote to its book (found or created) whenever `source` is present.
      bookSource: "caption",
    });
    const status: LinkStatus =
      q.confidence < REVIEW_CONFIDENCE_THRESHOLD || match === "likely"
        ? "needs_review"
        : "confirmed";
    // An existing link keeps its stored status, so count what was persisted.
    const stored = linkPostQuote(db, post.id, quote.id, {
      method: q.found_in === "image" ? "image" : "caption",
      confidence: q.confidence,
      status,
    });
    if (match !== "existing") counts.quotesCreated++;
    counts.quotesLinked++;
    if (stored === "needs_review") counts.needsReview++;
  }
  markExtracted(db, post.id, extractedAt);
  return counts;
}

/**
 * Move `file` into `dir` without overwriting an earlier archive of the same name: `a.json`
 * becomes `a-1.json`, `a-2.json`, ... Returns the destination path.
 */
export function moveInto(file: string, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const ext = extname(file);
  const stem = basename(file, ext);
  let dest = join(dir, `${stem}${ext}`);
  for (let n = 1; existsSync(dest); n++) dest = join(dir, `${stem}-${n}${ext}`);
  renameSync(file, dest);
  return dest;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
