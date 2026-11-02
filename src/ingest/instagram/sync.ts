import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getPostByIgMediaId, recordMetrics, upsertPost } from "../../server/repos/posts";
import type { FetchLike, InstagramClient, InstagramMedia } from "./client";

export const DEFAULT_MEDIA_DIR = "data/media";
export const DEFAULT_DOWNLOAD_CONCURRENCY = 4;

/** Saves the resource at `url` to `path`. Must not leave a file at `path` on failure. */
export type Downloader = (url: string, path: string) => Promise<void>;

export interface SyncOptions {
  db: Database;
  client: Pick<InstagramClient, "listMedia">;
  /** Directory media files are saved to. `media_path` stores only the file name relative to it (served as `/media/<media_path>`). */
  mediaDir: string;
  /** Clock; one snapshot timestamp is taken per run (default `new Date()`). */
  now?: () => Date;
  download?: Downloader;
  /** Checks whether a media file is already saved (default `existsSync`). */
  fileExists?: (path: string) => boolean;
  /** Maximum parallel downloads (default 4). */
  concurrency?: number;
  /** Skip all downloads for posts whose `media_path` is already set. */
  metricsOnly?: boolean;
}

export interface SyncError {
  /** Null when the error is not tied to one item (e.g. the listing failed). */
  igMediaId: string | null;
  message: string;
}

export interface SyncSummary {
  /** Media items returned by the API. */
  seen: number;
  newPosts: number;
  updatedPosts: number;
  snapshots: number;
  /** Files downloaded in this run. */
  downloads: number;
  /** Files not downloaded because they were already saved (or skipped by `metricsOnly`). */
  skippedDownloads: number;
  errors: SyncError[];
  /** Set when listing media failed, so the run did not see every post. */
  fatal: unknown;
}

export interface MediaTarget {
  url: string;
  /** File name inside the media dir: `<ig_media_id>[_n].<ext>`. */
  fileName: string;
}

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic"]);

/** Image file extension from a media URL's path, defaulting to `jpg`. */
export function mediaExtension(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return "jpg";
  }
  const ext = /\.([a-z0-9]+)$/i.exec(pathname)?.[1]?.toLowerCase();
  return ext && IMAGE_EXTENSIONS.has(ext) ? ext : "jpg";
}

/**
 * The image files to save for a media item, cover/first image first. Images use `media_url`,
 * videos their thumbnail, and carousels every image child as `<id>_<n>` (1-based position;
 * video children are skipped). A carousel without children falls back to its own image.
 */
export function mediaTargets(item: InstagramMedia): MediaTarget[] {
  const target = (url: string, suffix = ""): MediaTarget => ({
    url,
    fileName: `${item.id}${suffix}.${mediaExtension(url)}`,
  });

  if (item.mediaType === "CAROUSEL_ALBUM" && item.children.length > 0) {
    return item.children.flatMap((child, i) =>
      child.mediaType === "VIDEO" || !child.mediaUrl ? [] : [target(child.mediaUrl, `_${i + 1}`)],
    );
  }
  const url = item.mediaType === "VIDEO" ? item.thumbnailUrl : item.mediaUrl;
  return url ? [target(url)] : [];
}

export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;

/** `origin + pathname` of a URL, dropping the signed query string from error messages. */
function describeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/**
 * Downloads with `fetch`, writing to a `.part` file renamed into place on success. The whole
 * download (headers and body) is aborted after `timeoutMs` so a stalled CDN request cannot hang
 * the sync.
 */
export function createFetchDownloader(
  fetch: FetchLike = (input, init) => globalThis.fetch(input, init),
  { timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Downloader {
  return async (url, path) => {
    const where = describeUrl(url);
    const tmp = `${path}.part`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${where}`);
      await Bun.write(tmp, res);
      renameSync(tmp, path);
    } catch (err) {
      rmSync(tmp, { force: true });
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new Error(`Timed out after ${timeoutMs}ms downloading ${where}`);
      }
      throw err;
    }
  };
}

function createLimiter(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    // A finishing task hands its slot straight to the next waiter, so `active` never overshoots.
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Pulls every media item into `posts`, records a metrics snapshot per item, and saves media
 * files that are not yet on disk. `extracted_at` is never touched. Failures are collected in
 * the summary instead of aborting the run.
 */
export async function syncInstagram(options: SyncOptions): Promise<SyncSummary> {
  const {
    db,
    client,
    mediaDir,
    now = () => new Date(),
    download = createFetchDownloader(),
    fileExists = existsSync,
    concurrency = DEFAULT_DOWNLOAD_CONCURRENCY,
    metricsOnly = false,
  } = options;

  const summary: SyncSummary = {
    seen: 0,
    newPosts: 0,
    updatedPosts: 0,
    snapshots: 0,
    downloads: 0,
    skippedDownloads: 0,
    errors: [],
    fatal: null,
  };
  const capturedAt = now().toISOString();
  const limit = createLimiter(Math.max(1, concurrency));
  const pending: Promise<void>[] = [];
  mkdirSync(mediaDir, { recursive: true });

  async function saveMedia(igMediaId: string, targets: MediaTarget[]): Promise<void> {
    const saved = await Promise.all(
      targets.map(async ({ url, fileName }) => {
        const path = join(mediaDir, fileName);
        if (fileExists(path)) {
          summary.skippedDownloads++;
          return true;
        }
        try {
          await limit(() => download(url, path));
          summary.downloads++;
          return true;
        } catch (err) {
          summary.errors.push({ igMediaId, message: `${fileName}: ${errorMessage(err)}` });
          return false;
        }
      }),
    );
    const first = targets.find((_, i) => saved[i]);
    if (first) upsertPost(db, { igMediaId, mediaPath: first.fileName });
  }

  try {
    for await (const item of client.listMedia()) {
      summary.seen++;
      try {
        const existing = getPostByIgMediaId(db, item.id);
        const post = upsertPost(db, {
          igMediaId: item.id,
          permalink: item.permalink,
          caption: item.caption,
          mediaType: item.mediaType,
          mediaUrl:
            item.mediaType === "VIDEO" ? (item.thumbnailUrl ?? item.mediaUrl) : item.mediaUrl,
          postedAt: item.timestamp,
        });
        if (existing) summary.updatedPosts++;
        else summary.newPosts++;

        recordMetrics(db, post.id, item.likeCount, item.commentsCount, capturedAt);
        summary.snapshots++;

        const targets = mediaTargets(item);
        if (metricsOnly && post.mediaPath) {
          summary.skippedDownloads += targets.length;
        } else if (targets.length > 0) {
          pending.push(
            saveMedia(item.id, targets).catch((err) => {
              summary.errors.push({ igMediaId: item.id, message: errorMessage(err) });
            }),
          );
        }
      } catch (err) {
        summary.errors.push({ igMediaId: item.id, message: errorMessage(err) });
      }
    }
  } catch (err) {
    summary.fatal = err;
    summary.errors.push({ igMediaId: null, message: errorMessage(err) });
  }

  await Promise.all(pending);
  return summary;
}
