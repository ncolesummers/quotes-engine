import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { type PostOcr, readPostOcr } from "../ocr/run";
import { captionSegments, stripCaption, stripOuterQuotes } from "./caption";
import {
  ClassificationFileSchema,
  type ClassificationResult,
  type ClassifiedQuote,
} from "./classification-schema";
import {
  type ClassificationBatchFile,
  type ClassificationBatchPost,
  formatOcrLine,
} from "./classify-batches";
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

// Words before a number that is really a number (`CHAPTER 1 BEGINS`), never the pronoun.
const NUMBERING_WORDS = new Set(
  "ACT BOOK CHAPTER DAY EPISODE LEVEL NO NUMBER PAGE PART PSALM ROOM ROUND SCENE SEASON STEP VOL VOLUME".split(
    " ",
  ),
);
const CAPS_WORD = /^\p{Lu}[\p{Lu}'’]*$/u;
// Line-initial `T'D` read for `I'D` (and `'M`, `'LL`, `'VE`).
const T_CONTRACTION = /^T(['’](?:D|M|LL|VE))(?![\p{L}])/u;

/**
 * Undo Vision's all-caps confusions, leaving the text otherwise as read (no case changes): a
 * line-initial `T'D` / `T'M` / `T'LL` / `T'VE` in an all-caps line becomes `I'D` etc.
 */
function fixCapsLine(line: string): string {
  if (/\p{Ll}/u.test(line)) return line;
  return line.replace(T_CONTRACTION, "I$1");
}

/**
 * A standalone `1` becomes `I` when the next word is an all-caps word and the previous one (if
 * any) is a word, not a digit or a numbering word like `CHAPTER`. `1st`, `1.`, `1,000` aren't
 * standalone tokens, so they are never touched.
 */
function fixCapsPronoun(text: string): string {
  const tokens = text.split(" ");
  return tokens
    .map((token, i) => {
      if (token !== "1") return token;
      const next = tokens[i + 1];
      if (next === undefined || !CAPS_WORD.test(next.replace(/[.,;:!?]+$/, ""))) return token;
      const prev = tokens[i - 1];
      if (prev === undefined) return "I";
      const word = prev.replace(/[.,;:!?—–-]+$/, "");
      if (/\p{N}/u.test(prev) || !/^\p{L}[\p{L}'’]*$/u.test(word)) return token;
      return NUMBERING_WORDS.has(word.toUpperCase()) ? token : "I";
    })
    .join(" ");
}

/**
 * Join OCR lines into one quote: lines are trimmed and joined with single spaces, and a word
 * hyphenated across a wrap (`bet-` + `ter`) is merged when the next line starts lowercase. All-caps
 * OCR confusions of `I` (`1`, `T'D`) are undone; see `fixCapsLine` and `fixCapsPronoun`.
 */
export function joinOcrLines(lines: readonly string[]): string {
  let out = "";
  for (const raw of lines) {
    const line = fixCapsLine(raw.replace(/\s+/g, " ").trim());
    if (!line) continue;
    if (out && WRAP_HYPHEN.test(out) && /^\p{Ll}/u.test(line)) out = out.slice(0, -1) + line;
    else out = out ? `${out} ${line}` : line;
  }
  return fixCapsPronoun(out);
}

// A line that is only an attribution: a dash (em, en, horizontal bar, or `- `) then a name.
const ATTRIBUTION_LINE = /^\s*(?:[—–―]|-\s)\s*\p{L}/u;

/** `items` without trailing attribution lines, keeping at least the first item. */
function dropTrailingAttribution<T>(items: readonly T[], text: (item: T) => string): T[] {
  let end = items.length;
  while (end > 1 && ATTRIBUTION_LINE.test(text(items[end - 1] as T))) end--;
  return items.slice(0, end);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Caption text for a caption-only quote: its `caption_lines` segments, or the whole caption. */
function captionText(q: ClassifiedQuote, caption: string | null): string {
  const segments = captionSegments(caption);
  if (q.caption_lines === null) {
    if (segments.length > 1) {
      throw new Error(
        `caption-only quote without caption_lines, but the caption has ${segments.length} segments`,
      );
    }
    return stripCaption(caption);
  }
  const [start, end] = q.caption_lines;
  if (end >= segments.length) {
    throw new Error(
      `caption_lines [${start}, ${end}] are out of range (caption has ${segments.length})`,
    );
  }
  return dropTrailingAttribution(segments.slice(start, end + 1), (s) => s).join(" ");
}

function assembleQuote(
  q: ClassifiedQuote,
  post: ClassificationBatchPost,
  ocr: PostOcr | null,
): ExtractedQuote {
  const base = { author: q.author, source: q.source };
  if (q.image === null || q.lines === null) {
    const text = stripOuterQuotes(captionText(q, post.caption));
    if (!text) throw new Error("from_caption quote, but the caption has no text besides tags");
    return { text, ...base, found_in: "caption", confidence: round(q.confidence) };
  }

  const ref = post.images.find((i) => i.image === q.image);
  if (!ref) throw new Error(`image ${q.image} is out of range (post has ${post.images.length})`);
  const lines = ocr?.images.find((i) => i.file === ref.file)?.lines;
  if (!lines) throw new Error(`no OCR for image ${q.image} (${ref.file}); run \`bun run ocr\``);
  // The agent's line numbers refer to the lines in the batch; the OCR must still be those lines.
  const current = lines.map((l, i) => formatOcrLine(ref.image, i, l.text));
  if (current.length !== ref.lines.length || current.some((line, i) => line !== ref.lines[i])) {
    throw new Error(
      `OCR for image ${q.image} (${ref.file}) changed since the batch was written; ` +
        "re-run `bun run extract:classify-batches` and classify again",
    );
  }
  const [start, end] = q.lines;
  if (end >= lines.length) {
    throw new Error(
      `lines [${start}, ${end}] are out of range for image ${q.image} (${lines.length} lines)`,
    );
  }

  const picked = dropTrailingAttribution(lines.slice(start, end + 1), (l) => l.text);
  const text = stripOuterQuotes(joinOcrLines(picked.map((l) => l.text)));
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
 * `classified/assembled/`; invalid ones, and ones where every post failed, to `classified/failed/`
 * with a `.error.txt`. A file whose output path still holds an unimported extraction file is
 * left in place.
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

    if (out.length === 0 && results.length > 0) {
      // Every post failed: keep the agent's work in failed/ for a retry, not in assembled/.
      const message = `no post could be assembled (${results.length} failed)`;
      const dest = moveInto(file, join(classifiedDir, "failed"));
      const details = summary.errors
        .filter((e) => e.file === file)
        .map((e) => `${e.igMediaId}: ${e.message}`);
      writeFileSync(`${dest}.error.txt`, `${[message, ...details].join("\n")}\n`);
      summary.filesFailed++;
      continue;
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
  if (!Array.isArray(batch.posts) || batch.posts.some((p) => !Array.isArray(p.images))) {
    throw new Error(`${path} is not a classification batch (run \`extract:classify-batches\`)`);
  }
  return new Map(batch.posts.map((p) => [p.ig_media_id, p]));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
