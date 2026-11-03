import type { QuoteSearchParams, QuoteSort, SourceKind } from "@/api";
import type { ParamPatch } from "@/hooks/use-search-param-state";
import { parseSourceKind } from "@/lib/source-kind";

/**
 * Search-page filters as they live in the URL (#14):
 *
 * `?sort=likes|comments|postings` (absent = recent), `?author=<name>`, `?book=<book id>`,
 * `?posted=yes|no`, `?reposted=1` (two or more postings), `?nobook=1` and `?kind=book|song|other`.
 *
 * Unknown values read as the default, so a hand-edited URL never breaks the page.
 */
export type PostedFilter = "any" | "yes" | "no";

export interface QuoteFilters {
  sort: QuoteSort;
  author: string | null;
  bookId: number | null;
  posted: PostedFilter;
  reposted: boolean;
  noBook: boolean;
  /** Only quotes of this kind (#42); null = any. */
  kind: SourceKind | null;
}

export const SORTS: { value: QuoteSort; label: string }[] = [
  { value: "recent", label: "Most recent" },
  { value: "likes", label: "Most likes" },
  { value: "comments", label: "Most comments" },
  { value: "postings", label: "Most postings" },
];

export const DEFAULT_SORT: QuoteSort = "recent";

/** Postings that count as "reposted". */
export const REPOSTED_MIN_POSTINGS = 2;

export function parseQuoteFilters(params: URLSearchParams): QuoteFilters {
  const sort = params.get("sort");
  const posted = params.get("posted");
  const book = params.get("book") ?? "";
  const author = params.get("author")?.trim();
  const bookId = /^[1-9]\d*$/.test(book) ? Number(book) : null;
  const reposted = params.get("reposted") === "1";
  const kind = parseSourceKind(params.get("kind"));
  // A hand-edited URL can hold both halves of a pair `filterPatch` keeps apart; the more
  // specific one wins, so the page never asks for an always-empty result.
  return {
    sort: SORTS.some((s) => s.value === sort) ? (sort as QuoteSort) : DEFAULT_SORT,
    author: author ? author : null,
    bookId,
    posted: posted === "yes" || (posted === "no" && !reposted) ? posted : "any",
    reposted,
    // "No book" only means something for books.
    noBook: params.get("nobook") === "1" && bookId === null && (kind ?? "book") === "book",
    kind,
  };
}

/** The `/api/quotes` params for `filters` (q, limit and offset are added by the caller). */
export function toQuoteSearchParams(
  f: QuoteFilters,
): Pick<
  QuoteSearchParams,
  "sort" | "authorExact" | "bookId" | "posted" | "minPostings" | "noBook" | "kind"
> {
  return {
    sort: f.sort,
    // The author comes from the picker (GET /api/authors), so match it whole: a substring
    // match would make "Ken Liu" also pick up "Ken Liu and Others".
    ...(f.author !== null && { authorExact: f.author }),
    ...(f.bookId !== null && { bookId: f.bookId }),
    ...(f.posted !== "any" && { posted: f.posted }),
    ...(f.reposted && { minPostings: REPOSTED_MIN_POSTINGS }),
    noBook: f.noBook,
    ...(f.kind !== null && { kind: f.kind }),
  };
}

/**
 * The URL change for setting some filters. Contradictory pairs exclude each other: a picked
 * book turns off "No book" (and vice versa), "Reposted only" turns off "Never posted", and a
 * song or other kind turns off "No book" and the picked book (which only books have).
 */
export function filterPatch(change: Partial<QuoteFilters>): ParamPatch {
  const patch: ParamPatch = {};
  if ("sort" in change) patch.sort = change.sort === DEFAULT_SORT ? null : change.sort;
  if ("author" in change) patch.author = change.author;
  if ("bookId" in change) {
    patch.book = change.bookId == null ? null : String(change.bookId);
    // A picked book (or "No book") implies a book quote, so it drops a kind filter.
    if (change.bookId != null) {
      patch.nobook = null;
      patch.kind = null;
    }
  }
  if ("noBook" in change) {
    patch.nobook = change.noBook ? "1" : null;
    if (change.noBook) {
      patch.book = null;
      patch.kind = null;
    }
  }
  if ("posted" in change) {
    patch.posted = change.posted === "any" ? null : change.posted;
    if (change.posted === "no") patch.reposted = null;
  }
  if ("reposted" in change) {
    patch.reposted = change.reposted ? "1" : null;
    if (change.reposted) patch.posted = null;
  }
  if ("kind" in change) {
    patch.kind = change.kind ?? null;
    if (change.kind && change.kind !== "book") {
      patch.nobook = null;
      patch.book = null;
    }
  }
  return patch;
}

/** Removes every filter; the search text and sort stay. */
export const CLEAR_FILTERS: ParamPatch = {
  author: null,
  book: null,
  posted: null,
  reposted: null,
  nobook: null,
  kind: null,
};
