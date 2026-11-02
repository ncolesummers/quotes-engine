import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";
import { Link, useSearchParams } from "wouter";
import { ApiError, type BookEntry, type BookEntryPosting, fetchBookDetail } from "@/api";
import { BookProgress, bookStatsLine } from "@/components/BookProgress";
import { CopyButton } from "@/components/CopyButton";
import { PostedBadge } from "@/components/PostedBadge";
import { PostThumbnail } from "@/components/PostThumbnail";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatDate, formatNumber } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import { cn } from "@/lib/utils";

type Show = "all" | "posted" | "unposted";

const SHOW_PARAM: Record<Show, string | null> = {
  all: null,
  posted: "posted",
  unposted: "unposted",
};

function parseShow(value: string | null): Show {
  return value === "posted" || value === "unposted" ? value : "all";
}

/** `?show=posted|unposted` (absent = all), replaced in place so toggling adds no history. */
function useShowFilter() {
  const [params, setParams] = useSearchParams();
  const show = parseShow(params.get("show"));
  const setShow = (next: Show) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        const value = SHOW_PARAM[next];
        if (value) p.set("show", value);
        else p.delete("show");
        return p;
      },
      { replace: true },
    );
  return { show, setShow };
}

function PostingTile({ posting }: { posting: BookEntryPosting }) {
  const date = formatDate(posting.postedAt);
  return (
    <li className="flex w-24 flex-col gap-1.5 sm:w-28">
      <PostThumbnail mediaUrl={posting.mediaUrl} date={date} className="size-24 sm:size-28" />
      {posting.postedAt && date ? (
        <time dateTime={posting.postedAt} className="font-serif text-sm font-medium">
          {date}
        </time>
      ) : (
        <span className="font-serif text-sm text-muted-foreground">Undated</span>
      )}
      {posting.permalink && (
        <a
          href={posting.permalink}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-sm text-xs text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          Instagram
          {date && <span className="sr-only">{` post from ${date}`}</span>}
          <ExternalLinkIcon aria-hidden className="size-3" />
        </a>
      )}
    </li>
  );
}

function EntryItem({ entry }: { entry: BookEntry }) {
  const text = entry.text ?? "";
  const highlighted = formatDate(entry.highlightedAt);
  // Newest pic first: the latest posting is the one most worth seeing.
  const postings = [...entry.postings].reverse();

  return (
    <li
      data-entry={entry.kind}
      data-posted={String(entry.posted)}
      className={cn(
        "flex flex-col gap-4 rounded-xl border bg-card px-5 py-5 shadow-xs sm:px-6",
        entry.posted ? "border-border/70" : "border-dashed border-border",
      )}
    >
      <blockquote className="font-serif text-lg leading-relaxed text-pretty text-card-foreground sm:text-xl">
        {entry.quoteId !== null ? (
          <Link
            href={`/quotes/${entry.quoteId}`}
            data-entry-text
            className="rounded-sm outline-none decoration-primary/50 underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {text}
          </Link>
        ) : (
          <span data-entry-text>{text}</span>
        )}
      </blockquote>

      {entry.note && (
        <p className="border-l-2 border-border pl-3 text-sm text-muted-foreground italic">
          <span className="sr-only">Note: </span>
          {entry.note}
        </p>
      )}

      {postings.length > 0 && (
        <ul aria-label="Pics" className="flex flex-wrap gap-4">
          {postings.map((p) => (
            <PostingTile key={p.postId} posting={p} />
          ))}
        </ul>
      )}

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/60 pt-3 text-xs text-muted-foreground">
        <PostedBadge count={entry.postings.length} />
        {entry.kind === "highlight" && (
          <span className="font-serif text-xs italic">Apple Books highlight</span>
        )}
        {highlighted && entry.highlightedAt && (
          <span>
            Highlighted <time dateTime={entry.highlightedAt}>{highlighted}</time>
          </span>
        )}
        {!entry.posted && text && (
          <span className="ml-auto">
            <CopyButton text={text} />
          </span>
        )}
      </footer>
    </li>
  );
}

function HeaderSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading book" className="animate-pulse">
      <div className="h-9 w-2/3 rounded bg-muted" />
      <div className="mt-3 h-4 w-1/4 rounded bg-muted" />
      <div className="mt-8 h-24 w-full rounded-xl bg-muted" />
    </div>
  );
}

export function BookDetailPage({ id: rawId }: { id: string }) {
  const id = Number(rawId);
  const valid = Number.isSafeInteger(id) && id > 0;
  const { show, setShow } = useShowFilter();
  const query = useQuery({
    queryKey: queryKeys.books.detail(id),
    queryFn: () => fetchBookDetail(id),
    enabled: valid,
  });

  const back = (
    <Link
      href="/books"
      className="text-sm text-muted-foreground underline-offset-4 hover:text-primary hover:underline"
    >
      ← All books
    </Link>
  );

  if (!valid || (query.error instanceof ApiError && query.error.status === 404)) {
    return (
      <div className="flex flex-col gap-4 py-8">
        {back}
        <p className="font-serif text-2xl italic">We couldn’t find that book.</p>
      </div>
    );
  }
  if (query.isPending) return <HeaderSkeleton />;
  if (query.isError) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-destructive/40 bg-destructive/5 px-6 py-8 text-center"
      >
        <p className="font-serif text-lg">The book couldn’t be loaded.</p>
        <p className="mt-1 text-sm text-muted-foreground">{query.error.message}</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={() => query.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const { book, entries } = query.data;
  const posted = entries.filter((e) => e.posted);
  const unposted = entries.filter((e) => !e.posted);
  const visible = show === "posted" ? posted : show === "unposted" ? unposted : entries;
  const options: { value: Show; label: string; count: number }[] = [
    { value: "all", label: "All", count: entries.length },
    { value: "posted", label: "Posted", count: posted.length },
    { value: "unposted", label: "Not posted yet", count: unposted.length },
  ];

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-4">
        {back}
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-3xl leading-tight font-medium tracking-tight text-balance sm:text-4xl">
            {book.title ?? "Untitled book"}
          </h1>
          {book.author && <p className="text-base text-muted-foreground">{book.author}</p>}
        </div>
        <div className="flex max-w-md flex-col gap-2">
          <p className="text-sm text-muted-foreground tabular-nums">{bookStatsLine(book)}</p>
          <BookProgress book={book} />
        </div>
      </header>

      <section aria-label="Quotes and highlights" className="flex flex-col gap-5">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={show}
          onValueChange={(v) => v && setShow(v as Show)}
          aria-label="Show"
        >
          {options.map((o) => (
            <ToggleGroupItem
              key={o.value}
              value={o.value}
              className="gap-1.5 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
            >
              {o.label}
              <span className="tabular-nums opacity-70">{formatNumber(o.count)}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        {visible.length === 0 ? (
          <div className="rounded-xl border border-dashed px-6 py-12 text-center">
            <p className="font-serif text-lg italic">
              {show === "posted"
                ? "Nothing from this book has become a pic yet."
                : show === "unposted"
                  ? "Everything from this book has been posted."
                  : "No quotes or highlights from this book yet."}
            </p>
          </div>
        ) : (
          <ol className="flex flex-col gap-4">
            {visible.map((e) => (
              <EntryItem key={`${e.kind}-${e.quoteId ?? e.highlightId}`} entry={e} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
