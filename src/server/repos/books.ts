import type { Database, SQLQueryBindings } from "bun:sqlite";
import { bookKey, bookTitleKey } from "../text/book-key";
import { findDuplicateHints, looksLikeSeries } from "../text/book-title";
import { HIGHLIGHT_POSTED_SQL } from "./highlights";
import { likeContains } from "./quotes";

/** Where a book record first came from. */
export type BookSource = "apple_books" | "caption" | "manual";

export interface Book {
  id: number;
  /** Apple Books asset id; null for books known only from captions or edits. */
  assetId: string | null;
  title: string | null;
  author: string | null;
  /** `bookKey(title, author)`; null only for Apple Books rows not yet backfilled. */
  normalizedKey: string | null;
  source: BookSource;
}

/** The slice of a book shown next to a quote. */
export interface BookRef {
  id: number;
  title: string | null;
  author: string | null;
}

export interface FindOrCreateBookInput {
  title: string;
  author?: string | null;
  /** Recorded only when a new row is created. Default "manual". */
  source?: BookSource;
  /** Apple Books asset id: matched first, and attached to a key match that lacks one. */
  assetId?: string | null;
}

export type BookSort = "title" | "quotes" | "posted" | "recent";

export interface ListBooksParams {
  /** Literal substring of the title or author (SQLite LIKE). */
  q?: string;
  sort: BookSort;
  /** Only books with at least one `BookIssue`. */
  attention?: boolean;
}

/**
 * Why a book may need a look (#34): no author, a title like another book's (see
 * `findDuplicateHints`), or a title that reads like a series name. Hints only.
 */
export type BookIssue = "no_author" | "possible_duplicate" | "series_title";

export interface BookSummary {
  id: number;
  assetId: string | null;
  title: string | null;
  author: string | null;
  source: BookSource;
  /** Quotes linked to the book. */
  quoteCount: number;
  /** Linked quotes that appear on at least one post. */
  postedCount: number;
  /** Highlights from the book that aren't posted and aren't one of its quotes. */
  unpostedHighlightCount: number;
  lastPostedAt: string | null;
  issues: BookIssue[];
}

/** Another book whose title is similar enough to be the same book. */
export interface PossibleDuplicate extends BookRef {
  quoteCount: number;
  /** Title similarity, 0..1 (see `titleSimilarity`). */
  score: number;
}

export interface BookEntryPosting {
  postId: number;
  postedAt: string | null;
  likes: number | null;
  comments: number | null;
  permalink: string | null;
  mediaPath: string | null;
}

/** One line of a book page: one of the book's quotes, or an unposted highlight. */
export interface BookEntry {
  kind: "quote" | "highlight";
  /** Set for quotes. */
  quoteId: number | null;
  /** Set for highlights. */
  highlightId: number | null;
  text: string | null;
  author: string | null;
  note: string | null;
  location: string | null;
  posted: boolean;
  /** When the quote (via a linked highlight) or highlight was highlighted in Apple Books. */
  highlightedAt: string | null;
  /** Oldest first. */
  postings: BookEntryPosting[];
}

export interface BookDetail {
  book: BookSummary;
  /** Posted quotes (latest posting first), then unposted quotes, then unposted highlights. */
  entries: BookEntry[];
  /** Best match first. */
  possibleDuplicates: PossibleDuplicate[];
}

export interface BackfillSummary {
  /** Existing books given a `normalized_key`. */
  booksKeyed: number;
  booksCreated: number;
  /** Quotes given a `book_id`. */
  quotesLinked: number;
}

const BOOK_COLUMNS = `b.id, b.asset_id AS assetId, b.title, b.author,
  b.normalized_key AS normalizedKey, b.source`;

function bookWhere(db: Database, where: string, binds: SQLQueryBindings): Book | null {
  return db
    .query<Book, SQLQueryBindings>(`SELECT ${BOOK_COLUMNS} FROM books b WHERE ${where}`)
    .get(binds);
}

export function getBook(db: Database, id: number): Book | null {
  return bookWhere(db, "b.id = $id", { id });
}

export function getBookRef(db: Database, id: number | null): BookRef | null {
  if (id === null) return null;
  const book = getBook(db, id);
  return book && { id: book.id, title: book.title, author: book.author };
}

/** The book recorded under a merged-away asset id or key (see migration 0004), or null. */
function aliasedBook(db: Database, kind: "asset" | "key", value: string): Book | null {
  return bookWhere(
    db,
    "b.id = (SELECT book_id FROM book_aliases WHERE kind = $kind AND value = $value)",
    { kind, value },
  );
}

/** The book for an Apple Books asset id: its own, or one it was merged into. */
export function bookForAsset(db: Database, assetId: string): Book | null {
  return bookWhere(db, "b.asset_id = $assetId", { assetId }) ?? aliasedBook(db, "asset", assetId);
}

export function requireBook(db: Database, id: number): Book {
  const book = getBook(db, id);
  if (!book) throw new Error(`Book ${id} not found`);
  return book;
}

/**
 * `findOrCreateBook`, also reporting whether the row was created. Null when the title is
 * empty.
 */
export function resolveBook(
  db: Database,
  { title: rawTitle, author: rawAuthor, source = "manual", assetId = null }: FindOrCreateBookInput,
): { book: Book; created: boolean } | null {
  const title = rawTitle.trim();
  const author = rawAuthor?.trim() || null;
  const key = bookKey(title, author);
  const titleKey = bookTitleKey(title);
  if (!key || !titleKey) return null;

  return db.transaction(() => {
    // Apple Books rows copied by migration 0002 have no key until keyed; key them first so a
    // caption import before `books:backfill` reuses them instead of creating a duplicate.
    keyUnkeyedBooks(db);
    if (assetId) {
      const byAsset = bookForAsset(db, assetId);
      if (byAsset) return { book: byAsset, created: false };
    }

    // An existing book gains the asset id if it has none.
    const adopt = (book: Book) => {
      if (!assetId || book.assetId !== null) return { book, created: false };
      db.query("UPDATE books SET asset_id = $assetId WHERE id = $id").run({ assetId, id: book.id });
      return { book: requireBook(db, book.id), created: false };
    };

    const exact = bookWhere(db, "b.normalized_key = $key", { key });
    if (exact) return adopt(exact);
    // The key of a book merged into another (e.g. "IQ84" into "1Q84").
    const aliased = aliasedBook(db, "key", key);
    if (aliased) return adopt(aliased);

    if (author) {
      // A book known only by its title (e.g. from an unattributed caption) gains the author.
      const bare = bookWhere(db, "b.normalized_key = $titleKey", { titleKey });
      if (bare) {
        db.query(
          `UPDATE books SET author = $author, normalized_key = $key,
             asset_id = COALESCE(asset_id, $assetId)
           WHERE id = $id`,
        ).run({ author, key, assetId, id: bare.id });
        return { book: requireBook(db, bare.id), created: false };
      }
      // A title-only book merged into another (its key is an alias of the kept book).
      const bareAlias = aliasedBook(db, "key", titleKey);
      if (bareAlias) return adopt(bareAlias);
    } else {
      // No author: reuse the authored book with this title, if there's exactly one, counting
      // books merged away under that title as the book they were merged into.
      const authored = db
        .query<Book, { prefix: string }>(
          `SELECT ${BOOK_COLUMNS} FROM books b
           WHERE substr(b.normalized_key, 1, length($prefix)) = $prefix
              OR b.id IN (SELECT book_id FROM book_aliases
                          WHERE kind = 'key' AND substr(value, 1, length($prefix)) = $prefix)
           LIMIT 2`,
        )
        .all({ prefix: `${titleKey}|` });
      if (authored.length === 1 && authored[0]) return adopt(authored[0]);
    }

    const inserted = db
      .query<{ id: number }, Record<string, string | null>>(
        `INSERT INTO books (asset_id, title, author, normalized_key, source)
         VALUES ($assetId, $title, $author, $key, $source) RETURNING id`,
      )
      .get({ assetId, title, author, key, source });
    if (!inserted) throw new Error("Book insert returned no row");
    return { book: requireBook(db, inserted.id), created: true };
  })();
}

/**
 * The book matching `title`/`author` by normalized key, created if missing. So
 * "Fool’s Errand" and "FOOL'S ERRAND" are the same book. Without an author, the single
 * authored book with that title is reused; with one, a title-only book is adopted and given
 * the author. Returns null when the title is empty.
 */
export function findOrCreateBook(db: Database, input: FindOrCreateBookInput): Book | null {
  return resolveBook(db, input)?.book ?? null;
}

/** The book of the quote's earliest linked Apple Books highlight, or null. */
export function highlightBookId(db: Database, quoteId: number): number | null {
  return (
    db
      .query<{ bookId: number }, { quoteId: number }>(
        `SELECT book_id AS bookId FROM highlights WHERE quote_id = $quoteId
         ORDER BY created_at, id LIMIT 1`,
      )
      .get({ quoteId })?.bookId ?? null
  );
}

/**
 * Deletes a caption or manual book that no quote or highlight refers to any more (e.g. one
 * left behind by a source-title typo fix). Apple Books records are kept, as is any book that
 * holds an Apple Books asset id (e.g. a caption book that adopted one, or kept one in a merge).
 */
export function deleteBookIfEmpty(db: Database, id: number): void {
  db.query(
    `DELETE FROM books WHERE id = $id AND source != 'apple_books' AND asset_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM quotes WHERE book_id = $id)
       AND NOT EXISTS (SELECT 1 FROM highlights WHERE book_id = $id)`,
  ).run({ id });
}

const POSTED_QUOTE_SQL = "EXISTS (SELECT 1 FROM post_quotes pq WHERE pq.quote_id = q.id)";

/** Highlight `h` of book `b` that is neither posted nor one of the book's own quotes. */
const LOOSE_HIGHLIGHT_SQL = `NOT ${HIGHLIGHT_POSTED_SQL}
  AND NOT EXISTS (SELECT 1 FROM quotes q WHERE q.id = h.quote_id AND q.book_id = h.book_id)`;

const SUMMARY_SQL = `
  SELECT b.id, b.asset_id AS assetId, b.title, b.author, b.source,
    (SELECT COUNT(*) FROM quotes q WHERE q.book_id = b.id) AS quoteCount,
    (SELECT COUNT(*) FROM quotes q WHERE q.book_id = b.id AND ${POSTED_QUOTE_SQL}) AS postedCount,
    (SELECT COUNT(*) FROM highlights h WHERE h.book_id = b.id AND ${LOOSE_HIGHLIGHT_SQL})
      AS unpostedHighlightCount,
    (SELECT MAX(p.posted_at) FROM quotes q
       JOIN post_quotes pq ON pq.quote_id = q.id JOIN posts p ON p.id = pq.post_id
       WHERE q.book_id = b.id) AS lastPostedAt
  FROM books b`;

const BOOK_SORT_SQL: Record<BookSort, string> = {
  title: "",
  quotes: "quoteCount DESC,",
  posted: "postedCount DESC,",
  recent: "lastPostedAt DESC NULLS LAST,",
};

type SummaryRow = Omit<BookSummary, "issues">;
type Hints = ReturnType<typeof findDuplicateHints>;

/** Title-similarity hints across every book (see `findDuplicateHints`). */
function duplicateHints(db: Database): Hints {
  return findDuplicateHints(
    db.query<{ id: number; title: string | null }, []>("SELECT id, title FROM books").all(),
  );
}

function issuesOf(book: SummaryRow, hints: Hints): BookIssue[] {
  const issues: BookIssue[] = [];
  if (!book.author?.trim()) issues.push("no_author");
  if (hints.has(book.id)) issues.push("possible_duplicate");
  if (looksLikeSeries(book.title)) issues.push("series_title");
  return issues;
}

export function listBooks(db: Database, { q, sort, attention }: ListBooksParams): BookSummary[] {
  const binds: Record<string, string> = {};
  let where = "";
  if (q) {
    where = "WHERE b.title LIKE $q ESCAPE '\\' OR b.author LIKE $q ESCAPE '\\'";
    binds.q = likeContains(q);
  }
  const hints = duplicateHints(db);
  const books = db
    .query<SummaryRow, SQLQueryBindings>(
      `${SUMMARY_SQL} ${where}
       ORDER BY ${BOOK_SORT_SQL[sort]} b.title COLLATE NOCASE NULLS LAST, b.id`,
    )
    .all(binds)
    .map((b) => ({ ...b, issues: issuesOf(b, hints) }));
  return attention ? books.filter((b) => b.issues.length > 0) : books;
}

function possibleDuplicates(db: Database, id: number, hints: Hints): PossibleDuplicate[] {
  const getRef = db.query<Omit<PossibleDuplicate, "score">, { id: number }>(
    `SELECT b.id, b.title, b.author,
       (SELECT COUNT(*) FROM quotes q WHERE q.book_id = b.id) AS quoteCount
     FROM books b WHERE b.id = $id`,
  );
  return (hints.get(id) ?? []).flatMap(({ id: otherId, score }) => {
    const ref = getRef.get({ id: otherId });
    return ref ? [{ ...ref, score }] : [];
  });
}

interface PostingRow extends BookEntryPosting {
  quoteId: number;
}

/** A book's summary plus every quote and unposted highlight from it. Null if missing. */
export function getBookDetail(db: Database, id: number): BookDetail | null {
  const row = db.query<SummaryRow, { id: number }>(`${SUMMARY_SQL} WHERE b.id = $id`).get({ id });
  if (!row) return null;
  const hints = duplicateHints(db);
  const book: BookSummary = { ...row, issues: issuesOf(row, hints) };

  const quotes = db
    .query<
      { id: number; text: string; author: string | null; highlightedAt: string | null },
      { id: number }
    >(
      `SELECT q.id, q.text, q.author,
         (SELECT MIN(h.created_at) FROM highlights h WHERE h.quote_id = q.id) AS highlightedAt
       FROM quotes q WHERE q.book_id = $id ORDER BY q.id`,
    )
    .all({ id });

  const postings = new Map<number, BookEntryPosting[]>();
  const postingRows = db
    .query<PostingRow, { id: number }>(
      `SELECT pq.quote_id AS quoteId, p.id AS postId, p.posted_at AS postedAt,
         p.like_count AS likes, p.comments_count AS comments, p.permalink,
         p.media_path AS mediaPath
       FROM quotes q JOIN post_quotes pq ON pq.quote_id = q.id JOIN posts p ON p.id = pq.post_id
       WHERE q.book_id = $id
       ORDER BY p.posted_at, p.id`,
    )
    .all({ id });
  for (const { quoteId, ...posting } of postingRows) {
    const list = postings.get(quoteId) ?? [];
    list.push(posting);
    postings.set(quoteId, list);
  }

  const quoteEntries: BookEntry[] = quotes.map((q) => {
    const list = postings.get(q.id) ?? [];
    return {
      kind: "quote",
      quoteId: q.id,
      highlightId: null,
      text: q.text,
      author: q.author,
      note: null,
      location: null,
      posted: list.length > 0,
      highlightedAt: q.highlightedAt,
      postings: list,
    };
  });
  const lastPosted = (e: BookEntry) => e.postings.at(-1)?.postedAt ?? "";
  const posted = quoteEntries
    .filter((e) => e.posted)
    .sort((a, b) => lastPosted(b).localeCompare(lastPosted(a)));
  const unposted = quoteEntries.filter((e) => !e.posted);

  const highlights: BookEntry[] = db
    .query<
      {
        id: number;
        text: string | null;
        note: string | null;
        location: string | null;
        createdAt: string | null;
      },
      { id: number }
    >(
      `SELECT h.id, h.text, h.note, h.location, h.created_at AS createdAt
       FROM highlights h WHERE h.book_id = $id AND ${LOOSE_HIGHLIGHT_SQL}
       ORDER BY h.created_at DESC NULLS LAST, h.id DESC`,
    )
    .all({ id })
    .map((h) => ({
      kind: "highlight",
      quoteId: null,
      highlightId: h.id,
      text: h.text,
      author: book.author,
      note: h.note,
      location: h.location,
      posted: false,
      highlightedAt: h.createdAt,
      postings: [],
    }));

  return {
    book,
    entries: [...posted, ...unposted, ...highlights],
    possibleDuplicates: possibleDuplicates(db, id, hints),
  };
}

/**
 * Gives unkeyed books (Apple Books rows from migration 0002) a `normalized_key`, unless another
 * book already has it. Returns how many were keyed.
 */
function keyUnkeyedBooks(db: Database): number {
  const unkeyed = db
    .query<{ id: number; title: string | null; author: string | null }, []>(
      "SELECT id, title, author FROM books WHERE normalized_key IS NULL ORDER BY id",
    )
    .all();
  let keyed = 0;
  for (const b of unkeyed) {
    const key = bookKey(b.title, b.author);
    if (!key || bookWhere(db, "b.normalized_key = $key", { key })) continue;
    db.query("UPDATE books SET normalized_key = $key WHERE id = $id").run({ key, id: b.id });
    keyed++;
  }
  return keyed;
}

/**
 * One-time (and idempotent) linking of existing data:
 * 1. give unkeyed books (from Apple Books) a `normalized_key`, unless another book has it;
 * 2. link quotes without a book through a linked highlight's book (the Apple Books record is
 *    authoritative, while a caption's source title may be worded differently);
 * 3. link remaining quotes by `source_title`/`author` (creating "caption" books).
 */
export function backfillBooks(db: Database): BackfillSummary {
  return db.transaction((): BackfillSummary => {
    const summary: BackfillSummary = { booksKeyed: 0, booksCreated: 0, quotesLinked: 0 };

    summary.booksKeyed = keyUnkeyedBooks(db);

    const setBook = db.query<void, { id: number; bookId: number }>(
      "UPDATE quotes SET book_id = $bookId WHERE id = $id",
    );
    // (`changes` would also count the FTS trigger's writes, so select first.)
    const byHighlight = db
      .query<{ id: number; bookId: number }, []>(
        `SELECT q.id, (SELECT h.book_id FROM highlights h WHERE h.quote_id = q.id
           ORDER BY h.created_at, h.id LIMIT 1) AS bookId
         FROM quotes q
         WHERE q.book_id IS NULL AND EXISTS (SELECT 1 FROM highlights h WHERE h.quote_id = q.id)
         ORDER BY q.id`,
      )
      .all();
    for (const q of byHighlight) {
      setBook.run(q);
      summary.quotesLinked++;
    }

    const bySource = db
      .query<{ id: number; sourceTitle: string; author: string | null }, []>(
        `SELECT id, source_title AS sourceTitle, author FROM quotes
         WHERE book_id IS NULL AND trim(COALESCE(source_title, '')) != '' ORDER BY id`,
      )
      .all();
    for (const q of bySource) {
      const resolved = resolveBook(db, {
        title: q.sourceTitle,
        author: q.author,
        source: "caption",
      });
      if (!resolved) continue;
      setBook.run({ id: q.id, bookId: resolved.book.id });
      summary.quotesLinked++;
      if (resolved.created) summary.booksCreated++;
    }

    return summary;
  })();
}
