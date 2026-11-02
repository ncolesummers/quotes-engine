import type { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { listUnextractedPosts } from "../../server/repos/posts";
import { readPostOcr } from "../ocr/run";
import { batchName, chunk, DEFAULT_BATCH_SIZE, findMediaFiles, isMissingMedia } from "./batches";
import { captionSegments } from "./caption";
import { listExtractionFiles } from "./import";

/** Where agents write classification results, relative to the extractions dir. */
export const CLASSIFIED_SUBDIR = "classified";

/** One image of a post in a classification batch. */
export interface ClassificationBatchImage {
  /** 1-based image number, as used in the line references. */
  image: number;
  /** Media file name, used by the assembler to find the OCR. */
  file: string;
  /** Numbered OCR lines: `img1:L0 "…"`, `img1:L1 "…"`, ... */
  lines: string[];
}

/** One post as handed to a classification agent. */
export interface ClassificationBatchPost {
  ig_media_id: string;
  posted_at: string | null;
  caption: string | null;
  /** Numbered caption segments (quoted spans split out, tags removed): `cap:L0 "…"`, ... */
  caption_lines: string[];
  images: ClassificationBatchImage[];
}

export interface ClassificationBatchFile {
  posts: ClassificationBatchPost[];
}

export interface WriteClassificationBatchesOptions {
  mediaDir: string;
  ocrDir: string;
  /** Cleared first, e.g. `data/extractions/todo`. Its parent is the extractions dir. */
  todoDir: string;
  size?: number;
}

export interface WriteClassificationBatchesSummary {
  batches: string[];
  posts: number;
  /** Posts with neither media nor a caption. */
  skipped: number;
  /** Image/carousel posts with no media on disk (re-run `sync:instagram`). */
  missingMedia: string[];
  /** Posts with media that isn't all OCR'd yet (run `bun run ocr`). */
  missingOcr: string[];
}

/** `cap:L0 "text"`: a caption segment reference followed by the segment as a JSON string. */
export function formatCaptionLine(index: number, text: string): string {
  return `cap:L${index} ${JSON.stringify(text)}`;
}

/** `img1:L0 "text"`: the line reference followed by the line as a JSON string. */
export function formatOcrLine(image: number, index: number, text: string): string {
  return `img${image}:L${index} ${JSON.stringify(text)}`;
}

/**
 * Write every unextracted post (oldest first) into `todoDir/batch-NNN.json` for classification
 * agents: caption plus numbered OCR lines per image. Agents write `classified/batch-NNN.json`,
 * which `extract:assemble` turns into importable extraction files.
 *
 * Throws while extraction results (top-level `*.json`) or classification results
 * (`classified/*.json`) are waiting, since batch names restart at `batch-001`.
 */
export function writeClassificationBatches(
  db: Database,
  { mediaDir, ocrDir, todoDir, size = DEFAULT_BATCH_SIZE }: WriteClassificationBatchesOptions,
): WriteClassificationBatchesSummary {
  const extractionsDir = dirname(resolve(todoDir));
  const unimported = listExtractionFiles(extractionsDir);
  if (unimported.length > 0) {
    throw new Error(
      `${unimported.length} result file(s) in ${extractionsDir} are not imported yet. ` +
        "Run `bun run import:extractions` first, so new batches can't overwrite them.",
    );
  }
  const classifiedDir = join(extractionsDir, CLASSIFIED_SUBDIR);
  const unassembled = listExtractionFiles(classifiedDir);
  if (unassembled.length > 0) {
    throw new Error(
      `${unassembled.length} classification file(s) in ${classifiedDir} are not assembled yet. ` +
        "Run `bun run extract:assemble` and `bun run import:extractions` first.",
    );
  }

  const summary: WriteClassificationBatchesSummary = {
    batches: [],
    posts: 0,
    skipped: 0,
    missingMedia: [],
    missingOcr: [],
  };
  const posts: ClassificationBatchPost[] = [];
  for (const post of listUnextractedPosts(db)) {
    const mediaPaths = findMediaFiles(mediaDir, post.igMediaId);
    if (isMissingMedia(post, mediaPaths)) {
      summary.missingMedia.push(post.igMediaId);
      continue;
    }
    const caption = post.caption?.trim() ? post.caption : null;
    if (mediaPaths.length === 0 && caption === null) {
      summary.skipped++;
      continue;
    }

    let ocr: ReturnType<typeof readPostOcr> = null;
    try {
      ocr = mediaPaths.length > 0 ? readPostOcr(ocrDir, post.igMediaId) : null;
    } catch {
      // A corrupt OCR file; `bun run ocr` reports it with the fix. Don't stop the other posts.
      summary.missingOcr.push(post.igMediaId);
      continue;
    }
    const byFile = new Map(ocr?.images.map((i) => [i.file, i]));
    const files = mediaPaths.map((p) => basename(p));
    if (files.some((f) => !byFile.has(f))) {
      summary.missingOcr.push(post.igMediaId);
      continue;
    }

    posts.push({
      ig_media_id: post.igMediaId,
      posted_at: post.postedAt,
      caption,
      caption_lines: captionSegments(caption).map((seg, i) => formatCaptionLine(i, seg)),
      images: files.map((file, i) => ({
        image: i + 1,
        file,
        lines: (byFile.get(file)?.lines ?? []).map((l, idx) => formatOcrLine(i + 1, idx, l.text)),
      })),
    });
  }

  rmSync(todoDir, { recursive: true, force: true });
  mkdirSync(todoDir, { recursive: true });
  summary.batches = chunk(posts, size).map((batch, i) => {
    const path = join(todoDir, `${batchName(i)}.json`);
    const file: ClassificationBatchFile = { posts: batch };
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
    return path;
  });
  summary.posts = posts.length;
  return summary;
}
