import type { QuoteSearchParams, QuoteSort } from "@/api";
import type { ParamPatch } from "@/hooks/use-search-param-state";

/**
 * Search-page filters as they live in the URL (#14):
 *
 * `?sort=likes|comments|postings` (absent = recent), `?author=<name>`, `?book=<book id>`,
 * `?posted=yes|no`, `?reposted=1` (two or more postings) and `?nobook=1`.
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
  return {
    sort: SORTS.some((s) => s.value === sort) ? (sort as QuoteSort) : DEFAULT_SORT,
    author: author ? author : null,
    bookId: /^[1-9]\d*$/.test(book) ? Number(book) : null,
    posted: posted === "yes" || posted === "no" ? posted : "any",
    reposted: params.get("reposted") === "1",
    noBook: params.get("nobook") === "1",
  };
}

/** The `/api/quotes` params for `filters` (q, limit and offset are added by the caller). */
export function toQuoteSearchParams(
  f: QuoteFilters,
): Pick<QuoteSearchParams, "sort" | "author" | "bookId" | "posted" | "minPostings" | "noBook"> {
  return {
    sort: f.sort,
    ...(f.author !== null && { author: f.author }),
    ...(f.bookId !== null && { bookId: f.bookId }),
    ...(f.posted !== "any" && { posted: f.posted }),
    ...(f.reposted && { minPostings: REPOSTED_MIN_POSTINGS }),
    noBook: f.noBook,
  };
}

/**
 * The URL change for setting some filters. Contradictory pairs exclude each other: a picked
 * book turns off "No book" (and vice versa), "Reposted only" turns off "Never posted".
 */
export function filterPatch(change: Partial<QuoteFilters>): ParamPatch {
  const patch: ParamPatch = {};
  if ("sort" in change) patch.sort = change.sort === DEFAULT_SORT ? null : change.sort;
  if ("author" in change) patch.author = change.author;
  if ("bookId" in change) {
    patch.book = change.bookId == null ? null : String(change.bookId);
    if (change.bookId != null) patch.nobook = null;
  }
  if ("noBook" in change) {
    patch.nobook = change.noBook ? "1" : null;
    if (change.noBook) patch.book = null;
  }
  if ("posted" in change) {
    patch.posted = change.posted === "any" ? null : change.posted;
    if (change.posted === "no") patch.reposted = null;
  }
  if ("reposted" in change) {
    patch.reposted = change.reposted ? "1" : null;
    if (change.reposted) patch.posted = null;
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
};

export function activeFilterCount(f: QuoteFilters): number {
  return [f.author !== null, f.bookId !== null, f.posted !== "any", f.reposted, f.noBook].filter(
    Boolean,
  ).length;
}
