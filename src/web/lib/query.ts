import { QueryClient } from "@tanstack/react-query";
import { ApiError, type QuoteSearchParams } from "@/api";

/** Query keys in one place so mutations (#14+) can invalidate precisely. */
export const queryKeys = {
  stats: ["stats"] as const,
  quotes: {
    all: ["quotes"] as const,
    /** Prefix of every search query (invalidate after edits and merges). */
    searches: ["quotes", "search"] as const,
    search: (params: Omit<QuoteSearchParams, "offset">) => ["quotes", "search", params] as const,
    detail: (id: number) => ["quotes", "detail", id] as const,
  },
};

/** Retry server/network failures once; a 4xx (e.g. a 404) won't change on retry. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 1;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: shouldRetry },
    },
  });
}
