import type { Database, SQLQueryBindings } from "bun:sqlite";
import { HIGHLIGHT_POSTED_SQL, likeContains } from "./sql";

export interface HighlightBook {
  id: number;
  assetId: string;
  title: string | null;
  author: string | null;
}

export interface HighlightRow {
  id: number;
  annotationUuid: string;
  text: string | null;
  note: string | null;
  location: string | null;
  createdAt: string | null;
  quoteId: number | null;
  /** True when the highlight is linked to a quote that appears on at least one post. */
  posted: boolean;
  book: HighlightBook;
}

export interface ListHighlightsParams {
  /** Only highlights not yet posted (no linked quote, or a linked quote with no posts). */
  unposted?: boolean;
  /** Literal substring of the book title (SQLite LIKE). */
  book?: string;
  /** Exact book id. */
  bookId?: number;
  /** Literal substring of the highlight text or note (SQLite LIKE). */
  q?: string;
  limit: number;
  offset: number;
}

export type HighlightFilter = Pick<ListHighlightsParams, "unposted" | "book" | "bookId" | "q">;

/** One book's share of the highlights matching a filter (`listHighlightBooks`). */
export interface HighlightBookGroup {
  book: HighlightBook;
  count: number;
  /** Newest `created_at` among the matching highlights; null when none are dated. */
  lastHighlightedAt: string | null;
}

export interface QuoteHighlight {
  id: number;
  text: string | null;
  note: string | null;
  location: string | null;
  createdAt: string | null;
  book: Pick<HighlightBook, "id" | "title" | "author">;
}

interface FlatHighlightRow extends Omit<HighlightRow, "posted" | "book"> {
  posted: number;
  bookId: number;
  bookAssetId: string;
  bookTitle: string | null;
  bookAuthor: string | null;
}

/** `FROM highlights h JOIN books b ... [WHERE ...]` and its binds for `filter`. */
function highlightsFrom(filter: HighlightFilter): {
  from: string;
  binds: Record<string, string | number>;
} {
  const where: string[] = [];
  const binds: Record<string, string | number> = {};
  if (filter.unposted) where.push(`NOT ${HIGHLIGHT_POSTED_SQL}`);
  if (filter.book) {
    where.push("b.title LIKE $book ESCAPE '\\'");
    binds.book = likeContains(filter.book);
  }
  if (filter.bookId !== undefined) {
    where.push("h.book_id = $bookId");
    binds.bookId = filter.bookId;
  }
  if (filter.q) {
    where.push("(h.text LIKE $q ESCAPE '\\' OR h.note LIKE $q ESCAPE '\\')");
    binds.q = likeContains(filter.q);
  }
  const from = `FROM highlights h JOIN books b ON b.id = h.book_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
  return { from, binds };
}

export function listHighlights(
  db: Database,
  params: ListHighlightsParams,
): { items: HighlightRow[]; total: number } {
  const { from, binds } = highlightsFrom(params);

  const total =
    db.query<{ n: number }, SQLQueryBindings>(`SELECT COUNT(*) AS n ${from}`).get(binds)?.n ?? 0;
  const rows = db
    .query<FlatHighlightRow, SQLQueryBindings>(
      `SELECT h.id, h.annotation_uuid AS annotationUuid, h.text, h.note, h.location,
         h.created_at AS createdAt, h.quote_id AS quoteId, ${HIGHLIGHT_POSTED_SQL} AS posted,
         b.id AS bookId, b.asset_id AS bookAssetId, b.title AS bookTitle, b.author AS bookAuthor
       ${from}
       ORDER BY h.created_at DESC NULLS LAST, h.id DESC
       LIMIT $limit OFFSET $offset`,
    )
    .all({ ...binds, limit: params.limit, offset: params.offset });

  const items = rows.map(({ posted, bookId, bookAssetId, bookTitle, bookAuthor, ...h }) => ({
    ...h,
    posted: posted === 1,
    book: { id: bookId, assetId: bookAssetId, title: bookTitle, author: bookAuthor },
  }));
  return { items, total };
}

/**
 * Per-book counts of the highlights matching `filter`, the book with the most recent matching
 * highlight first (books with only undated matches last); `total` is the sum of the counts.
 */
export function listHighlightBooks(
  db: Database,
  filter: HighlightFilter,
): { items: HighlightBookGroup[]; total: number } {
  const { from, binds } = highlightsFrom(filter);
  const rows = db
    .query<HighlightBook & { count: number; lastHighlightedAt: string | null }, SQLQueryBindings>(
      `SELECT b.id, b.asset_id AS assetId, b.title, b.author, COUNT(*) AS count,
         MAX(h.created_at) AS lastHighlightedAt
       ${from}
       GROUP BY b.id
       ORDER BY lastHighlightedAt DESC NULLS LAST, b.id DESC`,
    )
    .all(binds);
  const items = rows.map(({ count, lastHighlightedAt, ...book }) => ({
    book,
    count,
    lastHighlightedAt,
  }));
  return { items, total: items.reduce((n, g) => n + g.count, 0) };
}

/** Highlights linked to a quote, with their book, oldest first. */
export function getQuoteHighlights(db: Database, quoteId: number): QuoteHighlight[] {
  return db
    .query<
      Omit<QuoteHighlight, "book"> & {
        bookId: number;
        bookTitle: string | null;
        bookAuthor: string | null;
      },
      { quoteId: number }
    >(
      `SELECT h.id, h.text, h.note, h.location, h.created_at AS createdAt,
         b.id AS bookId, b.title AS bookTitle, b.author AS bookAuthor
       FROM highlights h JOIN books b ON b.id = h.book_id
       WHERE h.quote_id = $quoteId
       ORDER BY h.created_at, h.id`,
    )
    .all({ quoteId })
    .map(({ bookId, bookTitle, bookAuthor, ...h }) => ({
      ...h,
      book: { id: bookId, title: bookTitle, author: bookAuthor },
    }));
}
