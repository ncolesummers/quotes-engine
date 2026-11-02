import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANNOTATION_DB, LIBRARY_DB } from "../../../test/fixtures/apple-books/build";
import { createTestDb } from "../../../test/helpers/db";
import { seed } from "../../../test/helpers/seed";
import { type Book, findOrCreateBook } from "../../server/repos/books";
import { normalizeQuote } from "../../server/text/normalize";
import { classifyMatch, normalizedSimilarity } from "../../server/text/similarity";
import { formatImportSummary, importAppleBooks, matchQuote, primaryAuthor } from "./import";
import { type AppleBooksData, type AppleHighlight, readAppleBooks } from "./read";

const FIXTURES = join(import.meta.dir, "../../../test/fixtures/apple-books");

const LANTERN = { assetId: "ASSET-LANTERN", title: "The Lantern Keeper", author: "Mira Okafor" };
const SALT = {
  assetId: "ASSET-SALT",
  title: "Salt and Signal",
  author: "Theo Lindqvist & Ana Ruiz",
};

const LAMP = "A lamp left burning is a promise that someone will come home.";
const OIL = "Every keeper learns that the dark is patient, but so is oil.";
const SEA = "The sea keeps no records, only rumors of the shore.";

function hl(uuid: string, assetId: string, text: string, extra: Partial<AppleHighlight> = {}) {
  return {
    annotationUuid: uuid,
    assetId,
    text,
    note: null,
    location: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    ...extra,
  };
}

function data(highlights: AppleHighlight[], books = [LANTERN, SALT]): AppleBooksData {
  return { books: books.map((b) => ({ ...b, state: 1 })), highlights };
}

const BASIC = data([
  hl("u1", LANTERN.assetId, LAMP),
  hl("u2", LANTERN.assetId, OIL),
  hl("u3", SALT.assetId, SEA),
]);

interface Row {
  annotationUuid: string;
  bookId: number;
  text: string;
  note: string | null;
  location: string | null;
  createdAt: string | null;
  quoteId: number | null;
}

let db: Database;
beforeEach(() => {
  db = createTestDb();
});
afterEach(() => {
  db.close();
});

function highlightRows(): Row[] {
  return db
    .query<Row, []>(
      `SELECT annotation_uuid AS annotationUuid, book_id AS bookId, text, note, location,
         created_at AS createdAt, quote_id AS quoteId FROM highlights ORDER BY annotation_uuid`,
    )
    .all();
}

function books(): Book[] {
  return db
    .query<Book, []>(
      `SELECT id, asset_id AS assetId, title, author, normalized_key AS normalizedKey, source
       FROM books ORDER BY id`,
    )
    .all();
}

function quoteIdOf(uuid: string): number | null {
  return highlightRows().find((h) => h.annotationUuid === uuid)?.quoteId ?? null;
}

describe("importAppleBooks", () => {
  test("creates Apple Books records and their highlights", () => {
    const summary = importAppleBooks(db, BASIC);

    expect(summary.books).toEqual({ created: 2, merged: 0, existing: 0 });
    expect(summary.highlights).toEqual({ new: 3, updated: 0, unchanged: 0, skipped: 0 });
    expect(books()).toMatchObject([
      {
        assetId: LANTERN.assetId,
        title: LANTERN.title,
        author: LANTERN.author,
        source: "apple_books",
      },
      { assetId: SALT.assetId, title: SALT.title, source: "apple_books" },
    ]);
    const [lantern, salt] = books().map((b) => b.id);
    expect(highlightRows().map((h) => [h.annotationUuid, h.bookId, h.text])).toEqual([
      ["u1", lantern ?? -1, LAMP],
      ["u2", lantern ?? -1, OIL],
      ["u3", salt ?? -1, SEA],
    ]);
  });

  test("imports the fixture library end to end", () => {
    const scratch = mkdtempSync(join(tmpdir(), "apple-books-import-"));
    try {
      const fixture = readAppleBooks(
        { annotationDb: join(FIXTURES, ANNOTATION_DB), libraryDb: join(FIXTURES, LIBRARY_DB) },
        { tmpRoot: scratch },
      );
      const summary = importAppleBooks(db, fixture);
      expect(summary.books.created).toBe(3);
      // The orphan's asset isn't in the library.
      expect(summary.highlights).toEqual({ new: 4, updated: 0, unchanged: 0, skipped: 1 });
      expect(highlightRows().find((h) => h.annotationUuid.endsWith("0002"))).toMatchObject({
        note: "keeper motif",
        location: "epubcfi(/6/10[ch03]!/4/2,/1:0,/1:59)",
        createdAt: "2023-03-08T20:26:40.500Z",
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("re-running the import is idempotent", () => {
    importAppleBooks(db, BASIC);
    const booksBefore = books();
    const rowsBefore = highlightRows();

    const again = importAppleBooks(db, BASIC);

    expect(again.books).toEqual({ created: 0, merged: 0, existing: 2 });
    expect(again.highlights).toEqual({ new: 0, updated: 0, unchanged: 3, skipped: 0 });
    expect(again.linked).toEqual({ exact: 0, contained: 0, same: 0, likely: 0 });
    expect(books()).toEqual(booksBefore);
    expect(highlightRows()).toEqual(rowsBefore);
  });

  test("edits to a highlight's text or note update its row", () => {
    importAppleBooks(db, BASIC);
    const edited = data([
      hl("u1", LANTERN.assetId, `${LAMP} Always.`),
      hl("u2", LANTERN.assetId, OIL, { note: "added later" }),
      hl("u3", SALT.assetId, SEA),
    ]);

    const summary = importAppleBooks(db, edited);

    expect(summary.highlights).toEqual({ new: 0, updated: 2, unchanged: 1, skipped: 0 });
    expect(highlightRows().map((h) => [h.text, h.note])).toEqual([
      [`${LAMP} Always.`, null],
      [OIL, "added later"],
      [SEA, null],
    ]);
  });

  test("merges with a caption book of the same title and author", () => {
    const caption = findOrCreateBook(db, {
      title: "the lantern keeper",
      author: "Mira Okafor",
      source: "caption",
    });

    const summary = importAppleBooks(db, BASIC);

    expect(summary.books).toEqual({ created: 1, merged: 1, existing: 0 });
    expect(books()).toHaveLength(2);
    expect(books()[0]).toMatchObject({
      id: caption?.id,
      assetId: LANTERN.assetId,
      source: "caption",
    });
    expect(highlightRows()[0]?.bookId).toBe(caption?.id as number);

    expect(importAppleBooks(db, BASIC).books).toEqual({ created: 0, merged: 0, existing: 2 });
  });

  test("merges a multi-author book with a caption book credited to the first author", () => {
    const caption = findOrCreateBook(db, {
      title: "Salt and Signal",
      author: "Theo Lindqvist",
      source: "caption",
    });

    const summary = importAppleBooks(db, BASIC);

    expect(summary.books.merged).toBe(1);
    expect(books().find((b) => b.id === caption?.id)?.assetId).toBe(SALT.assetId);
    expect(highlightRows()[2]?.bookId).toBe(caption?.id as number);
  });

  test("merges with a caption book known only by its title", () => {
    const caption = findOrCreateBook(db, { title: "The Lantern Keeper", source: "caption" });

    importAppleBooks(db, BASIC);

    expect(books().find((b) => b.id === caption?.id)).toMatchObject({
      assetId: LANTERN.assetId,
      author: LANTERN.author,
    });
  });

  test("two Apple Books assets of the same title and author share one book", () => {
    const copy = { ...LANTERN, assetId: "ASSET-LANTERN-2" };
    const summary = importAppleBooks(
      db,
      data([hl("u1", LANTERN.assetId, LAMP), hl("u9", copy.assetId, OIL)], [LANTERN, copy]),
    );

    expect(books()).toHaveLength(1);
    expect(summary.books).toEqual({ created: 1, merged: 0, existing: 1 });
    expect(new Set(highlightRows().map((h) => h.bookId)).size).toBe(1);
  });

  test("skips highlights whose book isn't in the library", () => {
    const summary = importAppleBooks(db, data([hl("u1", "ASSET-GONE", LAMP)]));
    expect(summary.highlights.skipped).toBe(1);
    expect(highlightRows()).toEqual([]);
  });
});

describe("linking highlights to quotes", () => {
  test("a highlight matching a quote's normalized text is linked, whatever its book", () => {
    const s = seed(db);
    const q = s.quote({ text: "“A lamp left burning is a promise that someone will come home”" });

    const summary = importAppleBooks(db, BASIC);

    expect(quoteIdOf("u1")).toBe(q.id);
    expect(summary.linked).toEqual({ exact: 1, contained: 0, same: 0, likely: 0 });
    expect(quoteIdOf("u2")).toBeNull();
  });

  test("a quote contained in a longer highlight from its book is linked", () => {
    const book = findOrCreateBook(db, { ...LANTERN, assetId: null, source: "caption" });
    const s = seed(db);
    const q = s.quote({ text: "The dark is patient, but so is oil." });
    db.query("UPDATE quotes SET book_id = $b WHERE id = $q").run({ b: book?.id ?? 0, q: q.id });

    const summary = importAppleBooks(db, BASIC);

    expect(quoteIdOf("u2")).toBe(q.id);
    expect(summary.linked.contained).toBe(1);
  });

  test("a highlight contained in a longer quote from its book is linked", () => {
    const book = findOrCreateBook(db, { ...SALT, assetId: null, source: "caption" });
    const s = seed(db);
    const q = s.quote({ text: `${SEA} And the shore forgets the sea.` });
    db.query("UPDATE quotes SET book_id = $b WHERE id = $q").run({ b: book?.id ?? 0, q: q.id });

    importAppleBooks(db, BASIC);

    expect(quoteIdOf("u3")).toBe(q.id);
  });

  test("an OCR'd near-copy of a highlight in the same book is linked", () => {
    const book = findOrCreateBook(db, { ...LANTERN, assetId: null, source: "caption" });
    const s = seed(db);
    const ocr = "Every keeper leams that the dark is patient, but so is oil.";
    const q = s.quote({ text: ocr });
    db.query("UPDATE quotes SET book_id = $b WHERE id = $q").run({ b: book?.id ?? 0, q: q.id });
    const score = normalizedSimilarity(normalizeQuote(OIL), normalizeQuote(ocr));
    expect(classifyMatch(score)).toBe("likely");

    const summary = importAppleBooks(db, BASIC);

    expect(quoteIdOf("u2")).toBe(q.id);
    expect(summary.linked.likely).toBe(1);
  });

  test("fuzzy and containment matches don't cross books", () => {
    const s = seed(db);
    s.quote({ text: "Every keeper leams that the dark is patient, but so is oil." });
    s.quote({ text: "The dark is patient, but so is oil." });

    importAppleBooks(db, BASIC);

    expect(quoteIdOf("u2")).toBeNull();
  });

  test("an existing link is kept on re-import", () => {
    const s = seed(db);
    const q = s.quote({ text: "Something the user linked by hand." });
    importAppleBooks(db, BASIC);
    db.query("UPDATE highlights SET quote_id = $q WHERE annotation_uuid = 'u1'").run({ q: q.id });

    const summary = importAppleBooks(db, BASIC);

    expect(quoteIdOf("u1")).toBe(q.id);
    expect(summary.highlights.unchanged).toBe(3);
  });
});

describe("matchQuote", () => {
  const candidates = [
    { id: 1, normalizedText: normalizeQuote("The dark is patient") },
    { id: 2, normalizedText: normalizeQuote("so is oil") },
    {
      id: 3,
      normalizedText: normalizeQuote(
        "Every keeper learns that the dark is patient, but so is oyl.",
      ),
    },
  ];

  test("prefers containment over a fuzzy score", () => {
    expect(matchQuote(normalizeQuote(OIL), candidates)).toEqual({
      quoteId: 1,
      method: "contained",
    });
  });

  test("ignores contained text shorter than four words", () => {
    expect(matchQuote(normalizeQuote(OIL), candidates.slice(1, 2))).toBeNull();
  });

  test("matches whole words only", () => {
    const cands = [{ id: 7, normalizedText: "the dark is patient" }];
    expect(matchQuote("under the dark is patiently waiting for us", cands)).toBeNull();
  });

  test("falls back to the best fuzzy score", () => {
    expect(matchQuote(normalizeQuote(OIL), candidates.slice(2))).toMatchObject({
      quoteId: 3,
    });
  });

  test("an OCR'd excerpt of a longer highlight is a likely match", () => {
    const highlight = normalizeQuote(
      "The tide said nothing, the harbor master said, and then the tide took the whole pier.",
    );
    const excerpt = normalizeQuote("The tide said nothing and then the tlde took the whole pier");
    expect(classifyMatch(normalizedSimilarity(highlight, excerpt))).toBe("different");
    expect(matchQuote(highlight, [{ id: 9, normalizedText: excerpt }])).toEqual({
      quoteId: 9,
      method: "likely",
    });
  });

  test("a short fuzzy excerpt isn't enough", () => {
    const highlight = normalizeQuote(
      "The tide said nothing, and then the tide took the whole pier.",
    );
    expect(matchQuote(highlight, [{ id: 9, normalizedText: "the tlde took" }])).toBeNull();
  });

  test("text that merely shares words with a highlight doesn't match", () => {
    const highlight = normalizeQuote(OIL);
    const other = normalizeQuote(
      "Every keeper of the dark learns patience, and so does the oil seller.",
    );
    expect(matchQuote(highlight, [{ id: 9, normalizedText: other }])).toBeNull();
  });

  test("returns null for unrelated text", () => {
    expect(matchQuote(normalizeQuote(SEA), candidates)).toBeNull();
  });
});

describe("primaryAuthor", () => {
  test("takes the first of several credited authors", () => {
    expect(primaryAuthor("Theo Lindqvist & Ana Ruiz")).toBe("Theo Lindqvist");
    expect(primaryAuthor("A. One, B. Two & C. Three")).toBe("A. One");
    expect(primaryAuthor("Neil Gaiman and Terry Pratchett")).toBe("Neil Gaiman");
  });

  test("returns a single author unchanged, and null for none", () => {
    expect(primaryAuthor("Mira Okafor")).toBe("Mira Okafor");
    expect(primaryAuthor(null)).toBeNull();
  });
});

describe("formatImportSummary", () => {
  test("prints book, highlight and link counts", () => {
    expect(
      formatImportSummary({
        books: { created: 2, merged: 1, existing: 4 },
        highlights: { new: 10, updated: 1, unchanged: 5, skipped: 0 },
        linked: { exact: 3, contained: 2, same: 0, likely: 1 },
      }),
    ).toBe(
      [
        "Books: 2 created, 1 merged with existing books, 4 already known",
        "Highlights: 10 new, 1 updated, 5 unchanged, 0 skipped (book not in library)",
        "Linked to quotes: 6 (3 exact, 2 contained, 0 same, 1 likely)",
      ].join("\n"),
    );
  });
});
