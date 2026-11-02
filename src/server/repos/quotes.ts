import type { Database, SQLQueryBindings } from "bun:sqlite";
import { normalizeQuote } from "../text/normalize";
import { classifyMatch, normalizedSimilarity } from "../text/similarity";
import { type BookRef, type BookSource, findOrCreateBook, getBook, getBookRef } from "./books";

export interface Quote {
  id: number;
  text: string;
  normalizedText: string;
  author: string | null;
  sourceTitle: string | null;
  notes: string | null;
  /** The book `sourceTitle` resolved to (see `findOrCreateBook`), or null. */
  bookId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuoteInput {
  text: string;
  author?: string | null;
  sourceTitle?: string | null;
  /** `source` for a book created from `sourceTitle`. Default "manual". */
  bookSource?: BookSource;
}

export type QuoteMatch = "new" | "existing" | "likely";

export interface UpsertQuoteResult {
  quote: Quote;
  match: QuoteMatch;
  /** Set when `match` is "likely": the existing quote the new one probably duplicates. */
  candidateId?: number;
}

export type LinkMethod = "caption" | "image" | "manual";
export type LinkStatus = "confirmed" | "needs_review";

export interface LinkOptions {
  method: LinkMethod;
  confidence: number | null;
  status: LinkStatus;
}

export type QuoteSort = "likes" | "comments" | "recent" | "postings";

export interface SearchQuotesParams {
  /** Free-text search over text, author and source (FTS5, prefix match per word). */
  q?: string;
  /** Literal substring of the author; case-insensitive for ASCII (SQLite LIKE). */
  author?: string;
  /** Like `author`, matched against the source title or a linked highlight's book title. */
  book?: string;
  posted?: "yes" | "no";
  minPostings?: number;
  sort: QuoteSort;
  limit: number;
  offset: number;
}

export interface QuoteSearchRow extends Quote {
  book: BookRef | null;
  postingCount: number;
  totalLikes: number;
  maxLikes: number | null;
  totalComments: number;
  lastPostedAt: string | null;
}

export interface QuoteSearchResult {
  items: QuoteSearchRow[];
  /** Total matching rows, ignoring limit/offset. */
  total: number;
}

export interface QuotePosting {
  postId: number;
  igMediaId: string;
  permalink: string | null;
  mediaPath: string | null;
  postedAt: string | null;
  likes: number | null;
  comments: number | null;
  method: LinkMethod;
  confidence: number | null;
  status: LinkStatus;
}

export interface QuoteDetail {
  quote: Quote;
  book: BookRef | null;
  postings: QuotePosting[];
}

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

const QUOTE_COLUMNS = `
  q.id, q.text, q.normalized_text AS normalizedText, q.author, q.source_title AS sourceTitle,
  q.notes, q.book_id AS bookId, q.created_at AS createdAt, q.updated_at AS updatedAt`;

export function getQuote(db: Database, id: number): Quote | null {
  return db
    .query<Quote, { id: number }>(`SELECT ${QUOTE_COLUMNS} FROM quotes q WHERE q.id = $id`)
    .get({ id });
}

function requireQuote(db: Database, id: number): Quote {
  const quote = getQuote(db, id);
  if (!quote) throw new Error(`Quote ${id} not found`);
  return quote;
}

/** Id of the book for `sourceTitle`/`author` (created if needed), or null without a title. */
function resolveBookId(
  db: Database,
  sourceTitle: string | null | undefined,
  author: string | null | undefined,
  source: BookSource = "manual",
): number | null {
  if (!sourceTitle) return null;
  return findOrCreateBook(db, { title: sourceTitle, author, source })?.id ?? null;
}

/**
 * Fill a quote's missing author/source/book from `input`; never overwrites existing values.
 * The book is resolved from the quote's (possibly just filled) source title.
 */
function fillMissing(db: Database, quote: Quote, input: QuoteInput): Quote {
  const author = quote.author ?? input.author ?? null;
  const sourceTitle = quote.sourceTitle ?? input.sourceTitle ?? null;
  const bookId = quote.bookId ?? resolveBookId(db, sourceTitle, author, input.bookSource);
  if (author === quote.author && sourceTitle === quote.sourceTitle && bookId === quote.bookId) {
    return quote;
  }
  db.query(
    `UPDATE quotes SET author = $author, source_title = $sourceTitle, book_id = $bookId,
       updated_at = ${NOW_SQL}
     WHERE id = $id`,
  ).run({ id: quote.id, author, sourceTitle, bookId });
  return requireQuote(db, quote.id);
}

/** Best fuzzy match among existing quotes. A linear scan: the catalog is small. */
function bestCandidate(db: Database, normalized: string): { id: number; score: number } | null {
  let best: { id: number; score: number } | null = null;
  const rows = db
    .query<{ id: number; normalizedText: string }, []>(
      "SELECT id, normalized_text AS normalizedText FROM quotes",
    )
    .all();
  for (const row of rows) {
    const score = normalizedSimilarity(normalized, row.normalizedText);
    if (!best || score > best.score) best = { id: row.id, score };
  }
  return best;
}

/**
 * Insert a quote unless it duplicates an existing one.
 * - Same `normalized_text`, or a fuzzy "same" score: returns the existing quote (`existing`),
 *   filling in its author/source if they were missing.
 * - Fuzzy "likely" score: inserts the quote and reports `candidateId` for review (`likely`).
 * - Otherwise inserts it (`new`).
 */
export function upsertQuote(db: Database, input: QuoteInput): UpsertQuoteResult {
  const normalized = normalizeQuote(input.text);
  if (!normalized) throw new Error("Quote text is empty after normalization");

  return db.transaction((): UpsertQuoteResult => {
    const exact = db
      .query<{ id: number }, { normalized: string }>(
        "SELECT id FROM quotes WHERE normalized_text = $normalized",
      )
      .get({ normalized });
    const candidate = exact ? { id: exact.id, score: 1 } : bestCandidate(db, normalized);
    const match = candidate ? classifyMatch(candidate.score) : "different";

    if (candidate && match === "same") {
      return { quote: fillMissing(db, requireQuote(db, candidate.id), input), match: "existing" };
    }

    const inserted = db
      .query<{ id: number }, Record<string, string | number | null>>(
        `INSERT INTO quotes (text, normalized_text, author, source_title, book_id)
         VALUES ($text, $normalized, $author, $sourceTitle, $bookId) RETURNING id`,
      )
      .get({
        text: input.text.trim(),
        normalized,
        author: input.author ?? null,
        sourceTitle: input.sourceTitle ?? null,
        bookId: resolveBookId(db, input.sourceTitle, input.author, input.bookSource),
      });
    if (!inserted) throw new Error("Quote insert returned no row");
    const quote = requireQuote(db, inserted.id);

    if (candidate && match === "likely") {
      return { quote, match: "likely", candidateId: candidate.id };
    }
    return { quote, match: "new" };
  })();
}

/**
 * Link a post to a quote. Idempotent: an existing link (and its status) is left untouched.
 * Returns the link's persisted status.
 */
export function linkPostQuote(
  db: Database,
  postId: number,
  quoteId: number,
  { method, confidence, status }: LinkOptions,
): LinkStatus {
  const row = db
    .query<{ status: LinkStatus }, Record<string, string | number | null>>(
      `INSERT INTO post_quotes (post_id, quote_id, method, confidence, status)
       VALUES ($postId, $quoteId, $method, $confidence, $status)
       ON CONFLICT (post_id, quote_id) DO UPDATE SET status = status
       RETURNING status`,
    )
    .get({ postId, quoteId, method, confidence, status });
  if (!row) throw new Error(`linkPostQuote returned no row for post ${postId}, quote ${quoteId}`);
  return row.status;
}

/**
 * Escape free text into an FTS5 query: each word becomes a quoted prefix term ("word"*),
 * implicitly ANDed. FTS operators and stray quotes in the input are treated as plain words or
 * dropped. Returns null when the input has no searchable words.
 */
export function toFtsQuery(q: string): string | null {
  const words = q.match(/[\p{L}\p{M}\p{N}]+/gu);
  return words ? words.map((w) => `"${w}"*`).join(" ") : null;
}

const SORT_SQL: Record<QuoteSort, string> = {
  likes: "totalLikes DESC",
  comments: "totalComments DESC",
  postings: "postingCount DESC",
  recent: "lastPostedAt DESC NULLS LAST",
};

/** LIKE pattern matching `s` as a literal substring (with `ESCAPE '\'`). */
export function likeContains(s: string): string {
  return `%${s.replace(/[\\%_]/g, "\\$&")}%`;
}

export function searchQuotes(db: Database, params: SearchQuotesParams): QuoteSearchResult {
  const where: string[] = [];
  const having: string[] = [];
  const binds: Record<string, string | number> = {};

  const match = params.q ? toFtsQuery(params.q) : null;
  if (match) {
    where.push("q.id IN (SELECT rowid FROM quotes_fts WHERE quotes_fts MATCH $match)");
    binds.match = match;
  }
  if (params.author) {
    where.push("q.author LIKE $author ESCAPE '\\'");
    binds.author = likeContains(params.author);
  }
  if (params.book) {
    where.push(`(q.source_title LIKE $book ESCAPE '\\' OR bk.title LIKE $book ESCAPE '\\'
      OR EXISTS (
      SELECT 1 FROM highlights h JOIN books b ON b.id = h.book_id
      WHERE h.quote_id = q.id AND b.title LIKE $book ESCAPE '\\'))`);
    binds.book = likeContains(params.book);
  }
  if (params.posted === "yes") having.push("postingCount > 0");
  if (params.posted === "no") having.push("postingCount = 0");
  if (params.minPostings !== undefined) {
    having.push("postingCount >= $minPostings");
    binds.minPostings = params.minPostings;
  }

  const filtered = `
    SELECT ${QUOTE_COLUMNS},
      COUNT(p.id) AS postingCount,
      COALESCE(SUM(p.like_count), 0) AS totalLikes,
      MAX(p.like_count) AS maxLikes,
      COALESCE(SUM(p.comments_count), 0) AS totalComments,
      MAX(p.posted_at) AS lastPostedAt,
      bk.title AS bookTitle, bk.author AS bookAuthor
    FROM quotes q
    LEFT JOIN books bk ON bk.id = q.book_id
    LEFT JOIN post_quotes pq ON pq.quote_id = q.id
    LEFT JOIN posts p ON p.id = pq.post_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    GROUP BY q.id
    ${having.length ? `HAVING ${having.join(" AND ")}` : ""}`;

  const total =
    db.query<{ n: number }, SQLQueryBindings>(`SELECT COUNT(*) AS n FROM (${filtered})`).get(binds)
      ?.n ?? 0;
  const items = db
    .query<
      Omit<QuoteSearchRow, "book"> & { bookTitle: string | null; bookAuthor: string | null },
      SQLQueryBindings
    >(
      `${filtered}
       ORDER BY ${SORT_SQL[params.sort]}, lastPostedAt DESC NULLS LAST, q.id DESC
       LIMIT $limit OFFSET $offset`,
    )
    .all({ ...binds, limit: params.limit, offset: params.offset })
    .map(({ bookTitle, bookAuthor, ...row }) => ({
      ...row,
      book: row.bookId === null ? null : { id: row.bookId, title: bookTitle, author: bookAuthor },
    }));
  return { items, total };
}

/** A quote and every post it appeared on, oldest first. Null if the quote doesn't exist. */
export function getQuoteDetail(db: Database, id: number): QuoteDetail | null {
  const quote = getQuote(db, id);
  if (!quote) return null;
  const postings = db
    .query<QuotePosting, { id: number }>(
      `SELECT p.id AS postId, p.ig_media_id AS igMediaId, p.permalink, p.media_path AS mediaPath,
         p.posted_at AS postedAt, p.like_count AS likes, p.comments_count AS comments,
         pq.method, pq.confidence, pq.status
       FROM post_quotes pq JOIN posts p ON p.id = pq.post_id
       WHERE pq.quote_id = $id
       ORDER BY p.posted_at, p.id`,
    )
    .all({ id });
  return { quote, book: getBookRef(db, quote.bookId), postings };
}

/**
 * Merge `dropId` into `keepId`: moves post links (keeping keep's link where both share a post)
 * and highlights, fills keep's missing author/source/notes from drop, then deletes drop.
 */
export function mergeQuotes(db: Database, keepId: number, dropId: number): Quote {
  if (keepId === dropId) throw new Error("Cannot merge a quote into itself");
  return db.transaction((): Quote => {
    requireQuote(db, keepId);
    requireQuote(db, dropId);
    const ids = { keepId, dropId };
    db.query(
      `INSERT OR IGNORE INTO post_quotes (post_id, quote_id, method, confidence, status)
       SELECT post_id, $keepId, method, confidence, status FROM post_quotes WHERE quote_id = $dropId`,
    ).run(ids);
    db.query("UPDATE highlights SET quote_id = $keepId WHERE quote_id = $dropId").run(ids);
    db.query(
      `UPDATE quotes SET
         author = COALESCE(author, (SELECT author FROM quotes WHERE id = $dropId)),
         source_title = COALESCE(source_title, (SELECT source_title FROM quotes WHERE id = $dropId)),
         notes = COALESCE(notes, (SELECT notes FROM quotes WHERE id = $dropId)),
         book_id = COALESCE(book_id, (SELECT book_id FROM quotes WHERE id = $dropId)),
         updated_at = ${NOW_SQL}
       WHERE id = $keepId`,
    ).run(ids);
    db.query("DELETE FROM quotes WHERE id = $dropId").run({ dropId });
    return requireQuote(db, keepId);
  })();
}

export interface QuotePatch {
  text?: string;
  author?: string | null;
  sourceTitle?: string | null;
  notes?: string | null;
}

export type UpdateQuoteResult =
  | { status: "updated"; quote: Quote }
  | { status: "not_found" }
  | { status: "empty_text" }
  /** Another quote already has the new text's normalized form. */
  | { status: "conflict"; conflictId: number };

const PATCH_COLUMNS = [
  ["author", "author"],
  ["sourceTitle", "source_title"],
  ["notes", "notes"],
] as const;

/**
 * The book a quote should link to after `patch`, or undefined to leave it. A new or cleared
 * source title re-resolves (or unlinks) the book. An author change alone re-resolves only
 * when the quote has no book yet or its book has no author, since the quote's author may be
 * a character rather than the book's author.
 */
function relinkedBookId(
  db: Database,
  current: Quote,
  patch: QuotePatch,
): number | null | undefined {
  const sourceTitle = patch.sourceTitle === undefined ? current.sourceTitle : patch.sourceTitle;
  const author = patch.author === undefined ? current.author : patch.author;
  if (patch.sourceTitle !== undefined) return resolveBookId(db, sourceTitle, author);
  if (patch.author === undefined || !sourceTitle) return undefined;
  const book = current.bookId === null ? null : getBook(db, current.bookId);
  if (book?.author) return undefined;
  return resolveBookId(db, sourceTitle, author);
}

/**
 * Update a quote's editable fields; undefined fields are kept. A new `text` is trimmed and its
 * `normalized_text` recomputed; it must not normalize to empty or collide with another quote.
 */
export function updateQuote(db: Database, id: number, patch: QuotePatch): UpdateQuoteResult {
  return db.transaction((): UpdateQuoteResult => {
    const current = getQuote(db, id);
    if (!current) return { status: "not_found" };
    const sets: string[] = [];
    const binds: Record<string, string | number | null> = { id };

    if (patch.text !== undefined) {
      const normalized = normalizeQuote(patch.text);
      if (!normalized) return { status: "empty_text" };
      const clash = db
        .query<{ id: number }, { normalized: string; id: number }>(
          "SELECT id FROM quotes WHERE normalized_text = $normalized AND id != $id",
        )
        .get({ normalized, id });
      if (clash) return { status: "conflict", conflictId: clash.id };
      sets.push("text = $text", "normalized_text = $normalized");
      binds.text = patch.text.trim();
      binds.normalized = normalized;
    }
    for (const [key, column] of PATCH_COLUMNS) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column} = $${key}`);
      binds[key] = value;
    }
    const bookId = relinkedBookId(db, current, patch);
    if (bookId !== undefined) {
      sets.push("book_id = $bookId");
      binds.bookId = bookId;
    }
    if (sets.length) {
      db.query(`UPDATE quotes SET ${sets.join(", ")}, updated_at = ${NOW_SQL} WHERE id = $id`).run(
        binds,
      );
    }
    return { status: "updated", quote: requireQuote(db, id) };
  })();
}
