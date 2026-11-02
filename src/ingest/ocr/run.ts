import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { listUnextractedPosts } from "../../server/repos/posts";
import { findMediaFiles, isMissingMedia } from "../extraction/batches";
import { type OcrImage, OcrLineSchema } from "./parse";

export const DEFAULT_OCR_DIR = "data/ocr";
export const DEFAULT_OCR_CONCURRENCY = 4;

/** OCRs a list of image paths, returning one entry per path (in any order). */
export type OcrRunner = (paths: string[]) => Promise<OcrImage[]>;

/** OCR for one post (`data/ocr/<ig_media_id>.json`), images in media order. */
export const PostOcrSchema = z.object({
  ig_media_id: z.string().min(1),
  images: z.array(
    z.object({
      /** Media file name, e.g. `<id>_1.jpg`; the key that marks an image as done. */
      file: z.string().min(1),
      path: z.string(),
      lines: z.array(OcrLineSchema),
    }),
  ),
});

export type PostOcr = z.infer<typeof PostOcrSchema>;
export type PostOcrImage = PostOcr["images"][number];

export interface RunOcrOptions {
  mediaDir: string;
  ocrDir: string;
  runner: OcrRunner;
  concurrency?: number;
  /** Called after each post is processed (for progress output). */
  onPost?: (igMediaId: string, done: number, total: number) => void;
}

export interface OcrFailure {
  igMediaId: string;
  path: string;
  message: string;
}

export interface RunOcrSummary {
  /** Unextracted posts with at least one image on disk. */
  posts: number;
  /** Of those, posts whose images were all OCR'd already. */
  postsSkipped: number;
  /** Images OCR'd successfully in this run. */
  images: number;
  /** Images skipped because they were OCR'd before. */
  imagesSkipped: number;
  /** Lines recognized in this run. */
  lines: number;
  /** Images that failed; they aren't stored, so the next run retries them. */
  failures: OcrFailure[];
  /** Image/carousel posts with no media on disk (re-run `sync:instagram`). */
  noMedia: string[];
}

export function ocrPath(ocrDir: string, igMediaId: string): string {
  return join(ocrDir, `${igMediaId}.json`);
}

/** The stored OCR for a post, or null if none. Throws when the file is corrupt. */
export function readPostOcr(ocrDir: string, igMediaId: string): PostOcr | null {
  const path = ocrPath(ocrDir, igMediaId);
  if (!existsSync(path)) return null;
  try {
    return PostOcrSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    throw new Error(
      `Corrupt OCR file ${path} (delete it to redo ${igMediaId}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Write a post's OCR atomically (temp file + rename), so a crash can't leave half a file. */
export function writePostOcr(ocrDir: string, ocr: PostOcr): void {
  mkdirSync(ocrDir, { recursive: true });
  const path = ocrPath(ocrDir, ocr.ig_media_id);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ocr, null, 2)}\n`);
  renameSync(tmp, path);
}

interface Job {
  igMediaId: string;
  mediaPaths: string[];
  existing: PostOcr | null;
  todo: string[];
}

/**
 * OCR every image of every unextracted post into `ocrDir/<ig_media_id>.json`. Idempotent:
 * images already in a post's file are skipped, so re-running only OCRs new or failed images.
 * At most `concurrency` runner calls (one per post) are in flight at once.
 */
export async function runOcr(
  db: Database,
  { mediaDir, ocrDir, runner, concurrency = DEFAULT_OCR_CONCURRENCY, onPost }: RunOcrOptions,
): Promise<RunOcrSummary> {
  const summary: RunOcrSummary = {
    posts: 0,
    postsSkipped: 0,
    images: 0,
    imagesSkipped: 0,
    lines: 0,
    failures: [],
    noMedia: [],
  };

  const jobs: Job[] = [];
  for (const post of listUnextractedPosts(db)) {
    const mediaPaths = findMediaFiles(mediaDir, post.igMediaId);
    if (isMissingMedia(post, mediaPaths)) {
      summary.noMedia.push(post.igMediaId);
      continue;
    }
    if (mediaPaths.length === 0) continue;
    summary.posts++;
    const existing = readPostOcr(ocrDir, post.igMediaId);
    const done = new Set(existing?.images.map((i) => i.file));
    const todo = mediaPaths.filter((p) => !done.has(basename(p)));
    summary.imagesSkipped += mediaPaths.length - todo.length;
    if (todo.length === 0) summary.postsSkipped++;
    else jobs.push({ igMediaId: post.igMediaId, mediaPaths, existing, todo });
  }

  let next = 0;
  let finished = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++] as Job;
      await processJob(job, ocrDir, runner, summary);
      onPost?.(job.igMediaId, ++finished, jobs.length);
    }
  };
  const workers = Math.max(1, Math.min(concurrency, jobs.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return summary;
}

async function processJob(
  { igMediaId, mediaPaths, existing, todo }: Job,
  ocrDir: string,
  runner: OcrRunner,
  summary: RunOcrSummary,
): Promise<void> {
  let results: OcrImage[];
  try {
    results = await runner(todo);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const path of todo) summary.failures.push({ igMediaId, path, message });
    return;
  }

  const byPath = new Map(results.map((r) => [r.path, r]));
  const byFile = new Map(existing?.images.map((i) => [i.file, i]));
  for (const path of todo) {
    const r = byPath.get(path);
    if (!r || r.error !== undefined) {
      summary.failures.push({ igMediaId, path, message: r?.error ?? "No OCR result returned" });
      continue;
    }
    byFile.set(basename(path), { file: basename(path), path, lines: r.lines });
    summary.images++;
    summary.lines += r.lines.length;
  }

  const images = mediaPaths.flatMap((p) => byFile.get(basename(p)) ?? []);
  if (images.length > 0) writePostOcr(ocrDir, { ig_media_id: igMediaId, images });
}
