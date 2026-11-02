import type { Database } from "bun:sqlite";
import { classifyMatch, jaccard, LIKELY_THRESHOLD, trigrams } from "../text/similarity";
import type { LinkMethod } from "./quotes";

export interface ReviewLink {
  postId: number;
  quoteId: number;
  method: LinkMethod;
  confidence: number | null;
  post: {
    id: number;
    igMediaId: string;
    permalink: string | null;
    caption: string | null;
    postedAt: string | null;
    mediaPath: string | null;
  };
  quote: { id: number; text: string; author: string | null; sourceTitle: string | null };
}

export interface DuplicateQuote {
  id: number;
  text: string;
  author: string | null;
  sourceTitle: string | null;
  postingCount: number;
}

export interface DuplicatePair {
  /** The lower-id quote of the pair. */
  a: DuplicateQuote;
  b: DuplicateQuote;
  score: number;
}

export type ReviewAction = "confirm" | "reject";

/** `needs_review` post-quote links, newest post first. */
export function listReviewLinks(db: Database): ReviewLink[] {
  type Flat = Omit<ReviewLink, "post" | "quote"> & {
    igMediaId: string;
    permalink: string | null;
    caption: string | null;
    postedAt: string | null;
    mediaPath: string | null;
    text: string;
    author: string | null;
    sourceTitle: string | null;
  };
  return db
    .query<Flat, []>(
      `SELECT pq.post_id AS postId, pq.quote_id AS quoteId, pq.method, pq.confidence,
         p.ig_media_id AS igMediaId, p.permalink, p.caption, p.posted_at AS postedAt,
         p.media_path AS mediaPath, q.text, q.author, q.source_title AS sourceTitle
       FROM post_quotes pq
       JOIN posts p ON p.id = pq.post_id
       JOIN quotes q ON q.id = pq.quote_id
       WHERE pq.status = 'needs_review'
       ORDER BY p.posted_at DESC NULLS LAST, pq.post_id DESC, pq.quote_id`,
    )
    .all()
    .map((r) => ({
      postId: r.postId,
      quoteId: r.quoteId,
      method: r.method,
      confidence: r.confidence,
      post: {
        id: r.postId,
        igMediaId: r.igMediaId,
        permalink: r.permalink,
        caption: r.caption,
        postedAt: r.postedAt,
        mediaPath: r.mediaPath,
      },
      quote: { id: r.quoteId, text: r.text, author: r.author, sourceTitle: r.sourceTitle },
    }));
}

/**
 * Pairs of quotes whose normalized texts are fuzzy matches ("likely" or "same" per
 * `classifyMatch` of `normalizedSimilarity`), highest score first.
 *
 * An O(n²) scan with two exact shortcuts: trigram sets are built once per quote, and since
 * Jaccard(A, B) <= |A| / |B| for |A| <= |B|, quotes are visited in order of set size and the
 * inner loop stops once the size ratio alone rules out a "likely" score.
 */
export function findDuplicatePairs(db: Database): DuplicatePair[] {
  const quotes = db
    .query<DuplicateQuote & { normalizedText: string }, []>(
      `SELECT q.id, q.text, q.author, q.source_title AS sourceTitle,
         q.normalized_text AS normalizedText,
         (SELECT COUNT(*) FROM post_quotes pq WHERE pq.quote_id = q.id) AS postingCount
       FROM quotes q`,
    )
    .all()
    .map(({ normalizedText, ...quote }) => ({ quote, grams: trigrams(normalizedText) }))
    .sort((x, y) => x.grams.size - y.grams.size);

  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < quotes.length; i++) {
    const small = quotes[i] as (typeof quotes)[number];
    for (let j = i + 1; j < quotes.length; j++) {
      const large = quotes[j] as (typeof quotes)[number];
      if (small.grams.size < LIKELY_THRESHOLD * large.grams.size) break;
      const score = jaccard(small.grams, large.grams);
      if (classifyMatch(score) === "different") continue;
      const [a, b] =
        small.quote.id < large.quote.id ? [small.quote, large.quote] : [large.quote, small.quote];
      pairs.push({ a, b, score });
    }
  }
  return pairs.sort((x, y) => y.score - x.score || x.a.id - y.a.id || x.b.id - y.b.id);
}

/**
 * Resolve a post-quote link: `confirm` marks it confirmed, `reject` deletes it.
 * Returns false when the link doesn't exist.
 */
export function resolveLink(
  db: Database,
  postId: number,
  quoteId: number,
  action: ReviewAction,
): boolean {
  const ids = { postId, quoteId };
  const sql =
    action === "confirm"
      ? "UPDATE post_quotes SET status = 'confirmed' WHERE post_id = $postId AND quote_id = $quoteId"
      : "DELETE FROM post_quotes WHERE post_id = $postId AND quote_id = $quoteId";
  return db.query(sql).run(ids).changes > 0;
}
