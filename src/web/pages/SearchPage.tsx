import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { SearchIcon } from "lucide-react";
import { useId } from "react";
import { useSearchParams } from "wouter";
import { fetchQuotes, type QuoteSort } from "@/api";
import { QuoteCard } from "@/components/QuoteCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useUrlSearch } from "@/hooks/use-url-search";
import { formatNumber } from "@/lib/format";
import { queryKeys } from "@/lib/query";

export const SEARCH_DEBOUNCE_MS = 250;
export const PAGE_SIZE = 20;

const SORTS: { value: QuoteSort; label: string }[] = [
  { value: "recent", label: "Recently posted" },
  { value: "postings", label: "Most reposted" },
  { value: "likes", label: "Most liked" },
  { value: "comments", label: "Most discussed" },
];

function parseSort(value: string | null): QuoteSort {
  return SORTS.some((s) => s.value === value) ? (value as QuoteSort) : "recent";
}

/** `?q=` (see `useUrlSearch`) and `?sort=` drive the search. */
function useQuoteSearch() {
  const [params, setParams] = useSearchParams();
  const sort = parseSort(params.get("sort"));
  const { q, draft, setDraft } = useUrlSearch(SEARCH_DEBOUNCE_MS);

  const setSort = (value: QuoteSort) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === "recent") next.delete("sort");
        else next.set("sort", value);
        return next;
      },
      { replace: true },
    );

  return { q, sort, draft, setDraft, setSort };
}

function ResultSkeleton() {
  return (
    <div aria-hidden className="animate-pulse rounded-xl border border-border/60 px-5 py-6 sm:px-8">
      <div className="h-5 w-11/12 rounded bg-muted" />
      <div className="mt-3 h-5 w-8/12 rounded bg-muted" />
      <div className="mt-6 h-3 w-1/3 rounded bg-muted" />
    </div>
  );
}

export function SearchPage() {
  const { q, sort, draft, setDraft, setSort } = useQuoteSearch();
  const inputId = useId();
  const sortId = useId();

  const query = useInfiniteQuery({
    queryKey: queryKeys.quotes.search({ q, sort, limit: PAGE_SIZE }),
    queryFn: ({ pageParam }) =>
      fetchQuotes({ q: q || undefined, sort, limit: PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return last.items.length > 0 && loaded < last.total ? loaded : undefined;
    },
    placeholderData: keepPreviousData,
  });

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <label htmlFor={inputId} className="sr-only">
          Search quotes
        </label>
        <div className="relative">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id={inputId}
            type="search"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder="Search a line, an author, a book…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="h-14 rounded-xl bg-card pl-12 font-serif text-lg shadow-xs md:text-xl dark:bg-card"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <p aria-live="polite">
            {query.isSuccess &&
              (q
                ? `${formatNumber(total)} ${total === 1 ? "match" : "matches"} for “${q}”`
                : `${formatNumber(total)} ${total === 1 ? "quote" : "quotes"} in the archive`)}
          </p>
          <div className="flex items-center gap-2">
            <label htmlFor={sortId}>Sort</label>
            <select
              id={sortId}
              value={sort}
              onChange={(e) => setSort(e.target.value as QuoteSort)}
              className="h-8 rounded-md border border-input bg-card px-2 text-sm text-foreground shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {query.isPending ? (
        <div
          className="flex flex-col gap-5"
          role="status"
          aria-busy="true"
          aria-label="Loading quotes"
        >
          <ResultSkeleton />
          <ResultSkeleton />
          <ResultSkeleton />
        </div>
      ) : query.isError && !query.data ? (
        <div
          role="alert"
          className="rounded-xl border border-destructive/40 bg-destructive/5 px-6 py-8 text-center"
        >
          <p className="font-serif text-lg">The archive couldn’t be searched.</p>
          <p className="mt-1 text-sm text-muted-foreground">{query.error?.message}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => query.refetch()}>
            Try again
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <p className="font-serif text-xl italic">
            {q ? `No quotes match “${q}”.` : "The archive is empty."}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {q
              ? "Try fewer words, or search by author or book."
              : "Run a sync to bring in your Instagram posts."}
          </p>
        </div>
      ) : (
        <>
          <ol
            className={`flex flex-col gap-5 transition-opacity ${query.isPlaceholderData ? "opacity-60" : ""}`}
          >
            {items.map((quote) => (
              <li key={quote.id}>
                <QuoteCard quote={quote} />
              </li>
            ))}
          </ol>
          {query.hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                onClick={() => query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
              >
                {query.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
          {query.isFetchNextPageError && (
            <p role="alert" className="text-center text-sm text-destructive">
              {query.error?.message}
            </p>
          )}
        </>
      )}
    </div>
  );
}
