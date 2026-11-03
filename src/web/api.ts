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

/** What a quote comes from. For a song, `author` is the artist and `sourceTitle` the song. */
export type SourceKind = "book" | "song" | "other";

export interface Quote {
  id: number;
  text: string;
  normalizedText: string;
  author: string | null;
  sourceTitle: string | null;
  notes: string | null;
  sourceKind: SourceKind;
  /** The book `sourceTitle` resolved to, or null (always null for songs and other sources). */
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
  /** "song" or "other" unlinks the quote's book. */
  sourceKind?: SourceKind;
}

export interface Page<T> {
  items: T[];
  /** Total matches across all pages. */
  total: number;
}

export type QuoteSort = "likes" | "comments" | "recent" | "postings";

export interface QuoteSearchParams {
  q?: string;
  /** Substring of the author. */
  author?: string;
  /** The whole author name (a pick from `GET /api/authors`). */
  authorExact?: string;
  book?: string;
  /** Exact linked book (a pick from the books list). */
  bookId?: number;
  posted?: "yes" | "no";
  minPostings?: number;
  /** Only book quotes not linked to a book. */
  noBook?: boolean;
  kind?: SourceKind;
  sort?: QuoteSort;
  limit?: number;
  offset?: number;
}

/** One item of `GET /api/authors`. */
export interface AuthorSummary {
  name: string;
  quoteCount: number;
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
/** Why a book may need a look ("Needs attention"); hints only. */
export type BookIssue = "no_author" | "possible_duplicate" | "series_title";

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
  issues: BookIssue[];
}

/** Another book with a similar title (`GET /api/books/:id`). */
export interface PossibleDuplicate extends BookRef {
  quoteCount: number;
  /** Title similarity, 0–1. */
  score: number;
}

/** A book record (`PATCH /api/books/:id`). */
export interface Book extends BookRef {
  assetId: string | null;
  normalizedKey: string | null;
  source: BookSource;
}

/** Editable book fields; null clears the author. */
export interface BookPatch {
  title?: string;
  author?: string | null;
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
  /** Best match first. */
  possibleDuplicates: PossibleDuplicate[];
}

export interface BookListParams {
  q?: string;
  sort?: BookSort;
  /** Only books with issues. */
  attention?: boolean;
}

/** The book of an Apple Books highlight. */
export interface HighlightBook {
  id: number;
  assetId: string | null;
  title: string | null;
  author: string | null;
}

/** One item of `GET /api/highlights`, newest first. */
export interface Highlight {
  id: number;
  annotationUuid: string;
  text: string | null;
  note: string | null;
  location: string | null;
  createdAt: string | null;
  quoteId: number | null;
  /** Linked to a quote that appears on at least one post. */
  posted: boolean;
  book: HighlightBook;
}

export interface HighlightFilter {
  /** Only highlights not yet posted. */
  unposted?: boolean;
  /** Substring of the highlight text or note. */
  q?: string;
}

export interface HighlightListParams extends HighlightFilter {
  /** Exact book id. */
  bookId?: number;
  /** Substring of the book title. */
  book?: string;
  limit?: number;
  offset?: number;
}

/** One book of `GET /api/highlights/books`: how many highlights match, newest book first. */
export interface HighlightBookGroup {
  book: HighlightBook;
  count: number;
  lastHighlightedAt: string | null;
}

// ---------------------------------------------------------------------------
// Endpoints

/** Boolean filters go over the wire as `1`, and are left out when false. */
function highlightParams({ unposted, ...rest }: HighlightListParams): Record<string, QueryValue> {
  return { ...rest, unposted: unposted ? 1 : undefined };
}

export function fetchHighlights(params: HighlightListParams = {}): Promise<Page<Highlight>> {
  return apiGet("/api/highlights", highlightParams(params));
}

/** Per-book counts of the matching highlights; `total` is their sum. */
export function fetchHighlightBooks(
  params: HighlightFilter = {},
): Promise<{ items: HighlightBookGroup[]; total: number }> {
  return apiGet("/api/highlights/books", highlightParams(params));
}

export function fetchQuotes({
  noBook,
  ...params
}: QuoteSearchParams = {}): Promise<Page<QuoteSearchItem>> {
  return apiGet("/api/quotes", { ...params, noBook: noBook ? 1 : undefined });
}

/** Distinct quote authors with quote counts, by name (`GET /api/authors`). */
export async function fetchAuthors(): Promise<AuthorSummary[]> {
  const { items } = await apiGet<{ items: AuthorSummary[] }>("/api/authors");
  return items;
}

export function fetchStats(): Promise<Stats> {
  return apiGet("/api/stats");
}

export function fetchBooks({
  attention,
  ...params
}: BookListParams = {}): Promise<{ items: BookSummary[] }> {
  return apiGet("/api/books", { ...params, attention: attention ? 1 : undefined });
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

/**
 * PATCH a book's title/author. Rejects with `ApiError` status 409 when another book has the
 * same title and author; `conflictIdOf(err)` then names that book.
 */
export async function updateBook(id: number, patch: BookPatch): Promise<Book> {
  const { book } = await apiSend<{ book: Book }>("PATCH", `/api/books/${id}`, patch);
  return book;
}

/** Merge book `dropId` into `keepId` (drop is deleted); resolves to keep's refreshed detail. */
export function mergeBook(keepId: number, dropId: number): Promise<BookDetail> {
  return apiSend("POST", `/api/books/${keepId}/merge`, { dropId });
}

/** Delete a book with no quotes or highlights (409 otherwise). */
export function deleteBook(id: number): Promise<{ id: number }> {
  return apiSend("DELETE", `/api/books/${id}`);
}

/** The quote (or book) a 409 from `updateQuote` (or `updateBook`) collided with, or null. */
export function conflictIdOf(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const id = err.details.conflictId;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

// ---------------------------------------------------------------------------
// Review queue

/** A `needs_review` post–quote link of `GET /api/review`. */
export interface ReviewLink {
  postId: number;
  quoteId: number;
  method: LinkMethod;
  confidence: number | null;
  post: {
    id: number;
    igMediaId: string;
    permalink: string | null;
    caption: string | null;
    postedAt: string | null;
    /** `/media/<file>` when the post's image was downloaded, else null. */
    mediaUrl: string | null;
  };
  quote: {
    id: number;
    text: string;
    author: string | null;
    sourceTitle: string | null;
    sourceKind: SourceKind;
  };
}

export interface DuplicateQuote {
  id: number;
  text: string;
  author: string | null;
  sourceTitle: string | null;
  postingCount: number;
}

/** Two quotes that look like the same quote; `a` has the lower id. */
export interface DuplicatePair {
  a: DuplicateQuote;
  b: DuplicateQuote;
  /** Similarity of the normalized texts, 0–1. */
  score: number;
}

export interface ReviewQueue {
  links: ReviewLink[];
  duplicates: DuplicatePair[];
}

/** `song` marks the quote a song (unlinking its book) and confirms the link. */
export type ReviewAction = "confirm" | "reject" | "song";

export function fetchReview(): Promise<ReviewQueue> {
  return apiGet("/api/review");
}

/** Confirm a link (marks it confirmed), reject it (deletes it), or mark its quote a song. */
export function resolveReviewLink(
  postId: number,
  quoteId: number,
  action: ReviewAction,
): Promise<{ postId: number; quoteId: number; action: ReviewAction }> {
  return apiSend("POST", `/api/review/${postId}/${quoteId}`, { action });
}

/** Mark two quotes as not duplicates so the pair stops being suggested. */
export function dismissDuplicate(aId: number, bId: number): Promise<{ aId: number; bId: number }> {
  return apiSend("POST", "/api/review/duplicates/dismiss", { aId, bId });
}
