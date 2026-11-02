import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { createTestDb } from "../../../test/helpers/db";
import { type Seeder, seed } from "../../../test/helpers/seed";
import { backfillBooks, findOrCreateBook, getBookDetail, listBooks } from "./books";

let db: Database;
let s: Seeder;

beforeEach(() => {
  db = createTestDb();
  s = seed(db);
});

function countBooks(): number {
  return (db.query("SELECT COUNT(*) AS n FROM books").get() as { n: number }).n;
}

function bookIdOf(quoteId: number): number | null {
  const row = db.query(`SELECT book_id FROM quotes WHERE id = ${quoteId}`).get() as {
    book_id: number | null;
  };
  return row.book_id;
}

function setBook(quoteId: number, bookId: number) {
  db.run(`UPDATE quotes SET book_id = ${bookId} WHERE id = ${quoteId}`);
}

describe("findOrCreateBook", () => {
  test("creates a book with its normalized key and source", () => {
    const book = findOrCreateBook(db, {
      title: "  Fool’s Errand ",
      author: "Robin Hobb",
      source: "caption",
    });
    expect(book).toEqual({
      id: expect.any(Number),
      assetId: null,
      title: "Fool’s Errand",
      author: "Robin Hobb",
      normalizedKey: "fool's errand|robin hobb",
      source: "caption",
    });
  });

  test("dedups across curly vs straight quotes and case", () => {
    const a = findOrCreateBook(db, { title: "Fool’s Errand", author: "Robin Hobb" });
    const b = findOrCreateBook(db, { title: "FOOL'S ERRAND", author: "robin hobb" });
    expect(b?.id).toBe(a?.id as number);
    expect(countBooks()).toBe(1);
  });

  test("returns null for an empty title", () => {
    expect(findOrCreateBook(db, { title: "  ", author: "X" })).toBeNull();
    expect(countBooks()).toBe(0);
  });

  test("a title-only lookup reuses the single authored book with that title", () => {
    const authored = findOrCreateBook(db, { title: "Fool's Errand", author: "Robin Hobb" });
    const bare = findOrCreateBook(db, { title: "Fool’s errand" });
    expect(bare?.id).toBe(authored?.id as number);
    expect(countBooks()).toBe(1);
  });

  test("a title-only lookup creates a separate book when the title is ambiguous", () => {
    findOrCreateBook(db, { title: "Collected Poems", author: "W. B. Yeats" });
    findOrCreateBook(db, { title: "Collected Poems", author: "Sylvia Plath" });
    const bare = findOrCreateBook(db, { title: "Collected Poems" });
    expect(bare?.normalizedKey).toBe("collected poems");
    expect(countBooks()).toBe(3);
    expect(findOrCreateBook(db, { title: "collected poems" })?.id).toBe(bare?.id as number);
  });

  test("an authored lookup adopts a title-only book and fills in its author", () => {
    const bare = findOrCreateBook(db, { title: "Assassin's Apprentice" });
    const authored = findOrCreateBook(db, {
      title: "Assassin’s Apprentice",
      author: "Robin Hobb",
    });
    expect(authored?.id).toBe(bare?.id as number);
    expect(authored?.author).toBe("Robin Hobb");
    expect(authored?.normalizedKey).toBe("assassin's apprentice|robin hobb");
    expect(countBooks()).toBe(1);
  });

  test("merges with an Apple Books record and keeps its asset_id", () => {
    const apple = s.book({ assetId: "ABC", title: "Meditations", author: "Marcus Aurelius" });
    const found = findOrCreateBook(db, {
      title: "meditations",
      author: "Marcus Aurelius",
      source: "caption",
    });
    expect(found?.id).toBe(apple.id);
    expect(found?.assetId).toBe("ABC");
    expect(found?.source).toBe("apple_books");
  });

  test("attaches an asset_id to a caption book when Apple Books reports it", () => {
    const caption = findOrCreateBook(db, { title: "Dune", author: "Frank Herbert" });
    const apple = findOrCreateBook(db, {
      title: "Dune",
      author: "Frank Herbert",
      assetId: "DUNE-1",
      source: "apple_books",
    });
    expect(apple?.id).toBe(caption?.id as number);
    expect(apple?.assetId).toBe("DUNE-1");
    // The same asset under a new title still resolves to the same row.
    const renamed = findOrCreateBook(db, {
      title: "Dune (Deluxe)",
      author: "Frank Herbert",
      assetId: "DUNE-1",
      source: "apple_books",
    });
    expect(renamed?.id).toBe(caption?.id as number);
    expect(countBooks()).toBe(1);
  });
});

describe("findOrCreateBook before the backfill", () => {
  test("reuses an Apple Books record that has no normalized_key yet", () => {
    db.run(
      "INSERT INTO books (id, asset_id, title, author, source) VALUES (5, 'X', 'Dune', 'Frank Herbert', 'apple_books')",
    );
    const book = findOrCreateBook(db, {
      title: "DUNE",
      author: "Frank Herbert",
      source: "caption",
    });
    expect(book?.id).toBe(5);
    expect(book?.normalizedKey).toBe("dune|frank herbert");
    expect(countBooks()).toBe(1);
  });

  test("a title-only lookup reuses an unkeyed Apple Books record", () => {
    db.run(
      "INSERT INTO books (id, asset_id, title, author, source) VALUES (5, 'X', 'Dune', 'Frank Herbert', 'apple_books')",
    );
    expect(findOrCreateBook(db, { title: "Dune", source: "caption" })?.id).toBe(5);
    expect(countBooks()).toBe(1);
  });
});

describe("listBooks", () => {
  function fixture() {
    const hobb = findOrCreateBook(db, { title: "Fool's Errand", author: "Robin Hobb" });
    const dune = findOrCreateBook(db, { title: "Dune", author: "Frank Herbert" });
    if (!hobb || !dune) throw new Error("fixture");
    const q1 = s.quote({ text: "Hobb one" });
    const q2 = s.quote({ text: "Hobb two" });
    const q3 = s.quote({ text: "Hobb three" });
    const q4 = s.quote({ text: "Fear is the mind-killer" });
    for (const q of [q1, q2, q3]) setBook(q.id, hobb.id);
    setBook(q4.id, dune.id);
    s.posting(q1.id, { postedAt: "2026-01-05T00:00:00.000Z" });
    s.posting(q1.id, { postedAt: "2026-03-01T00:00:00.000Z" });
    s.posting(q2.id, { postedAt: "2026-02-01T00:00:00.000Z" });
    s.posting(q4.id, { postedAt: "2026-04-01T00:00:00.000Z" });
    // Dune: one unposted highlight, one linked to the posted quote (not counted).
    s.highlight({ bookId: dune.id, text: "The spice must flow." });
    s.highlight({ bookId: dune.id, text: "Fear is the mind-killer", quoteId: q4.id });
    return { hobb, dune };
  }

  test("counts quotes, posted quotes, unposted highlights and last posted date", () => {
    const { hobb, dune } = fixture();
    const books = listBooks(db, { sort: "title" });
    expect(books).toEqual([
      {
        id: dune.id,
        assetId: null,
        title: "Dune",
        author: "Frank Herbert",
        source: "manual",
        quoteCount: 1,
        postedCount: 1,
        unpostedHighlightCount: 1,
        lastPostedAt: "2026-04-01T00:00:00.000Z",
      },
      {
        id: hobb.id,
        assetId: null,
        title: "Fool's Errand",
        author: "Robin Hobb",
        source: "manual",
        quoteCount: 3,
        postedCount: 2,
        unpostedHighlightCount: 0,
        lastPostedAt: "2026-03-01T00:00:00.000Z",
      },
    ]);
  });

  test("sorts by quotes, posted and recent, and filters by q over title and author", () => {
    const { hobb, dune } = fixture();
    const empty = findOrCreateBook(db, { title: "Unread", author: "Nobody" });
    const ids = (sort: "title" | "quotes" | "posted" | "recent", q?: string) =>
      listBooks(db, { sort, q }).map((b) => b.id);
    expect(ids("quotes")).toEqual([hobb.id, dune.id, empty?.id as number]);
    expect(ids("posted")).toEqual([hobb.id, dune.id, empty?.id as number]);
    expect(ids("recent")).toEqual([dune.id, hobb.id, empty?.id as number]);
    expect(ids("title", "hobb")).toEqual([hobb.id]);
    expect(ids("title", "fool")).toEqual([hobb.id]);
    expect(ids("title", "zzz")).toEqual([]);
  });
});

describe("getBookDetail", () => {
  test("returns null for a missing book", () => {
    expect(getBookDetail(db, 999)).toBeNull();
  });

  test("combines quotes and unposted highlights, with postings and highlight dates", () => {
    const book = s.book({ assetId: "A", title: "Meditations", author: "Marcus Aurelius" });
    const reposted = s.quote({ text: "The obstacle is the way" });
    const unpostedQuote = s.quote({ text: "Waste no more time" });
    setBook(reposted.id, book.id);
    setBook(unpostedQuote.id, book.id);
    const p1 = s.posting(reposted.id, {
      postedAt: "2026-01-01T00:00:00.000Z",
      permalink: "https://ig/p1",
      mediaPath: "p1.jpg",
      likes: 10,
      comments: 1,
    });
    const p2 = s.posting(reposted.id, {
      postedAt: "2026-02-01T00:00:00.000Z",
      permalink: "https://ig/p2",
      mediaPath: null,
      likes: 20,
      comments: 2,
    });
    s.highlight({
      bookId: book.id,
      text: "The obstacle is the way",
      quoteId: reposted.id,
      createdAt: "2025-12-01T00:00:00.000Z",
    });
    const loose = s.highlight({
      bookId: book.id,
      text: "You have power over your mind",
      note: "favorite",
      location: "ch 2",
      createdAt: "2025-11-01T00:00:00.000Z",
    });

    const detail = getBookDetail(db, book.id);
    expect(detail?.book).toEqual({
      id: book.id,
      assetId: "A",
      title: "Meditations",
      author: "Marcus Aurelius",
      source: "apple_books",
      quoteCount: 2,
      postedCount: 1,
      unpostedHighlightCount: 1,
      lastPostedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(detail?.entries).toEqual([
      {
        kind: "quote",
        quoteId: reposted.id,
        highlightId: null,
        text: "The obstacle is the way",
        author: null,
        note: null,
        location: null,
        posted: true,
        highlightedAt: "2025-12-01T00:00:00.000Z",
        postings: [
          {
            postId: p1.id,
            postedAt: "2026-01-01T00:00:00.000Z",
            likes: 10,
            comments: 1,
            permalink: "https://ig/p1",
            mediaPath: "p1.jpg",
          },
          {
            postId: p2.id,
            postedAt: "2026-02-01T00:00:00.000Z",
            likes: 20,
            comments: 2,
            permalink: "https://ig/p2",
            mediaPath: null,
          },
        ],
      },
      {
        kind: "quote",
        quoteId: unpostedQuote.id,
        highlightId: null,
        text: "Waste no more time",
        author: null,
        note: null,
        location: null,
        posted: false,
        highlightedAt: null,
        postings: [],
      },
      {
        kind: "highlight",
        quoteId: null,
        highlightId: loose.id,
        text: "You have power over your mind",
        author: "Marcus Aurelius",
        note: "favorite",
        location: "ch 2",
        posted: false,
        highlightedAt: "2025-11-01T00:00:00.000Z",
        postings: [],
      },
    ]);
  });

  test("a highlight linked to a posted quote of another book is not listed as unposted", () => {
    const book = s.book({ title: "A" });
    const other = s.book({ title: "B" });
    const q = s.quote({ text: "Linked elsewhere" });
    setBook(q.id, other.id);
    s.posting(q.id);
    s.highlight({ bookId: book.id, text: "Linked elsewhere", quoteId: q.id });
    expect(getBookDetail(db, book.id)?.entries).toEqual([]);
  });
});

describe("backfillBooks", () => {
  test("links quotes by source title and author, and is idempotent", () => {
    const a = s.quote({ text: "One", author: "Robin Hobb", sourceTitle: "Fool’s Errand" });
    const b = s.quote({ text: "Two", author: "Robin Hobb", sourceTitle: "Fool's Errand" });
    const c = s.quote({ text: "Three", sourceTitle: "Dune" });
    const none = s.quote({ text: "Four" });

    const first = backfillBooks(db);
    expect(first).toEqual({ booksKeyed: 0, booksCreated: 2, quotesLinked: 3 });
    expect(bookIdOf(a.id)).not.toBeNull();
    expect(bookIdOf(b.id)).toBe(bookIdOf(a.id));
    expect(bookIdOf(c.id)).not.toBeNull();
    expect(bookIdOf(none.id)).toBeNull();

    expect(backfillBooks(db)).toEqual({ booksKeyed: 0, booksCreated: 0, quotesLinked: 0 });
    expect(countBooks()).toBe(2);
  });

  test("keys unkeyed Apple Books records and links quotes through their highlights", () => {
    db.run(
      "INSERT INTO books (id, asset_id, title, author, source) VALUES (5, 'X', 'Dune', 'Frank Herbert', 'apple_books')",
    );
    const viaTitle = s.quote({ text: "Spice", author: "Frank Herbert", sourceTitle: "dune" });
    const viaHighlight = s.quote({ text: "Fear" });
    s.highlight({ bookId: 5, text: "Fear", quoteId: viaHighlight.id });

    expect(backfillBooks(db)).toEqual({ booksKeyed: 1, booksCreated: 0, quotesLinked: 2 });
    expect(bookIdOf(viaTitle.id)).toBe(5);
    expect(bookIdOf(viaHighlight.id)).toBe(5);
    expect(backfillBooks(db)).toEqual({ booksKeyed: 0, booksCreated: 0, quotesLinked: 0 });
  });

  test("prefers a linked highlight's book over a differently worded source title", () => {
    db.run(
      "INSERT INTO books (id, asset_id, title, author, source) VALUES (5, 'X', 'Fool’s Errand', 'Robin Hobb', 'apple_books')",
    );
    const q = s.quote({
      text: "Fear",
      author: "Robin Hobb",
      sourceTitle: "Fool's Errand (The Tawny Man, Book 1)",
    });
    s.highlight({ bookId: 5, text: "Fear", quoteId: q.id });

    expect(backfillBooks(db)).toEqual({ booksKeyed: 1, booksCreated: 0, quotesLinked: 1 });
    expect(bookIdOf(q.id)).toBe(5);
    expect(countBooks()).toBe(1);
  });
});
