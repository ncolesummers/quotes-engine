// Songs (and other non-book sources) as quote sources (#42). Lyrics here are synthetic.
import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { createTestDb } from "../../../test/helpers/db";
import { type Seeder, seed } from "../../../test/helpers/seed";
import { backfillBooks, getBook } from "./books";
import { requeuePosts } from "./posts";
import {
  getQuote,
  mergeQuotes,
  type SearchQuotesParams,
  searchQuotes,
  updateQuote,
  upsertQuote,
} from "./quotes";
import { listReviewLinks, resolveLink } from "./review";

let db: Database;
let s: Seeder;

beforeEach(() => {
  db = createTestDb();
  s = seed(db);
});

const LYRIC = "Static on the radio, lanterns in the rain";
const bookCount = () => (db.query("SELECT COUNT(*) AS n FROM books").get() as { n: number }).n;

function searchAll(extra: Partial<SearchQuotesParams>) {
  return searchQuotes(db, { sort: "recent", limit: 50, offset: 0, ...extra }).items.map(
    (q) => q.id,
  );
}

describe("migration 0005_source_kind", () => {
  test("defaults source_kind to 'book'", () => {
    const q = s.quote({ text: "A plain book quote" });
    expect(q.sourceKind).toBe("book");
  });

  test("the CHECK constraint rejects unknown kinds", () => {
    const q = s.quote({ text: "Another quote" });
    expect(() => db.query("UPDATE quotes SET source_kind = 'poem' WHERE id = ?").run(q.id)).toThrow(
      /CHECK/,
    );
    for (const kind of ["book", "song", "other"]) {
      db.query("UPDATE quotes SET source_kind = ? WHERE id = ?").run(kind, q.id);
    }
  });
});

describe("updateQuote sourceKind", () => {
  test("marking a quote as a song clears book_id and deletes the orphaned caption book", () => {
    const { quote } = upsertQuote(db, {
      text: LYRIC,
      author: "Paper Lanterns",
      sourceTitle: "Northbound Static",
      bookSource: "caption",
    });
    const bookId = quote.bookId as number;
    expect(bookId).not.toBeNull();

    const result = updateQuote(db, quote.id, { sourceKind: "song" });
    expect(result.status).toBe("updated");
    const updated = getQuote(db, quote.id);
    expect(updated).toMatchObject({
      sourceKind: "song",
      bookId: null,
      author: "Paper Lanterns",
      sourceTitle: "Northbound Static",
    });
    expect(getBook(db, bookId)).toBeNull();
  });

  test("keeps a book still used by another quote", () => {
    const a = upsertQuote(db, { text: LYRIC, sourceTitle: "Shared", bookSource: "caption" });
    const b = upsertQuote(db, {
      text: "A different line entirely about rivers",
      sourceTitle: "Shared",
      bookSource: "caption",
    });
    expect(a.quote.bookId).toBe(b.quote.bookId);
    updateQuote(db, a.quote.id, { sourceKind: "song" });
    expect(getBook(db, b.quote.bookId as number)).not.toBeNull();
  });

  test("keeps an Apple Books book", () => {
    const book = s.book({ title: "Real Book", author: "Someone" });
    const q = s.quote({ text: LYRIC });
    db.query("UPDATE quotes SET book_id = ? WHERE id = ?").run(book.id, q.id);
    updateQuote(db, q.id, { sourceKind: "song" });
    expect(getQuote(db, q.id)?.bookId).toBeNull();
    expect(getBook(db, book.id)).not.toBeNull();
  });

  test("a song wins over a linked highlight's book", () => {
    const book = s.book({ title: "Real Book", author: "Someone" });
    const q = s.quote({ text: LYRIC });
    s.highlight({ bookId: book.id, quoteId: q.id, text: LYRIC });
    db.query("UPDATE quotes SET book_id = ? WHERE id = ?").run(book.id, q.id);
    updateQuote(db, q.id, { sourceKind: "song" });
    expect(getQuote(db, q.id)?.bookId).toBeNull();
  });

  test("editing a song's title or artist creates no book", () => {
    const q = s.quote({ text: LYRIC });
    updateQuote(db, q.id, { sourceKind: "song" });
    updateQuote(db, q.id, { sourceTitle: "Northbound Static", author: "Paper Lanterns" });
    expect(getQuote(db, q.id)?.bookId).toBeNull();
    expect(bookCount()).toBe(0);
  });

  test("setting the kind and title in one patch creates no book", () => {
    const q = s.quote({ text: LYRIC });
    updateQuote(db, q.id, { sourceKind: "other", sourceTitle: "A Film" });
    expect(getQuote(db, q.id)).toMatchObject({ sourceKind: "other", bookId: null });
    expect(bookCount()).toBe(0);
  });

  test("switching back to book re-links the book from the source title", () => {
    const q = s.quote({ text: LYRIC, sourceTitle: "The Real Title", author: "An Author" });
    updateQuote(db, q.id, { sourceKind: "song" });
    updateQuote(db, q.id, { sourceKind: "book" });
    const back = getQuote(db, q.id);
    expect(back?.sourceKind).toBe("book");
    expect(back?.bookId).not.toBeNull();
    expect(getBook(db, back?.bookId as number)?.title).toBe("The Real Title");
  });
});

describe("upsertQuote sourceKind", () => {
  test("a song creates no books row", () => {
    const { quote } = upsertQuote(db, {
      text: LYRIC,
      author: "Paper Lanterns",
      sourceTitle: "Northbound Static",
      sourceKind: "song",
      bookSource: "caption",
    });
    expect(quote).toMatchObject({ sourceKind: "song", bookId: null });
    expect(bookCount()).toBe(0);
  });

  test("a song matching an existing quote doesn't give it a book", () => {
    const existing = s.quote({ text: LYRIC });
    const { quote, match } = upsertQuote(db, {
      text: LYRIC,
      sourceTitle: "Northbound Static",
      sourceKind: "song",
      bookSource: "caption",
    });
    expect(match).toBe("existing");
    expect(quote.id).toBe(existing.id);
    expect(quote.bookId).toBeNull();
    expect(bookCount()).toBe(0);
  });
});

describe("searchQuotes kind", () => {
  test("kind=song returns only songs; noBook excludes non-book quotes", () => {
    const book = s.quote({ text: "Book quote without a book" });
    const song = s.quote({ text: LYRIC });
    const other = s.quote({ text: "A line from a film" });
    updateQuote(db, song.id, { sourceKind: "song" });
    updateQuote(db, other.id, { sourceKind: "other" });

    expect(searchAll({ kind: "song" })).toEqual([song.id]);
    expect(searchAll({ kind: "other" })).toEqual([other.id]);
    expect(searchAll({ kind: "book" })).toEqual([book.id]);
    expect(searchAll({ noBook: true })).toEqual([book.id]);
  });
});

describe("backfillBooks", () => {
  test("skips songs", () => {
    const q = s.quote({ text: LYRIC, sourceTitle: "Northbound Static" });
    db.query("UPDATE quotes SET source_kind = 'song' WHERE id = ?").run(q.id);
    backfillBooks(db);
    expect(getQuote(db, q.id)?.bookId).toBeNull();
    expect(bookCount()).toBe(0);
  });
});

describe("resolveLink 'song'", () => {
  test("marks the quote a song, clears its book and confirms the link", () => {
    const { quote } = upsertQuote(db, {
      text: LYRIC,
      sourceTitle: "The Jesus of Nowhere",
      bookSource: "caption",
    });
    const bookId = quote.bookId as number;
    const post = s.post();
    s.link(post.id, quote.id, { status: "needs_review", confidence: 0.5 });
    expect(listReviewLinks(db)[0]?.quote.sourceKind).toBe("book");

    expect(resolveLink(db, post.id, quote.id, "song")).toBe(true);
    expect(getQuote(db, quote.id)).toMatchObject({ sourceKind: "song", bookId: null });
    expect(getBook(db, bookId)).toBeNull();
    expect(listReviewLinks(db)).toEqual([]);
    const status = db
      .query("SELECT status FROM post_quotes WHERE post_id = ? AND quote_id = ?")
      .get(post.id, quote.id) as { status: string };
    expect(status.status).toBe("confirmed");
  });

  test("a missing link changes nothing", () => {
    const q = s.quote({ text: LYRIC });
    expect(resolveLink(db, 999, q.id, "song")).toBe(false);
    expect(getQuote(db, q.id)?.sourceKind).toBe("book");
  });
});

describe("requeuePosts", () => {
  test("clears extracted_at for known posts and reports unknown ids", () => {
    const a = s.post({ igMediaId: "111" });
    const b = s.post({ igMediaId: "222" });
    db.query("UPDATE posts SET extracted_at = '2026-01-01T00:00:00.000Z'").run();
    expect(requeuePosts(db, ["111", "999"])).toEqual({ requeued: ["111"], missing: ["999"] });
    const rows = db.query("SELECT id, extracted_at AS e FROM posts ORDER BY id").all() as {
      id: number;
      e: string | null;
    }[];
    expect(rows).toEqual([
      { id: a.id, e: null },
      { id: b.id, e: "2026-01-01T00:00:00.000Z" },
    ]);
  });
});

describe("mergeQuotes kind", () => {
  test("a bare kept quote takes a dropped song's kind with its artist and title", () => {
    const keep = s.quote({ text: LYRIC });
    const drop = s.quote({ text: `${LYRIC} again`, author: "Paper Lanterns", sourceTitle: "Song" });
    updateQuote(db, drop.id, { sourceKind: "song" });
    mergeQuotes(db, keep.id, drop.id);
    expect(getQuote(db, keep.id)).toMatchObject({
      sourceKind: "song",
      author: "Paper Lanterns",
      bookId: null,
    });
  });

  test("an attributed kept quote keeps its own kind and book", () => {
    const { quote: keep } = upsertQuote(db, { text: LYRIC, sourceTitle: "A Book" });
    const drop = s.quote({ text: `${LYRIC} again` });
    updateQuote(db, drop.id, { sourceKind: "song" });
    mergeQuotes(db, keep.id, drop.id);
    expect(getQuote(db, keep.id)).toMatchObject({ sourceKind: "book", bookId: keep.bookId });
  });
});
