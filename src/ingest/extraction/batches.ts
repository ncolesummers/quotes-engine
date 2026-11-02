import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { listUnextractedPosts, type Post } from "../../server/repos/posts";
import { IMAGE_EXTENSIONS } from "../instagram/sync";
import { listExtractionFiles } from "./import";

export const DEFAULT_EXTRACTIONS_DIR = "data/extractions";
export const DEFAULT_BATCH_SIZE = 20;

/** One post as handed to an extraction agent. */
export interface BatchPost {
  ig_media_id: string;
  posted_at: string | null;
  caption: string | null;
  /** Absolute paths of every local image for the post (all carousel children). */
  media_paths: string[];
}

/** One batch file (`data/extractions/todo/batch-NNN.json`). */
export interface BatchFile {
  posts: BatchPost[];
}

export interface WriteBatchesOptions {
  /** Directory holding downloaded media, e.g. `data/media`. */
  mediaDir: string;
  /**
   * Directory the batch files are written to; cleared first. E.g. `data/extractions/todo`. Its
   * parent is where agents write results, and must hold no unimported result files.
   */
  todoDir: string;
  size?: number;
}

export interface WriteBatchesSummary {
  /** Paths of the batch files written, in order. */
  batches: string[];
  /** Posts written across all batches. */
  posts: number;
  /** Unextracted posts left out because they have neither media nor a caption. */
  skipped: number;
  /**
   * `ig_media_id`s of image/carousel posts left out because none of their media files are on
   * disk (e.g. a failed download). Re-run `sync:instagram`, then batch again.
   */
  missingMedia: string[];
}

const IMAGE_EXT = `(?:${[...IMAGE_EXTENSIONS].join("|")})`;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split `items` into consecutive chunks of `size` (the last may be shorter). */
export function chunk<T>(items: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error(`Invalid chunk size: ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Batch file stem for a zero-based batch index: `batch-001`, `batch-002`, ... */
export function batchName(index: number): string {
  return `batch-${String(index + 1).padStart(3, "0")}`;
}

/**
 * Absolute paths of every local image for a post: `<id>.<ext>` and carousel children
 * `<id>_1.<ext>`, `<id>_2.<ext>`, ... in index order. Other posts whose id merely starts with
 * `igMediaId` are not matched.
 */
export function findMediaFiles(mediaDir: string, igMediaId: string): string[] {
  if (!existsSync(mediaDir)) return [];
  const pattern = new RegExp(`^${escapeRegExp(igMediaId)}(?:_(\\d+))?\\.${IMAGE_EXT}$`, "i");
  const dir = resolve(mediaDir);
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      if (!entry.isFile()) return [];
      const m = pattern.exec(entry.name);
      return m ? [{ name: entry.name, index: m[1] === undefined ? 0 : Number(m[1]) }] : [];
    })
    .sort((a, b) => a.index - b.index || a.name.localeCompare(b.name))
    .map((f) => join(dir, f.name));
}

/**
 * True when sync recorded (or should have) image files for the post but none are on disk. Such
 * posts must not be extracted from the caption alone: the quote is usually in the image, and the
 * post would be marked extracted for good. Videos may legitimately have no image.
 */
export function isMissingMedia(post: Post, mediaPaths: string[]): boolean {
  if (mediaPaths.length > 0) return false;
  return (
    post.mediaPath !== null || post.mediaType === "IMAGE" || post.mediaType === "CAROUSEL_ALBUM"
  );
}

/** The batch entry for a post, or null when it has neither media nor a caption. */
export function toBatchPost(post: Post, mediaPaths: string[]): BatchPost | null {
  const caption = post.caption?.trim() ? post.caption : null;
  if (mediaPaths.length === 0 && caption === null) return null;
  return {
    ig_media_id: post.igMediaId,
    posted_at: post.postedAt,
    caption,
    media_paths: mediaPaths,
  };
}

/**
 * Write every unextracted post (oldest first) into `todoDir/batch-NNN.json` files of `size`
 * posts each. `todoDir` is emptied first, so re-running reflects the current DB state.
 *
 * Throws if result files are still waiting in `todoDir`'s parent: batch names restart at
 * `batch-001` on every run, so new agents would overwrite results that were never imported.
 * Also throws while classification results (`classified/*.json`) wait to be assembled against
 * the current `todo/` batches.
 */
export function writeBatches(
  db: Database,
  { mediaDir, todoDir, size = DEFAULT_BATCH_SIZE }: WriteBatchesOptions,
): WriteBatchesSummary {
  const pending = listExtractionFiles(dirname(resolve(todoDir)));
  if (pending.length > 0) {
    throw new Error(
      `${pending.length} result file(s) in ${dirname(todoDir)} are not imported yet. ` +
        "Run `bun run import:extractions` first, so new batches can't overwrite them.",
    );
  }
  // Classification results are assembled against the todo/ batches, so don't replace those.
  const classifiedDir = join(dirname(resolve(todoDir)), "classified");
  const unassembled = listExtractionFiles(classifiedDir);
  if (unassembled.length > 0) {
    throw new Error(
      `${unassembled.length} classification file(s) in ${classifiedDir} are not assembled yet. ` +
        "Run `bun run extract:assemble` and `bun run import:extractions` first.",
    );
  }

  const posts: BatchPost[] = [];
  const missingMedia: string[] = [];
  let skipped = 0;
  for (const post of listUnextractedPosts(db)) {
    const mediaPaths = findMediaFiles(mediaDir, post.igMediaId);
    if (isMissingMedia(post, mediaPaths)) {
      missingMedia.push(post.igMediaId);
      continue;
    }
    const entry = toBatchPost(post, mediaPaths);
    if (entry) posts.push(entry);
    else skipped++;
  }
  const batches = chunk(posts, size);

  rmSync(todoDir, { recursive: true, force: true });
  mkdirSync(todoDir, { recursive: true });

  const paths = batches.map((batch, i) => {
    const path = join(todoDir, `${batchName(i)}.json`);
    const file: BatchFile = { posts: batch };
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
    return path;
  });

  return { batches: paths, posts: posts.length, skipped, missingMedia };
}
