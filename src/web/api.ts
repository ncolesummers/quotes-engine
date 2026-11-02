/**
 * Typed fetch helpers for the same-origin JSON API (`src/server/api.ts`).
 *
 * - `apiGet` / `apiSend` are the generic primitives: they parse JSON and turn non-2xx
 *   responses into an `ApiError` carrying the server's `{ error }` message.
 * - `apiSend` always sends `content-type: application/json` (the server's CSRF guard
 *   rejects mutations without it).
 * - Endpoint helpers (`fetchQuotes`, `fetchStats`, ...) sit on top; add new ones here.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Other fields of the `{ error, ... }` body, e.g. `{ conflictId }` on a 409. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type QueryValue = string | number | boolean | null | undefined;

/** `?a=1&b=x` from `params`, skipping null/undefined/"" values; "" when nothing is left. */
export function toQueryString(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const str = search.toString();
  return str ? `?${str}` : "";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body (e.g. a proxy error page); handled below.
  }
  if (!res.ok) {
    const { error, ...details } =
      body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const message =
      typeof error === "string" ? error : `Request failed: ${res.status} ${res.statusText}`.trim();
    throw new ApiError(res.status, message, details);
  }
  return body as T;
}

export function apiGet<T>(path: string, params: Record<string, QueryValue> = {}): Promise<T> {
  return request<T>(path + toQueryString(params), { headers: { accept: "application/json" } });
}

export function apiSend<T>(
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  return request<T>(path, {
    method,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Types mirrored from the server (keep in sync with src/server/repos/*).

export interface Quote {
  id: number;
  text: string;
  normalizedText: string;
  author: string | null;
  sourceTitle: string | null;
  notes: string | null;
  /** The book `sourceTitle` resolved to, or null. */
  bookId: number | null;
  createdAt: string;
  updatedAt: string;
}

/** The slice of a book shown next to a quote. */
export interface BookRef {
  id: number;
  title: string | null;
  author: string | null;
}

export interface QuoteSearchItem extends Quote {
  book: BookRef | null;
  postingCount: number;
  totalLikes: number;
  maxLikes: number | null;
  totalComments: number;
  lastPostedAt: string | null;
}

export type LinkMethod = "caption" | "image" | "manual";
export type LinkStatus = "confirmed" | "needs_review";

/** One Instagram post that carries the quote (`GET /api/quotes/:id`), oldest first. */
export interface Posting {
  postId: number;
  igMediaId: string;
  permalink: string | null;
  mediaPath: string | null;
  /** `/media/<file>` when the post's image was downloaded, else null. */
  mediaUrl: string | null;
  postedAt: string | null;
  likes: number | null;
  comments: number | null;
  method: LinkMethod;
  confidence: number | null;
  status: LinkStatus;
}

export interface QuoteHighlight {
  id: number;
  text: string | null;
  note: string | null;
  location: string | null;
  createdAt: string | null;
  book: { id: number; title: string | null; author: string | null };
}

export interface QuoteDetail {
  quote: Quote;
  book: BookRef | null;
  postings: Posting[];
  highlights: QuoteHighlight[];
}

/** Editable quote fields; null clears author/sourceTitle/notes. */
export interface QuotePatch {
  text?: string;
  author?: string | null;
  sourceTitle?: string | null;
  notes?: string | null;
}

export interface Page<T> {
  items: T[];
  /** Total matches across all pages. */
  total: number;
}

export type QuoteSort = "likes" | "comments" | "recent" | "postings";

export interface QuoteSearchParams {
  q?: string;
  author?: string;
  book?: string;
  posted?: "yes" | "no";
  minPostings?: number;
  sort?: QuoteSort;
  limit?: number;
  offset?: number;
}

export interface Stats {
  quotes: number;
  posts: number;
  repostedQuotes: number;
  highlights: number;
  highlightsBacklog: number;
  needsReview: number;
}

export type BookSource = "apple_books" | "caption" | "manual";
export type BookSort = "title" | "quotes" | "posted" | "recent";

/** One book of `GET /api/books`. */
export interface BookSummary {
  id: number;
  assetId: string | null;
  title: string | null;
  author: string | null;
  source: BookSource;
  quoteCount: number;
  /** Quotes made into at least one pic (post). */
  postedCount: number;
  /** Highlights not posted and not already one of the book's quotes. */
  unpostedHighlightCount: number;
  lastPostedAt: string | null;
}

export interface BookEntryPosting {
  postId: number;
  postedAt: string | null;
  likes: number | null;
  comments: number | null;
  permalink: string | null;
  mediaPath: string | null;
  /** `/media/<file>` when the post's image was downloaded, else null. */
  mediaUrl: string | null;
}

/** A quote from the book, or an unposted Apple Books highlight. */
export interface BookEntry {
  kind: "quote" | "highlight";
  quoteId: number | null;
  highlightId: number | null;
  text: string | null;
  author: string | null;
  note: string | null;
  location: string | null;
  posted: boolean;
  highlightedAt: string | null;
  /** Oldest first. */
  postings: BookEntryPosting[];
}

export interface BookDetail {
  book: BookSummary;
  entries: BookEntry[];
}

export interface BookListParams {
  q?: string;
  sort?: BookSort;
}

// ---------------------------------------------------------------------------
// Endpoints

export function fetchQuotes(params: QuoteSearchParams = {}): Promise<Page<QuoteSearchItem>> {
  return apiGet("/api/quotes", { ...params });
}

export function fetchStats(): Promise<Stats> {
  return apiGet("/api/stats");
}

export function fetchBooks(params: BookListParams = {}): Promise<{ items: BookSummary[] }> {
  return apiGet("/api/books", { ...params });
}

export function fetchBookDetail(id: number): Promise<BookDetail> {
  return apiGet(`/api/books/${id}`);
}

export function fetchQuoteDetail(id: number): Promise<QuoteDetail> {
  return apiGet(`/api/quotes/${id}`);
}

/**
 * PATCH a quote. Rejects with `ApiError` status 409 when `text` duplicates another quote;
 * `conflictIdOf(err)` then names that quote.
 */
export async function updateQuote(id: number, patch: QuotePatch): Promise<Quote> {
  const { quote } = await apiSend<{ quote: Quote }>("PATCH", `/api/quotes/${id}`, patch);
  return quote;
}

/** Merge `dropId` into `keepId` (drop is deleted); resolves to keep's refreshed detail. */
export function mergeQuote(keepId: number, dropId: number): Promise<QuoteDetail> {
  return apiSend("POST", `/api/quotes/${keepId}/merge`, { dropId });
}

/** The quote a 409 from `updateQuote` collided with, or null. */
export function conflictIdOf(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const id = err.details.conflictId;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}
