import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listUnextractedPosts, type Post } from "../../server/repos/posts";

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
  /** Directory the batch files are written to; cleared first. E.g. `data/extractions/todo`. */
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
}

const IMAGE_EXT = "(?:jpg|jpeg|png|webp|gif|heic)";

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
 */
export function writeBatches(
  db: Database,
  { mediaDir, todoDir, size = DEFAULT_BATCH_SIZE }: WriteBatchesOptions,
): WriteBatchesSummary {
  const posts: BatchPost[] = [];
  let skipped = 0;
  for (const post of listUnextractedPosts(db)) {
    const entry = toBatchPost(post, findMediaFiles(mediaDir, post.igMediaId));
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

  return { batches: paths, posts: posts.length, skipped };
}
