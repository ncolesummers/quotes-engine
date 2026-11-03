import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

export type FetchHandler = (
  url: URL,
  init: RequestInit | undefined,
) => Response | Promise<Response>;

export interface MockedFetch {
  /** Every request URL, in call order. */
  calls: URL[];
  /** Every request's init, in call order (parallel to `calls`). */
  inits: (RequestInit | undefined)[];
  /** Calls whose pathname equals `pathname`. */
  callsTo(pathname: string): URL[];
  restore(): void;
}

/** Replace `globalThis.fetch` with `handler`; relative URLs resolve against http://localhost. */
export function mockFetch(handler: FetchHandler): MockedFetch {
  const original = globalThis.fetch;
  const calls: URL[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fake = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://localhost");
    calls.push(url);
    inits.push(init);
    return handler(url, init);
  };
  globalThis.fetch = fake as typeof fetch;
  return {
    calls,
    inits,
    callsTo: (pathname) => calls.filter((u) => u.pathname === pathname),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export const emptyStats = {
  quotes: 0,
  posts: 0,
  repostedQuotes: 0,
  highlights: 0,
  highlightsBacklog: 0,
  needsReview: 0,
};

/** A `/api/quotes` item with sensible defaults. */
export function quoteItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    text: "So it goes.",
    normalizedText: "so it goes",
    author: "Kurt Vonnegut",
    sourceTitle: "Slaughterhouse-Five",
    notes: null,
    sourceKind: "book",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    postingCount: 1,
    totalLikes: 10,
    maxLikes: 10,
    totalComments: 2,
    lastPostedAt: "2026-01-01T00:00:00.000Z",
    bookId: null,
    book: null,
    ...overrides,
  };
}

/** One posting from `GET /api/quotes/:id`, with sensible defaults. */
export function postingItem(overrides: Record<string, unknown> = {}) {
  const postId = (overrides.postId as number | undefined) ?? 1;
  return {
    postId,
    igMediaId: `ig_${postId}`,
    permalink: `https://www.instagram.com/p/post${postId}/`,
    mediaPath: `media/${postId}.jpg`,
    mediaUrl: `/media/${postId}.jpg`,
    postedAt: "2026-01-01T12:00:00.000Z",
    likes: 10,
    comments: 2,
    method: "caption" as const,
    confidence: 0.98,
    status: "confirmed" as const,
    ...overrides,
  };
}

/** A `GET /api/quotes/:id` body. */
export function quoteDetail(
  overrides: {
    quote?: Record<string, unknown>;
    postings?: ReturnType<typeof postingItem>[];
    highlights?: unknown[];
    book?: { id: number; title: string | null; author: string | null } | null;
  } = {},
) {
  const {
    postingCount: _pc,
    totalLikes: _tl,
    maxLikes: _ml,
    totalComments: _tc,
    lastPostedAt: _lp,
    book: _book,
    ...quote
  } = quoteItem(overrides.quote);
  return {
    quote,
    postings: overrides.postings ?? [postingItem()],
    highlights: overrides.highlights ?? [],
    book: overrides.book ?? null,
  };
}

/** One `GET /api/books` item (also `book` of `GET /api/books/:id`). */
export function bookSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    assetId: null,
    title: "Fool's Errand",
    author: "Robin Hobb",
    source: "caption" as const,
    quoteCount: 3,
    postedCount: 2,
    unpostedHighlightCount: 1,
    lastPostedAt: "2026-10-25T12:00:00.000Z",
    issues: [],
    ...overrides,
  };
}

/** One posting of a book entry. */
export function bookPosting(overrides: Record<string, unknown> = {}) {
  const postId = (overrides.postId as number | undefined) ?? 1;
  return {
    postId,
    postedAt: "2026-01-01T12:00:00.000Z",
    likes: 10,
    comments: 2,
    permalink: `https://www.instagram.com/p/post${postId}/`,
    mediaPath: `${postId}.jpg`,
    mediaUrl: `/media/${postId}.jpg`,
    ...overrides,
  };
}

/** One entry of `GET /api/books/:id`; a posted quote by default. */
export function bookEntry(overrides: Record<string, unknown> = {}) {
  return {
    kind: "quote" as const,
    quoteId: 1,
    highlightId: null,
    text: "Hope is a dangerous thing.",
    author: "Robin Hobb",
    note: null,
    location: null,
    posted: true,
    highlightedAt: null,
    postings: [bookPosting()],
    ...overrides,
  };
}

/** One `items` entry of `GET /api/highlights`; an unposted highlight by default. */
export function highlightItem(
  overrides: Omit<Record<string, unknown>, "book"> & { book?: Record<string, unknown> } = {},
) {
  const { book, ...rest } = overrides;
  const id = (rest.id as number | undefined) ?? 1;
  return {
    id,
    annotationUuid: `uuid-${id}`,
    text: "The trouble is, you think you have time.",
    note: null,
    location: null,
    createdAt: "2026-03-05T12:00:00.000Z",
    quoteId: null,
    posted: false,
    ...rest,
    book: { id: 1, assetId: "asset-1", title: "Meditations", author: "Marcus Aurelius", ...book },
  };
}

/** One `items` entry of `GET /api/highlights/books`. */
export function highlightGroup(
  overrides: {
    book?: Record<string, unknown>;
    count?: number;
    lastHighlightedAt?: string | null;
  } = {},
) {
  return {
    count: 3,
    lastHighlightedAt: "2026-03-05T12:00:00.000Z",
    ...overrides,
    book: {
      id: 1,
      assetId: "asset-1",
      title: "Meditations",
      author: "Marcus Aurelius",
      ...overrides.book,
    },
  };
}

/** One `links` item of `GET /api/review`. */
export function reviewLink(
  overrides: {
    postId?: number;
    quoteId?: number;
    method?: "caption" | "image" | "manual";
    confidence?: number | null;
    post?: Record<string, unknown>;
    quote?: Record<string, unknown>;
  } = {},
) {
  const postId = overrides.postId ?? 1;
  const quoteId = overrides.quoteId ?? 1;
  return {
    postId,
    quoteId,
    method: overrides.method ?? ("image" as const),
    confidence: overrides.confidence === undefined ? 0.62 : overrides.confidence,
    post: {
      id: postId,
      igMediaId: `ig_${postId}`,
      permalink: `https://www.instagram.com/p/post${postId}/`,
      caption: `Caption for post ${postId}`,
      postedAt: "2026-01-01T12:00:00.000Z",
      mediaUrl: `/media/${postId}.jpg`,
      ...overrides.post,
    },
    quote: {
      id: quoteId,
      text: `EXTRACTED QUOTE ${quoteId}`,
      author: null,
      sourceTitle: null,
      sourceKind: "book",
      ...overrides.quote,
    },
  };
}

/** One quote of a `duplicates` pair of `GET /api/review`. */
export function duplicateQuote(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    text: "The only way out is through.",
    author: "Robert Frost",
    sourceTitle: null,
    postingCount: 1,
    ...overrides,
  };
}

/** Render `ui` inside a fresh QueryClient (no retries) and an in-memory wouter router. */
export function renderWithProviders(ui: ReactNode, { path = "/" }: { path?: string } = {}) {
  const location = memoryLocation({ path, record: true });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <Router hook={location.hook} searchHook={location.searchHook}>
        {ui}
      </Router>
    </QueryClientProvider>,
  );
  return { ...result, location, queryClient };
}
