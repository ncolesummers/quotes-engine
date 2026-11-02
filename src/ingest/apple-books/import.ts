import type { Database } from "bun:sqlite";
import { resolveBook } from "../../server/repos/books";
import { bookKey } from "../../server/text/book-key";
import { normalizeQuote } from "../../server/text/normalize";
import {
  classifyMatch,
  LIKELY_THRESHOLD,
  normalizedSimilarity,
  trigrams,
} from "../../server/text/similarity";
import type { AppleBook, AppleBooksData, AppleHighlight } from "./read";

/** How a highlight was linked to a quote. */
export type HighlightLinkMethod = "exact" | "contained" | "same" | "likely";

export interface ImportBooksSummary {
  books: {
    /** New Apple Books records. */
    created: number;
    /** Existing caption/manual books that gained this Apple Books asset id. */
    merged: number;
    /** Already known: by asset id, or as another asset of the same title and author. */
    existing: number;
  };
  highlights: {
    new: number;
    /** Text, note, location, date or book changed. */
    updated: number;
    unchanged: number;
    /** The highlight's book isn't in the library (or has no title). */
    skipped: number;
  };
  /** Highlights linked to a quote by this run, by method. */
  linked: Record<HighlightLinkMethod, number>;
}

export interface QuoteCandidate {
  id: number;
  normalizedText: string;
}

export interface QuoteMatch {
  quoteId: number;
  method: Exclude<HighlightLinkMethod, "exact">;
}

/** The shorter side of a containment match needs this many words, so "so it goes" can't link. */
const MIN_CONTAINED_WORDS = 4;

function wordCount(s: string): number {
  return s ? s.split(" ").length : 0;
}

/** Whether normalized `inner` appears in normalized `outer` on word boundaries. */
function containsWords(outer: string, inner: string): boolean {
  return wordCount(inner) >= MIN_CONTAINED_WORDS && ` ${outer} `.includes(` ${inner} `);
}

/** A fuzzy excerpt (see `fuzzyContainment`) needs this many words on its shorter side. */
const MIN_FUZZY_CONTAINED_WORDS = 6;

/**
 * Share of the shorter string's trigrams found in the longer one: high when an OCR'd quote
 * is a slightly garbled or trimmed excerpt of a longer highlight, which Jaccard (diluted by
 * the rest of the highlight) misses. 0 when the shorter side is too short to be telling.
 */
function fuzzyContainment(a: string, b: string): number {
  const [inner, outer] = a.length <= b.length ? [a, b] : [b, a];
  if (wordCount(inner) < MIN_FUZZY_CONTAINED_WORDS) return 0;
  const innerGrams = trigrams(inner);
  const outerGrams = trigrams(outer);
  let shared = 0;
  for (const g of innerGrams) if (outerGrams.has(g)) shared++;
  return shared / innerGrams.size;
}

const MATCH_RANK = { same: 2, likely: 1, different: 0 } as const;

/**
 * The quote (from the highlight's book) that normalized highlight text `highlight` most
 * likely is: one contained in it or containing it (a posted quote is often an excerpt of a
 * longer highlight), else the best fuzzy match. Posted quotes are OCR'd, so a Jaccard score
 * of `same`/`likely`, or a fuzzy excerpt (`fuzzyContainment` at the `likely` threshold, which
 * counts as `likely`), also matches.
 */
export function matchQuote(highlight: string, candidates: QuoteCandidate[]): QuoteMatch | null {
  if (!highlight) return null;
  let contained: QuoteCandidate | null = null;
  for (const c of candidates) {
    if (containsWords(highlight, c.normalizedText) || containsWords(c.normalizedText, highlight)) {
      if (!contained || c.normalizedText.length > contained.normalizedText.length) contained = c;
    }
  }
  if (contained) return { quoteId: contained.id, method: "contained" };

  let best: { id: number; match: "same" | "likely"; score: number } | null = null;
  for (const c of candidates) {
    let score = normalizedSimilarity(highlight, c.normalizedText);
    let match = classifyMatch(score);
    if (match === "different") {
      score = fuzzyContainment(highlight, c.normalizedText);
      if (score < LIKELY_THRESHOLD) continue;
      match = "likely";
    }
    const better =
      !best ||
      MATCH_RANK[match] > MATCH_RANK[best.match] ||
      (match === best.match && score > best.score);
    if (better) best = { id: c.id, match, score };
  }
  return best && { quoteId: best.id, method: best.match };
}

/** The first of several credited authors ("A, B & C", "A and B"), else `author` itself. */
export function primaryAuthor(author: string | null): string | null {
  if (!author) return null;
  return author.split(/\s*(?:,|&|\band\b)\s*/)[0]?.trim() || author;
}

type BookOutcome = keyof ImportBooksSummary["books"];

function keyExists(db: Database, key: string | null): boolean {
  if (!key) return false;
  return !!db.query("SELECT 1 FROM books WHERE normalized_key = $key").get({ key });
}

/** The `books` row for an Apple Books asset, merged with caption books where possible. */
function importBook(db: Database, b: AppleBook): { id: number; outcome: BookOutcome } | null {
  const known = db
    .query<{ id: number }, { assetId: string }>("SELECT id FROM books WHERE asset_id = $assetId")
    .get({ assetId: b.assetId });
  if (known) return { id: known.id, outcome: "existing" };
  if (!b.title?.trim()) return null;

  // Captions usually credit only the first of several authors.
  const first = primaryAuthor(b.author);
  const author =
    first !== b.author &&
    !keyExists(db, bookKey(b.title, b.author)) &&
    keyExists(db, bookKey(b.title, first))
      ? first
      : b.author;

  const resolved = resolveBook(db, {
    title: b.title,
    author,
    source: "apple_books",
    assetId: b.assetId,
  });
  if (!resolved) return null;
  const { book, created } = resolved;
  const outcome = created ? "created" : book.assetId === b.assetId ? "merged" : "existing";
  return { id: book.id, outcome };
}

interface StoredHighlight {
  id: number;
  bookId: number;
  text: string | null;
  note: string | null;
  location: string | null;
  createdAt: string | null;
  quoteId: number | null;
}

function quoteCandidatesByBook(db: Database): Map<number, QuoteCandidate[]> {
  const byBook = new Map<number, QuoteCandidate[]>();
  const rows = db
    .query<QuoteCandidate & { bookId: number }, []>(
      `SELECT id, normalized_text AS normalizedText, book_id AS bookId FROM quotes
       WHERE book_id IS NOT NULL ORDER BY id`,
    )
    .all();
  for (const { bookId, ...c } of rows) {
    const list = byBook.get(bookId) ?? [];
    list.push(c);
    byBook.set(bookId, list);
  }
  return byBook;
}

/**
 * Upserts Apple Books records by asset id and highlights by annotation uuid, then links each
 * highlight without a quote to the quote it matches (see `matchQuote`; an exact normalized
 * match links across books). Existing links are kept. Idempotent.
 */
export function importAppleBooks(db: Database, data: AppleBooksData): ImportBooksSummary {
  return db.transaction((): ImportBooksSummary => {
    const summary: ImportBooksSummary = {
      books: { created: 0, merged: 0, existing: 0 },
      highlights: { new: 0, updated: 0, unchanged: 0, skipped: 0 },
      linked: { exact: 0, contained: 0, same: 0, likely: 0 },
    };

    const bookIds = new Map<string, number>();
    for (const b of data.books) {
      if (bookIds.has(b.assetId)) continue;
      const imported = importBook(db, b);
      if (!imported) continue;
      bookIds.set(b.assetId, imported.id);
      summary.books[imported.outcome]++;
    }

    const candidates = quoteCandidatesByBook(db);
    const findStored = db.query<StoredHighlight, { uuid: string }>(
      `SELECT id, book_id AS bookId, text, note, location, created_at AS createdAt,
         quote_id AS quoteId
       FROM highlights WHERE annotation_uuid = $uuid`,
    );
    const insert = db.query<{ id: number }, Record<string, string | number | null>>(
      `INSERT INTO highlights (annotation_uuid, book_id, text, note, location, created_at)
       VALUES ($uuid, $bookId, $text, $note, $location, $createdAt) RETURNING id`,
    );
    const update = db.query(
      `UPDATE highlights SET book_id = $bookId, text = $text, note = $note,
         location = $location, created_at = $createdAt
       WHERE id = $id`,
    );
    const exactQuote = db.query<{ id: number }, { normalized: string }>(
      "SELECT id FROM quotes WHERE normalized_text = $normalized",
    );
    const setQuote = db.query("UPDATE highlights SET quote_id = $quoteId WHERE id = $id");

    const link = (id: number, h: AppleHighlight, bookId: number) => {
      const normalized = normalizeQuote(h.text);
      if (!normalized) return;
      const exact = exactQuote.get({ normalized });
      const match = exact
        ? { quoteId: exact.id, method: "exact" as const }
        : matchQuote(normalized, candidates.get(bookId) ?? []);
      if (!match) return;
      setQuote.run({ quoteId: match.quoteId, id });
      summary.linked[match.method]++;
    };

    for (const h of data.highlights) {
      const bookId = bookIds.get(h.assetId);
      if (bookId === undefined) {
        summary.highlights.skipped++;
        continue;
      }
      const fields = {
        bookId,
        text: h.text,
        note: h.note,
        location: h.location,
        createdAt: h.createdAt,
      };
      const stored = findStored.get({ uuid: h.annotationUuid });
      if (!stored) {
        const row = insert.get({ uuid: h.annotationUuid, ...fields });
        if (!row) throw new Error("Highlight insert returned no row");
        summary.highlights.new++;
        link(row.id, h, bookId);
        continue;
      }
      const changed = (Object.keys(fields) as (keyof typeof fields)[]).some(
        (k) => stored[k] !== fields[k],
      );
      if (changed) {
        update.run({ id: stored.id, ...fields });
        summary.highlights.updated++;
      } else {
        summary.highlights.unchanged++;
      }
      if (stored.quoteId === null) link(stored.id, h, bookId);
    }

    return summary;
  })();
}

export function formatImportSummary({ books, highlights, linked }: ImportBooksSummary): string {
  const totalLinked = linked.exact + linked.contained + linked.same + linked.likely;
  return [
    `Books: ${books.created} created, ${books.merged} merged with existing books, ${books.existing} already known`,
    `Highlights: ${highlights.new} new, ${highlights.updated} updated, ${highlights.unchanged} unchanged, ${highlights.skipped} skipped (book not in library)`,
    `Linked to quotes: ${totalLinked} (${linked.exact} exact, ${linked.contained} contained, ${linked.same} same, ${linked.likely} likely)`,
  ].join("\n");
}
