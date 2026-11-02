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
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Request failed: ${res.status} ${res.statusText}`.trim();
    throw new ApiError(res.status, message);
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
  createdAt: string;
  updatedAt: string;
}

export interface QuoteSearchItem extends Quote {
  postingCount: number;
  totalLikes: number;
  maxLikes: number | null;
  totalComments: number;
  lastPostedAt: string | null;
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

// ---------------------------------------------------------------------------
// Endpoints

export function fetchQuotes(params: QuoteSearchParams = {}): Promise<Page<QuoteSearchItem>> {
  return apiGet("/api/quotes", { ...params });
}

export function fetchStats(): Promise<Stats> {
  return apiGet("/api/stats");
}
