import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { SearchIcon } from "lucide-react";
import { useId } from "react";
import { fetchQuotes, type QuoteSort } from "@/api";
import { QuoteCard } from "@/components/QuoteCard";
import {
  bookLabel,
  type FilterChip,
  FilterChips,
  FilterControls,
  MobileFilters,
  useBookOptions,
} from "@/components/SearchFilters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSearchParamState } from "@/hooks/use-search-param-state";
import { useUrlSearch } from "@/hooks/use-url-search";
import { formatNumber } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import {
  CLEAR_FILTERS,
  filterPatch,
  parseQuoteFilters,
  type QuoteFilters,
  SORTS,
  toQuoteSearchParams,
} from "@/lib/quote-filters";
import { KIND_FILTER_LABEL } from "@/lib/source-kind";

export const SEARCH_DEBOUNCE_MS = 250;
export const PAGE_SIZE = 20;

/** `?q=` (see `useUrlSearch`) plus the filters and sort of `@/lib/quote-filters`. */
function useQuoteSearch() {
  const [params, patch] = useSearchParamState();
  const filters = parseQuoteFilters(params);
  const { q, draft, setDraft } = useUrlSearch(SEARCH_DEBOUNCE_MS);
  const setFilters = (change: Partial<QuoteFilters>) => patch(filterPatch(change));
  const clearFilters = () => patch(CLEAR_FILTERS);
  return { q, filters, draft, setDraft, setFilters, clearFilters };
}

const POSTED_LABEL = { yes: "Posted", no: "Never posted" } as const;

/** The active filters as chips; `bookTitle` names the picked book once the list has loaded. */
function filterChips(
  f: QuoteFilters,
  bookTitle: string | null,
  set: (change: Partial<QuoteFilters>) => void,
): FilterChip[] {
  const chips: FilterChip[] = [];
  if (f.author !== null) {
    chips.push({
      key: "author",
      kind: "Author",
      label: f.author,
      remove: () => set({ author: null }),
    });
  }
  if (f.bookId !== null) {
    chips.push({
      key: "book",
      kind: "Book",
      label: bookTitle ?? "…",
      remove: () => set({ bookId: null }),
    });
  }
  if (f.noBook) {
    chips.push({
      key: "nobook",
      kind: "Book",
      label: "No book",
      remove: () => set({ noBook: false }),
    });
  }
  if (f.kind !== null) {
    chips.push({
      key: "kind",
      kind: "Kind",
      label: KIND_FILTER_LABEL[f.kind],
      remove: () => set({ kind: null }),
    });
  }
  if (f.posted !== "any") {
    chips.push({
      key: "posted",
      kind: "Posted",
      label: POSTED_LABEL[f.posted],
      remove: () => set({ posted: "any" }),
    });
  }
  if (f.reposted) {
    chips.push({
      key: "reposted",
      kind: "Postings",
      label: "Reposted",
      remove: () => set({ reposted: false }),
    });
  }
  return chips;
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
  const { q, filters, draft, setDraft, setFilters, clearFilters } = useQuoteSearch();
  const inputId = useId();
  const sortId = useId();
  const books = useBookOptions(filters.bookId !== null);
  const pickedBook =
    filters.bookId === null ? null : books.data?.find((b) => b.id === filters.bookId);
  const bookTitle =
    filters.bookId === null || books.isPending
      ? null
      : bookLabel(pickedBook ?? undefined, filters.bookId);
  const chips = filterChips(filters, bookTitle, setFilters);
  const filtered = chips.length > 0;
  const search = { q: q || undefined, ...toQuoteSearchParams(filters), limit: PAGE_SIZE };

  const query = useInfiniteQuery({
    queryKey: queryKeys.quotes.search(search),
    queryFn: ({ pageParam }) => fetchQuotes({ ...search, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return last.items.length > 0 && loaded < last.total ? loaded : undefined;
    },
    placeholderData: keepPreviousData,
  });

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;
  const noun = total === 1 ? "quote" : "quotes";

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

        <div className="flex items-start justify-between gap-3 text-sm">
          <MobileFilters filters={filters} activeCount={chips.length} onChange={setFilters} />
          <FilterControls filters={filters} onChange={setFilters} className="hidden sm:flex" />
          <div className="flex shrink-0 items-center gap-2 text-muted-foreground">
            <label htmlFor={sortId}>Sort</label>
            <Select
              value={filters.sort}
              onValueChange={(v) => setFilters({ sort: v as QuoteSort })}
            >
              <SelectTrigger
                id={sortId}
                size="sm"
                aria-label="Sort"
                className="bg-card text-foreground"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {SORTS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <FilterChips chips={chips} onClear={clearFilters} />

        <p aria-live="polite" className="text-sm text-muted-foreground">
          {query.isSuccess &&
            (q
              ? `${formatNumber(total)} ${total === 1 ? "match" : "matches"} for “${q}”${filtered ? " with these filters" : ""}`
              : filtered
                ? `${formatNumber(total)} ${noun} ${total === 1 ? "matches" : "match"} these filters`
                : `${formatNumber(total)} ${noun} in the archive`)}
        </p>
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
            {filtered
              ? q
                ? `No quotes match “${q}” with these filters.`
                : "No quotes match these filters."
              : q
                ? `No quotes match “${q}”.`
                : "The archive is empty."}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {filtered
              ? "Loosen or remove a filter to see more."
              : q
                ? "Try fewer words, or search by author or book."
                : "Run a sync to bring in your Instagram posts."}
          </p>
          {filtered && (
            <Button variant="outline" size="sm" className="mt-4" onClick={clearFilters}>
              Clear filters
            </Button>
          )}
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
