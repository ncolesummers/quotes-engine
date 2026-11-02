import type { Database } from "bun:sqlite";
import { HIGHLIGHT_POSTED_SQL } from "./sql";

export interface Stats {
  quotes: number;
  posts: number;
  /** Quotes linked to two or more posts. */
  repostedQuotes: number;
  highlights: number;
  /** Highlights not yet posted (see `listHighlights({ unposted: true })`). */
  highlightsBacklog: number;
  /** Post-quote links awaiting review. */
  needsReview: number;
}

export function getStats(db: Database): Stats {
  const stats = db
    .query<Stats, []>(
      `SELECT
         (SELECT COUNT(*) FROM quotes) AS quotes,
         (SELECT COUNT(*) FROM posts) AS posts,
         (SELECT COUNT(*) FROM (
            SELECT quote_id FROM post_quotes GROUP BY quote_id HAVING COUNT(*) >= 2
          )) AS repostedQuotes,
         (SELECT COUNT(*) FROM highlights) AS highlights,
         (SELECT COUNT(*) FROM highlights h WHERE NOT ${HIGHLIGHT_POSTED_SQL}) AS highlightsBacklog,
         (SELECT COUNT(*) FROM post_quotes WHERE status = 'needs_review') AS needsReview`,
    )
    .get();
  if (!stats) throw new Error("getStats returned no row");
  return stats;
}
