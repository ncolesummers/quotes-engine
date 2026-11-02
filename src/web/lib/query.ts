import { QueryClient } from "@tanstack/react-query";
import type { QuoteSearchParams } from "@/api";

/** Query keys in one place so mutations (#14+) can invalidate precisely. */
export const queryKeys = {
  stats: ["stats"] as const,
  quotes: {
    all: ["quotes"] as const,
    search: (params: Omit<QuoteSearchParams, "offset">) => ["quotes", "search", params] as const,
    detail: (id: number) => ["quotes", "detail", id] as const,
  },
};

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
    },
  });
}
