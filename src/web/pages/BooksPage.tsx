import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { SearchIcon } from "lucide-react";
import { useId, useState } from "react";
import { Link } from "wouter";
import { type BookIssue, type BookSort, type BookSummary, fetchBooks } from "@/api";
import { BookProgress, bookStatsLine } from "@/components/BookProgress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSearchParam } from "@/hooks/use-search-param-state";
import { useUrlSearch } from "@/hooks/use-url-search";
import { formatNumber } from "@/lib/format";
import { queryKeys } from "@/lib/query";

export const BOOK_SEARCH_DEBOUNCE_MS = 250;

const SORTS: { value: BookSort; label: string }[] = [
  { value: "title", label: "Title" },
  { value: "recent", label: "Recently posted" },
  { value: "posted", label: "Most posted" },
  { value: "quotes", label: "Most quotes" },
];

export const ISSUE_LABELS: Record<BookIssue, string> = {
  no_author: "No author",
  possible_duplicate: "Possible duplicate",
  series_title: "Series name?",
};

/** `?attention=1`, replaced in place so toggling adds no history. */
function useAttentionFilter() {
  const [value, setValue] = useSearchParam("attention");
  return { attention: value === "1", setAttention: (on: boolean) => setValue(on ? "1" : null) };
}

function IssueBadges({ issues }: { issues: BookIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul aria-label="Needs attention" className="flex flex-wrap gap-1.5">
      {issues.map((issue) => (
        <li
          key={issue}
          className="rounded-full border border-dashed border-primary/40 px-2 py-0.5 text-xs text-primary"
        >
          {ISSUE_LABELS[issue]}
        </li>
      ))}
    </ul>
  );
}

function BookCard({ book }: { book: BookSummary }) {
  return (
    <article className="group relative flex h-full flex-col gap-3 rounded-xl border border-border/70 bg-card px-5 py-5 shadow-xs transition-colors hover:border-primary/40">
      <div className="flex flex-col gap-1">
        <h2 className="font-serif text-xl leading-snug font-medium text-pretty">
          <Link
            href={`/books/${book.id}`}
            className="rounded-sm outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {book.title ?? "Untitled book"}
          </Link>
        </h2>
        {book.author && <p className="text-sm text-muted-foreground">{book.author}</p>}
      </div>
      <IssueBadges issues={book.issues} />
      <div className="mt-auto flex flex-col gap-2 pt-2">
        <p className="text-xs text-muted-foreground tabular-nums">{bookStatsLine(book)}</p>
        <BookProgress book={book} />
        {book.unpostedHighlightCount > 0 && (
          <p className="text-xs text-muted-foreground/80 italic">
            {`${formatNumber(book.unpostedHighlightCount)} unposted ${
              book.unpostedHighlightCount === 1 ? "highlight" : "highlights"
            }`}
          </p>
        )}
      </div>
    </article>
  );
}

function CardSkeleton() {
  return (
    <div aria-hidden className="h-36 animate-pulse rounded-xl border border-border/60 px-5 py-5">
      <div className="h-5 w-3/4 rounded bg-muted" />
      <div className="mt-2 h-3 w-1/3 rounded bg-muted" />
      <div className="mt-10 h-1.5 w-full rounded bg-muted" />
    </div>
  );
}

export function BooksPage() {
  const { q, draft, setDraft } = useUrlSearch(BOOK_SEARCH_DEBOUNCE_MS);
  const [sort, setSort] = useState<BookSort>("title");
  const { attention, setAttention } = useAttentionFilter();
  const inputId = useId();
  const sortId = useId();

  const query = useQuery({
    queryKey: queryKeys.books.list({ q, sort, attention }),
    queryFn: () => fetchBooks({ q: q || undefined, sort, attention }),
    placeholderData: keepPreviousData,
  });
  const books = query.data?.items ?? [];

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-medium tracking-tight">Books</h1>
        <p className="text-sm text-muted-foreground">
          Every book you’ve quoted, and how much of it has become a pic.
        </p>
      </header>

      <section className="flex flex-col gap-4">
        <label htmlFor={inputId} className="sr-only">
          Search books
        </label>
        <div className="relative">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id={inputId}
            type="search"
            autoComplete="off"
            spellCheck={false}
            placeholder="Search a title or an author…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="h-12 rounded-xl bg-card pl-12 font-serif text-lg shadow-xs dark:bg-card"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <p aria-live="polite">
            {query.isSuccess &&
              `${formatNumber(books.length)} ${books.length === 1 ? "book" : "books"}${
                attention ? " needing attention" : ""
              }${q ? ` matching “${q}”` : ""}`}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant={attention ? "default" : "outline"}
              size="sm"
              aria-pressed={attention}
              onClick={() => setAttention(!attention)}
              title="No author, a possible duplicate, or a series name as the title"
              className="h-8"
            >
              Needs attention
            </Button>
            <label htmlFor={sortId}>Sort</label>
            <select
              id={sortId}
              value={sort}
              onChange={(e) => setSort(e.target.value as BookSort)}
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
          role="status"
          aria-busy="true"
          aria-label="Loading books"
          className="grid gap-4 sm:grid-cols-2"
        >
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </div>
      ) : query.isError && !query.data ? (
        <div
          role="alert"
          className="rounded-xl border border-destructive/40 bg-destructive/5 px-6 py-8 text-center"
        >
          <p className="font-serif text-lg">The books couldn’t be loaded.</p>
          <p className="mt-1 text-sm text-muted-foreground">{query.error?.message}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => query.refetch()}>
            Try again
          </Button>
        </div>
      ) : books.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <p className="font-serif text-xl italic">
            {attention
              ? q
                ? `No books matching “${q}” need attention.`
                : "Nothing needs attention."
              : q
                ? `No books match “${q}”.`
                : "No books yet."}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {attention
              ? "Every book has an author, a distinct title, and isn’t named after a series."
              : q
                ? "Try part of the title or the author’s name."
                : "Books appear as quotes with a source are imported (or run books:backfill)."}
          </p>
        </div>
      ) : (
        <ul
          className={`grid gap-4 transition-opacity sm:grid-cols-2 ${query.isPlaceholderData ? "opacity-60" : ""}`}
        >
          {books.map((book) => (
            <li key={book.id}>
              <BookCard book={book} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
