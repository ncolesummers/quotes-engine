// SQL fragments shared across repos. A leaf module (no repo imports) so the repos never import
// each other just for these — that cycle made loading `highlights` or `stats` first throw.

/** LIKE pattern matching `s` as a literal substring (with `ESCAPE '\'`). */
export function likeContains(s: string): string {
  return `%${s.replace(/[\\%_]/g, "\\$&")}%`;
}

/** SQL expression: highlight `h` is linked to a quote with at least one post link. */
export const HIGHLIGHT_POSTED_SQL =
  "(h.quote_id IS NOT NULL AND EXISTS (SELECT 1 FROM post_quotes pq WHERE pq.quote_id = h.quote_id))";
