import type { Database } from "bun:sqlite";
import { classifyMatch, jaccard, LIKELY_THRESHOLD, trigrams } from "../text/similarity";
import { type LinkMethod, type SourceKind, updateQuote } from "./quotes";

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
  quote: {
    id: number;
    text: string;
    author: string | null;
    sourceTitle: string | null;
    sourceKind: SourceKind;
  };
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

/** `song` marks the quote a song (unlinking its book) and confirms the link (#42). */
export type ReviewAction = "confirm" | "reject" | "song";

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
    sourceKind: SourceKind;
  };
  return db
    .query<Flat, []>(
      `SELECT pq.post_id AS postId, pq.quote_id AS quoteId, pq.method, pq.confidence,
         p.ig_media_id AS igMediaId, p.permalink, p.caption, p.posted_at AS postedAt,
         p.media_path AS mediaPath, q.text, q.author, q.source_title AS sourceTitle,
         q.source_kind AS sourceKind
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
      quote: {
        id: r.quoteId,
        text: r.text,
        author: r.author,
        sourceTitle: r.sourceTitle,
        sourceKind: r.sourceKind,
      },
    }));
}

/**
 * Pairs of quotes whose normalized texts are fuzzy matches ("likely" or "same" per
 * `classifyMatch` of `normalizedSimilarity`), highest score first.
 *
 * An O(n²) scan with two exact shortcuts: trigram sets are built once per quote, and since
 * Jaccard(A, B) <= |A| / |B| for |A| <= |B|, quotes are visited in order of set size and the
 * inner loop stops once the size ratio alone rules out a "likely" score. Pairs dismissed with
 * `dismissDuplicatePair` are left out.
 */
export function findDuplicatePairs(db: Database): DuplicatePair[] {
  const dismissed = new Set(
    db
      .query<{ key: string }, []>("SELECT a_id || '-' || b_id AS key FROM quote_not_duplicates")
      .all()
      .map((r) => r.key),
  );
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
      if (dismissed.has(`${a.id}-${b.id}`)) continue;
      pairs.push({ a, b, score });
    }
  }
  return pairs.sort((x, y) => y.score - x.score || x.a.id - y.a.id || x.b.id - y.b.id);
}

/**
 * Resolve a post-quote link: `confirm` marks it confirmed, `reject` deletes it, `song` marks the
 * quote a song (see `updateQuote`) and confirms the link. Returns false when the link doesn't
 * exist, changing nothing.
 */
export function resolveLink(
  db: Database,
  postId: number,
  quoteId: number,
  action: ReviewAction,
): boolean {
  const ids = { postId, quoteId };
  if (action === "reject") {
    return (
      db.query("DELETE FROM post_quotes WHERE post_id = $postId AND quote_id = $quoteId").run(ids)
        .changes > 0
    );
  }
  return db
    .transaction(() => {
      const confirmed = db
        .query(
          "UPDATE post_quotes SET status = 'confirmed' WHERE post_id = $postId AND quote_id = $quoteId",
        )
        .run(ids);
      if (confirmed.changes === 0) return false;
      if (action === "song") {
        const result = updateQuote(db, quoteId, { sourceKind: "song" });
        // Throwing rolls back the confirmation too, so the link isn't confirmed as a song.
        if (result.status !== "updated") {
          throw new Error(`Could not mark quote ${quoteId} a song: ${result.status}`);
        }
      }
      return true;
    })
    .immediate();
}

/**
 * Record that two quotes are not duplicates, so `findDuplicatePairs` stops suggesting them.
 * Order-independent and idempotent. Returns false when either quote doesn't exist.
 */
export function dismissDuplicatePair(db: Database, x: number, y: number): boolean {
  if (x === y) throw new Error("A quote can't be a duplicate of itself");
  const [aId, bId] = x < y ? [x, y] : [y, x];
  const found = db
    .query<{ n: number }, [number, number]>("SELECT COUNT(*) AS n FROM quotes WHERE id IN (?1, ?2)")
    .get(aId, bId);
  if (found?.n !== 2) return false;
  db.query("INSERT OR IGNORE INTO quote_not_duplicates (a_id, b_id) VALUES (?1, ?2)").run(aId, bId);
  return true;
}
