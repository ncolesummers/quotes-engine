import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { type PostOcr, readPostOcr } from "../ocr/run";
import {
  ClassificationFileSchema,
  type ClassificationResult,
  type ClassifiedQuote,
} from "./classification-schema";
import type { ClassificationBatchFile, ClassificationBatchPost } from "./classify-batches";
import { listExtractionFiles, moveInto } from "./import";
import type { ExtractedQuote, ExtractionFile, ExtractionResult } from "./schema";

export interface AssembleOptions {
  /** Classification results, e.g. `data/extractions/classified`. */
  classifiedDir: string;
  /** The batch files they answer, e.g. `data/extractions/todo`. */
  todoDir: string;
  ocrDir: string;
  /** Where extraction files are written for `import:extractions`, e.g. `data/extractions`. */
  extractionsDir: string;
}

export interface AssembleError {
  file: string;
  /** Set for per-post errors; absent when the whole file was rejected. */
  igMediaId?: string;
  message: string;
}

export interface AssembleSummary {
  filesAssembled: number;
  filesFailed: number;
  /** Posts written to extraction files (including `no_quote` posts). */
  posts: number;
  quotes: number;
  /** Per-post errors leave the post out, so it stays unextracted for the next round. */
  errors: AssembleError[];
}

// A letter, then a wrap hyphen (ASCII, Unicode hyphen or soft hyphen) at the very end.
const WRAP_HYPHEN = /(\p{L})[-‐­]$/u;

/**
 * Join OCR lines into one quote: lines are trimmed and joined with single spaces, and a word
 * hyphenated across a wrap (`bet-` + `ter`) is merged when the next line starts lowercase.
 */
export function joinOcrLines(lines: readonly string[]): string {
  let out = "";
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;
    if (out && WRAP_HYPHEN.test(out) && /^\p{Ll}/u.test(line)) out = out.slice(0, -1) + line;
    else out = out ? `${out} ${line}` : line;
  }
  return out;
}

/**
 * The caption as quote text: hashtags, `📖 Title — Author` lines and spacer lines (only dots or
 * similar punctuation) removed, whitespace tidied, paragraph breaks kept. `""` when nothing is left.
 */
export function stripCaption(caption: string | null): string {
  if (!caption) return "";
  const lines = caption.split(/\r?\n/).map((line) => {
    if (line.trim().startsWith("📖")) return "";
    const cleaned = line
      .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, "$1")
      .replace(/[ \t]+/g, " ")
      .trim();
    return /^[.·•\-_~*]*$/u.test(cleaned) ? "" : cleaned;
  });
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function assembleQuote(
  q: ClassifiedQuote,
  post: ClassificationBatchPost,
  ocr: PostOcr | null,
): ExtractedQuote {
  const base = { author: q.author, source: q.source };
  if (q.image === null || q.lines === null) {
    const text = stripCaption(post.caption);
    if (!text) throw new Error("from_caption quote, but the caption has no text besides tags");
    return { text, ...base, found_in: "caption", confidence: round(q.confidence) };
  }

  const ref = post.images.find((i) => i.image === q.image);
  if (!ref) throw new Error(`image ${q.image} is out of range (post has ${post.images.length})`);
  const lines = ocr?.images.find((i) => i.file === ref.file)?.lines;
  if (!lines) throw new Error(`no OCR for image ${q.image} (${ref.file}); run \`bun run ocr\``);
  const [start, end] = q.lines;
  if (end >= lines.length) {
    throw new Error(
      `lines [${start}, ${end}] are out of range for image ${q.image} (${lines.length} lines)`,
    );
  }

  const picked = lines.slice(start, end + 1);
  const text = joinOcrLines(picked.map((l) => l.text));
  if (!text) throw new Error(`lines [${start}, ${end}] of image ${q.image} are empty`);
  const ocrConfidence = picked.reduce((sum, l) => sum + l.confidence, 0) / picked.length;
  return {
    text,
    ...base,
    found_in: q.from_caption ? "both" : "image",
    confidence: round(q.confidence * ocrConfidence),
  };
}

/**
 * Turn one classified post into an extraction result, filling quote text in from the OCR lines
 * or the caption. Throws on a bad reference (out-of-range image or lines, empty caption).
 */
export function assembleResult(
  result: ClassificationResult,
  post: ClassificationBatchPost,
  ocr: PostOcr | null,
): ExtractionResult {
  if (result.no_quote) {
    if (result.quotes.length > 0) throw new Error("no_quote is true but quotes were given");
    return { ig_media_id: result.ig_media_id, quotes: [], no_quote: true };
  }
  if (result.quotes.length === 0) throw new Error("no quotes, but no_quote is false");
  return {
    ig_media_id: result.ig_media_id,
    quotes: result.quotes.map((q) => assembleQuote(q, post, ocr)),
    no_quote: false,
  };
}

/**
 * Assemble every `classifiedDir/*.json` into `extractionsDir/<same name>.json` (the
 * `ExtractionFile` schema `import:extractions` reads). Assembled classification files move to
 * `classified/assembled/`; invalid ones to `classified/failed/` with a `.error.txt`. A file whose
 * output path still holds an unimported extraction file is left in place.
 */
export function assembleClassifications({
  classifiedDir,
  todoDir,
  ocrDir,
  extractionsDir,
}: AssembleOptions): AssembleSummary {
  const summary: AssembleSummary = {
    filesAssembled: 0,
    filesFailed: 0,
    posts: 0,
    quotes: 0,
    errors: [],
  };

  for (const file of listExtractionFiles(classifiedDir)) {
    const outPath = join(extractionsDir, basename(file));
    if (existsSync(outPath)) {
      summary.filesFailed++;
      summary.errors.push({
        file,
        message: `${outPath} exists; run \`bun run import:extractions\` first`,
      });
      continue;
    }

    let results: ClassificationResult[];
    let posts: Map<string, ClassificationBatchPost>;
    try {
      results = parseClassificationFile(readFileSync(file, "utf8"));
      posts = readBatchPosts(join(todoDir, basename(file)));
    } catch (err) {
      const message = errorMessage(err);
      const dest = moveInto(file, join(classifiedDir, "failed"));
      writeFileSync(`${dest}.error.txt`, `${message}\n`);
      summary.filesFailed++;
      summary.errors.push({ file, message });
      continue;
    }

    const out: ExtractionResult[] = [];
    for (const result of results) {
      try {
        const post = posts.get(result.ig_media_id);
        if (!post) throw new Error(`not in batch ${basename(file)}`);
        const ocr = post.images.length > 0 ? readPostOcr(ocrDir, result.ig_media_id) : null;
        if (post.images.length > 0 && !ocr) throw new Error("no OCR file; run `bun run ocr`");
        out.push(assembleResult(result, post, ocr));
      } catch (err) {
        summary.errors.push({ file, igMediaId: result.ig_media_id, message: errorMessage(err) });
      }
    }

    if (out.length > 0) {
      mkdirSync(extractionsDir, { recursive: true });
      const extraction: ExtractionFile = { results: out };
      writeFileSync(outPath, `${JSON.stringify(extraction, null, 2)}\n`);
    }
    moveInto(file, join(classifiedDir, "assembled"));
    summary.filesAssembled++;
    summary.posts += out.length;
    summary.quotes += out.reduce((n, r) => n + r.quotes.length, 0);
  }
  return summary;
}

function parseClassificationFile(content: string): ClassificationResult[] {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (err) {
    throw new Error(`Invalid JSON: ${errorMessage(err)}`);
  }
  const parsed = ClassificationFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Invalid classification file:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data.results;
}

function readBatchPosts(path: string): Map<string, ClassificationBatchPost> {
  if (!existsSync(path)) throw new Error(`Batch file ${path} not found`);
  const batch = JSON.parse(readFileSync(path, "utf8")) as ClassificationBatchFile;
  return new Map(batch.posts.map((p) => [p.ig_media_id, p]));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
