import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { createTestDb } from "../../../test/helpers/db";
import { type Seeder, seed } from "../../../test/helpers/seed";
import { deleteBook, mergeBooks, rekeyBooks, updateBook } from "./book-cleanup";
import { findOrCreateBook, getBook, getBookDetail, listBooks } from "./books";

let db: Database;
let s: Seeder;

beforeEach(() => {
  db = createTestDb();
  s = seed(db);
});

function count(sql: string): number {
  return (db.query(sql).get() as { n: number }).n;
}

function quoteBook(quoteId: number): number | null {
  return (
    db.query(`SELECT book_id FROM quotes WHERE id = ${quoteId}`).get() as {
      book_id: number | null;
    }
  ).book_id;
}

function setBook(quoteId: number, bookId: number) {
  db.run(`UPDATE quotes SET book_id = ${bookId} WHERE id = ${quoteId}`);
}

/** A book row with an explicit (possibly stale) key, as written before a key change. */
function rawBook(title: string, author: string | null, key: string, assetId: string | null = null) {
  const row = db
    .query<{ id: number }, Record<string, string | null>>(
      `INSERT INTO books (asset_id, title, author, normalized_key, source)
       VALUES ($assetId, $title, $author, $key, 'caption') RETURNING id`,
    )
    .get({ assetId, title, author, key });
  if (!row) throw new Error("rawBook");
  return row.id;
}

describe("mergeBooks", () => {
  test("moves every quote and highlight to the kept book and deletes the other", () => {
    const keep = s.book({ assetId: null, title: "1Q84", author: "Haruki Murakami" });
    const drop = s.book({ assetId: null, title: "IQ84", author: "Haruki Murakami" });
    const other = s.book({ assetId: null, title: "Dune", author: "Frank Herbert" });
    const q1 = s.quote({ text: "Keep one" });
    const q2 = s.quote({ text: "Drop one" });
    const q3 = s.quote({ text: "Drop two" });
    const q4 = s.quote({ text: "Fear is the mind-killer" });
    setBook(q1.id, keep.id);
    setBook(q2.id, drop.id);
    setBook(q3.id, drop.id);
    setBook(q4.id, other.id);
    const h1 = s.highlight({ bookId: drop.id, text: "Drop highlight", quoteId: q2.id });
    const h2 = s.highlight({ bookId: drop.id, text: "Loose highlight" });
    const h3 = s.highlight({ bookId: keep.id, text: "Keep highlight" });
    const before = {
      quotes: count("SELECT COUNT(*) AS n FROM quotes"),
      highlights: count("SELECT COUNT(*) AS n FROM highlights"),
    };

    const merged = mergeBooks(db, keep.id, drop.id);

    expect(merged.id).toBe(keep.id);
    expect(merged.title).toBe("1Q84");
    expect(getBook(db, drop.id)).toBeNull();
    expect([q1, q2, q3].map((q) => quoteBook(q.id))).toEqual([keep.id, keep.id, keep.id]);
    expect(quoteBook(q4.id)).toBe(other.id);
    const highlightBooks = db
      .query<{ id: number; bookId: number; quoteId: number | null }, []>(
        "SELECT id, book_id AS bookId, quote_id AS quoteId FROM highlights ORDER BY id",
      )
      .all();
    expect(highlightBooks).toEqual([
      { id: h1.id, bookId: keep.id, quoteId: q2.id },
      { id: h2.id, bookId: keep.id, quoteId: null },
      { id: h3.id, bookId: keep.id, quoteId: null },
    ]);
    // Nothing lost.
    expect(count("SELECT COUNT(*) AS n FROM quotes")).toBe(before.quotes);
    expect(count("SELECT COUNT(*) AS n FROM highlights")).toBe(before.highlights);
    const detail = getBookDetail(db, keep.id);
    expect(detail?.book.quoteCount).toBe(3);
    expect(detail?.entries.filter((e) => e.kind === "highlight")).toHaveLength(2);
  });

  test("fills the kept book's missing author and asset id from the other, re-keying it", () => {
    const keep = s.book({ assetId: null, title: "Sapiens", author: null, source: "caption" });
    const drop = s.book({
      assetId: "SAPIENS-1",
      title: "Sapiens: A Brief History of Humankind",
      author: "Yuval Noah Harari",
    });
    const merged = mergeBooks(db, keep.id, drop.id);
    expect(merged).toEqual({
      id: keep.id,
      assetId: "SAPIENS-1",
      title: "Sapiens",
      author: "Yuval Noah Harari",
      normalizedKey: "sapiens|yuval noah harari",
      source: "caption",
    });
  });

  test("the kept book can take over the dropped book's key", () => {
    const keep = s.book({ assetId: null, title: "Sapiens", author: null });
    const drop = s.book({ assetId: null, title: "Sapiens", author: "Yuval Noah Harari" });
    expect(mergeBooks(db, keep.id, drop.id).normalizedKey).toBe("sapiens|yuval noah harari");
  });

  test("keeps its own author when filling one would collide with a third book", () => {
    const keep = s.book({ assetId: null, title: "Collected Poems", author: null });
    const drop = s.book({ assetId: null, title: "Collected Poems!", author: "W. B. Yeats" });
    // Same title and author as the drop's would give keep: drop's key is free only after the
    // drop is deleted, but this third book already holds it.
    db.run("UPDATE books SET normalized_key = 'collected poems!|w b yeats' WHERE id = ?", [
      drop.id,
    ]);
    const third = s.book({ assetId: null, title: "Collected Poems", author: "W. B. Yeats" });
    const merged = mergeBooks(db, keep.id, drop.id);
    expect(merged.author).toBeNull();
    expect(merged.normalizedKey).toBe("collected poems");
    expect(getBook(db, third.id)).not.toBeNull();
  });

  test("two Apple Books records: the kept asset id stays, the other becomes an alias", () => {
    const keep = s.book({ assetId: "ASSET-A", title: "1Q84", author: "Haruki Murakami" });
    const drop = s.book({ assetId: "ASSET-B", title: "IQ84", author: "Haruki Murakami" });
    const merged = mergeBooks(db, keep.id, drop.id);
    expect(merged.assetId).toBe("ASSET-A");
    // Lookups by the dropped asset id, or by the dropped title, land on the kept book.
    const byAsset = findOrCreateBook(db, {
      title: "IQ84",
      author: "Haruki Murakami",
      assetId: "ASSET-B",
      source: "apple_books",
    });
    expect(byAsset?.id).toBe(keep.id);
    const byKey = findOrCreateBook(db, { title: "iq84", author: "Haruki Murakami" });
    expect(byKey?.id).toBe(keep.id);
    expect(count("SELECT COUNT(*) AS n FROM books")).toBe(1);
  });

  test("aliases of the dropped book follow it to the kept book", () => {
    const a = s.book({ assetId: null, title: "A", author: "X" });
    const b = s.book({ assetId: null, title: "B", author: "X" });
    const c = s.book({ assetId: null, title: "C", author: "X" });
    mergeBooks(db, b.id, a.id);
    mergeBooks(db, c.id, b.id);
    expect(findOrCreateBook(db, { title: "A", author: "X" })?.id).toBe(c.id);
    expect(findOrCreateBook(db, { title: "B", author: "X" })?.id).toBe(c.id);
    expect(count("SELECT COUNT(*) AS n FROM books")).toBe(1);
  });

  test("is atomic: a failure part-way leaves both books as they were", () => {
    const keep = s.book({ assetId: null, title: "Keep", author: null });
    const drop = s.book({ assetId: null, title: "Drop", author: "Someone" });
    const q = s.quote({ text: "On the dropped book" });
    setBook(q.id, drop.id);
    s.highlight({ bookId: drop.id, text: "Also dropped" });
    db.run(`CREATE TRIGGER no_delete BEFORE DELETE ON books
            BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    expect(() => mergeBooks(db, keep.id, drop.id)).toThrow("boom");
    expect(quoteBook(q.id)).toBe(drop.id);
    expect(count(`SELECT COUNT(*) AS n FROM highlights WHERE book_id = ${drop.id}`)).toBe(1);
    expect(getBook(db, keep.id)?.author).toBeNull();
    expect(count("SELECT COUNT(*) AS n FROM book_aliases")).toBe(0);
  });

  test("refuses to merge a book into itself or a missing book", () => {
    const b = s.book({ assetId: null, title: "Dune", author: "Frank Herbert" });
    expect(() => mergeBooks(db, b.id, b.id)).toThrow();
    expect(() => mergeBooks(db, b.id, 999)).toThrow();
    expect(() => mergeBooks(db, 999, b.id)).toThrow();
    expect(getBook(db, b.id)).not.toBeNull();
  });
});

describe("updateBook", () => {
  test("edits title and author and re-keys the book", () => {
    const b = s.book({ assetId: null, title: "Senlin Ascends", author: "Mark Lawrence" });
    const r = updateBook(db, b.id, { author: "Josiah Bancroft" });
    expect(r).toEqual({
      status: "ok",
      book: { ...b, author: "Josiah Bancroft", normalizedKey: "senlin ascends|josiah bancroft" },
    });
    const t = updateBook(db, b.id, { title: "  Senlin Ascends (Books of Babel 1) " });
    expect(t.status === "ok" && t.book.title).toBe("Senlin Ascends (Books of Babel 1)");
  });

  test("a blank or null author clears it", () => {
    const b = s.book({ assetId: null, title: "Dune", author: "Frank Herbert" });
    const r = updateBook(db, b.id, { author: " " });
    expect(r.status === "ok" && r.book).toMatchObject({ author: null, normalizedKey: "dune" });
    const n = updateBook(db, b.id, { author: null });
    expect(n.status).toBe("ok");
  });

  test("reports a collision with another book's key instead of saving", () => {
    const wrong = s.book({ assetId: null, title: "Senlin Ascends", author: "Mark Lawrence" });
    const right = s.book({ assetId: null, title: "Senlin Ascends", author: "Josiah Bancroft" });
    expect(updateBook(db, wrong.id, { author: "josiah  bancroft" })).toEqual({
      status: "conflict",
      conflictId: right.id,
    });
    expect(getBook(db, wrong.id)?.author).toBe("Mark Lawrence");
  });

  test("rejects an empty title and reports a missing book", () => {
    const b = s.book({ assetId: null, title: "Dune", author: "Frank Herbert" });
    expect(updateBook(db, b.id, { title: "  " })).toEqual({ status: "empty_title" });
    expect(updateBook(db, 999, { title: "X" })).toEqual({ status: "not_found" });
  });

  test("a key that was an alias becomes the book's own key", () => {
    const keep = s.book({ assetId: null, title: "1Q84", author: "Haruki Murakami" });
    const drop = s.book({ assetId: null, title: "IQ84", author: "Haruki Murakami" });
    mergeBooks(db, keep.id, drop.id);
    const r = updateBook(db, keep.id, { title: "IQ84" });
    expect(r.status).toBe("ok");
    expect(count("SELECT COUNT(*) AS n FROM book_aliases WHERE kind = 'key'")).toBe(0);
  });
});

describe("deleteBook", () => {
  test("deletes a book with no quotes or highlights", () => {
    const b = s.book({ title: "Empty", author: null });
    expect(deleteBook(db, b.id)).toBe("deleted");
    expect(getBook(db, b.id)).toBeNull();
  });

  test("refuses a book that still has quotes or highlights", () => {
    const withQuote = s.book({ assetId: null, title: "Has quote", author: null });
    const withHighlight = s.book({ title: "Has highlight", author: null });
    setBook(s.quote({ text: "a quote" }).id, withQuote.id);
    s.highlight({ bookId: withHighlight.id, text: "a highlight" });
    expect(deleteBook(db, withQuote.id)).toBe("not_empty");
    expect(deleteBook(db, withHighlight.id)).toBe("not_empty");
    expect(getBook(db, withQuote.id)).not.toBeNull();
    expect(getBook(db, withHighlight.id)).not.toBeNull();
  });

  test("reports a missing book", () => {
    expect(deleteBook(db, 999)).toBe("not_found");
  });
});

describe("rekeyBooks", () => {
  test("recomputes keys (folding &) and reports collisions without merging", () => {
    const amp = rawBook(
      "Daisy Jones & The Six",
      "Taylor Jenkins Reid",
      "daisy jones the six|taylor jenkins reid",
    );
    const and = rawBook(
      "Daisy Jones and the Six",
      "Taylor Jenkins Reid",
      "daisy jones and the six|taylor jenkins reid",
    );
    const salt = rawBook(
      "Salt & Signal",
      "Theo Lindqvist & Ana Ruiz",
      "salt signal|theo lindqvist ana ruiz",
    );
    const fine = rawBook("Dune", "Frank Herbert", "dune|frank herbert");

    const dry = rekeyBooks(db, { dryRun: true });
    expect(dry.rekeyed).toBe(1);
    expect(getBook(db, salt)?.normalizedKey).toBe("salt signal|theo lindqvist ana ruiz");

    const summary = rekeyBooks(db);
    expect(summary).toEqual({
      rekeyed: 1,
      unchanged: 1,
      collisions: [
        {
          key: "daisy jones and the six|taylor jenkins reid",
          books: [
            { id: amp, title: "Daisy Jones & The Six", author: "Taylor Jenkins Reid" },
            { id: and, title: "Daisy Jones and the Six", author: "Taylor Jenkins Reid" },
          ],
        },
      ],
    });
    expect(getBook(db, salt)?.normalizedKey).toBe("salt and signal|theo lindqvist and ana ruiz");
    // Colliding books keep their old keys and both still exist.
    expect(getBook(db, amp)?.normalizedKey).toBe("daisy jones the six|taylor jenkins reid");
    expect(getBook(db, and)?.normalizedKey).toBe("daisy jones and the six|taylor jenkins reid");
    expect(getBook(db, fine)?.normalizedKey).toBe("dune|frank herbert");
    // Idempotent.
    expect(rekeyBooks(db).rekeyed).toBe(0);
  });

  test("handles keys that move onto a key another row is moving off", () => {
    const a = rawBook("A & B", null, "a b");
    const b = rawBook("A B", null, "a and b");
    const summary = rekeyBooks(db);
    expect(summary.collisions).toEqual([]);
    expect(getBook(db, a)?.normalizedKey).toBe("a and b");
    expect(getBook(db, b)?.normalizedKey).toBe("a b");
  });
});

describe("book issues ('needs attention')", () => {
  test("flags books with no author, possible duplicates and series-like titles", () => {
    const noAuthor = s.book({ assetId: null, title: "The Jesus of Suburbia", author: null });
    const a = s.book({ assetId: null, title: "1Q84", author: "Haruki Murakami" });
    const b = s.book({ assetId: null, title: "IQ84", author: "Haruki Murakami" });
    const series = s.book({ assetId: null, title: "The Wheel of Time", author: "Robert Jordan" });
    const ok = s.book({ assetId: null, title: "Dune", author: "Frank Herbert" });

    const issues = new Map(listBooks(db, { sort: "title" }).map((x) => [x.id, x.issues]));
    expect(issues.get(noAuthor.id)).toEqual(["no_author"]);
    expect(issues.get(a.id)).toEqual(["possible_duplicate"]);
    expect(issues.get(b.id)).toEqual(["possible_duplicate"]);
    expect(issues.get(series.id)).toEqual(["series_title"]);
    expect(issues.get(ok.id)).toEqual([]);

    const attention = listBooks(db, { sort: "title", attention: true }).map((x) => x.id);
    expect(attention.sort()).toEqual([noAuthor.id, a.id, b.id, series.id].sort());
  });

  test("the book detail lists possible duplicates, best first", () => {
    const keep = s.book({ assetId: null, title: "Sapiens", author: "Yuval Noah Harari" });
    const longer = s.book({
      assetId: null,
      title: "Sapiens: A Brief History of Humankind",
      author: "Yuval Noah Harari",
    });
    const same = s.book({ assetId: null, title: "Sapiens", author: null });
    s.book({ assetId: null, title: "Dune", author: "Frank Herbert" });
    setBook(s.quote({ text: "one" }).id, longer.id);
    const detail = getBookDetail(db, keep.id);
    expect(detail?.possibleDuplicates).toEqual([
      { id: same.id, title: "Sapiens", author: null, quoteCount: 0, score: 1 },
      {
        id: longer.id,
        title: "Sapiens: A Brief History of Humankind",
        author: "Yuval Noah Harari",
        quoteCount: 1,
        score: expect.any(Number),
      },
    ]);
  });
});
