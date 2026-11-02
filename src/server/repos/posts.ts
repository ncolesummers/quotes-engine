import type { Database } from "bun:sqlite";

export interface Post {
  id: number;
  igMediaId: string;
  permalink: string | null;
  caption: string | null;
  mediaType: string | null;
  mediaUrl: string | null;
  mediaPath: string | null;
  postedAt: string | null;
  likeCount: number | null;
  commentsCount: number | null;
  metricsUpdatedAt: string | null;
  extractedAt: string | null;
}

export interface PostInput {
  igMediaId: string;
  permalink?: string | null;
  caption?: string | null;
  mediaType?: string | null;
  mediaUrl?: string | null;
  mediaPath?: string | null;
  postedAt?: string | null;
}

const POST_COLUMNS = `
  id, ig_media_id AS igMediaId, permalink, caption, media_type AS mediaType,
  media_url AS mediaUrl, media_path AS mediaPath, posted_at AS postedAt,
  like_count AS likeCount, comments_count AS commentsCount,
  metrics_updated_at AS metricsUpdatedAt, extracted_at AS extractedAt`;

/**
 * Insert a post, or update it by `ig_media_id`. Fields left undefined/null keep their stored
 * value. Metrics and extraction state are managed by `recordMetrics` / `markExtracted`.
 */
export function upsertPost(db: Database, input: PostInput): Post {
  const post = db
    .query<Post, Record<string, string | null>>(
      `INSERT INTO posts (ig_media_id, permalink, caption, media_type, media_url, media_path, posted_at)
       VALUES ($igMediaId, $permalink, $caption, $mediaType, $mediaUrl, $mediaPath, $postedAt)
       ON CONFLICT (ig_media_id) DO UPDATE SET
         permalink = COALESCE(excluded.permalink, permalink),
         caption = COALESCE(excluded.caption, caption),
         media_type = COALESCE(excluded.media_type, media_type),
         media_url = COALESCE(excluded.media_url, media_url),
         media_path = COALESCE(excluded.media_path, media_path),
         posted_at = COALESCE(excluded.posted_at, posted_at)
       RETURNING ${POST_COLUMNS}`,
    )
    .get({
      igMediaId: input.igMediaId,
      permalink: input.permalink ?? null,
      caption: input.caption ?? null,
      mediaType: input.mediaType ?? null,
      mediaUrl: input.mediaUrl ?? null,
      mediaPath: input.mediaPath ?? null,
      postedAt: input.postedAt ?? null,
    });
  if (!post) throw new Error(`upsertPost returned no row for ${input.igMediaId}`);
  return post;
}

export function getPost(db: Database, id: number): Post | null {
  return db.query<Post, { id: number }>(`SELECT ${POST_COLUMNS} FROM posts WHERE id = $id`).get({
    id,
  });
}

/**
 * Store a metrics snapshot and update the post's current counts, unless the post already
 * holds counts captured later than `capturedAt`.
 */
export function recordMetrics(
  db: Database,
  postId: number,
  likes: number | null,
  comments: number | null,
  capturedAt: string,
): void {
  db.transaction(() => {
    db.query(
      `INSERT INTO metric_snapshots (post_id, captured_at, likes, comments)
       VALUES ($postId, $capturedAt, $likes, $comments)`,
    ).run({ postId, capturedAt, likes, comments });
    db.query(
      `UPDATE posts SET like_count = $likes, comments_count = $comments, metrics_updated_at = $capturedAt
       WHERE id = $postId AND (metrics_updated_at IS NULL OR metrics_updated_at <= $capturedAt)`,
    ).run({ postId, capturedAt, likes, comments });
  })();
}

/** Posts not yet run through quote extraction, oldest first. */
export function listUnextractedPosts(db: Database): Post[] {
  return db
    .query<Post, []>(
      `SELECT ${POST_COLUMNS} FROM posts WHERE extracted_at IS NULL ORDER BY posted_at, id`,
    )
    .all();
}

export function markExtracted(db: Database, postId: number, extractedAt: string): void {
  db.query("UPDATE posts SET extracted_at = $extractedAt WHERE id = $postId").run({
    postId,
    extractedAt,
  });
}
