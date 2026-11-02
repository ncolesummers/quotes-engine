import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { ChevronRightIcon, SearchIcon, ShuffleIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import { Link, useSearchParams } from "wouter";
import {
  fetchHighlightBooks,
  fetchHighlights,
  type Highlight,
  type HighlightBookGroup,
  type HighlightFilter,
} from "@/api";
import { CopyButton } from "@/components/CopyButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useUrlSearch } from "@/hooks/use-url-search";
import { formatAttribution, formatDate, formatHighlightCopy, formatNumber } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import { cn } from "@/lib/utils";

export const HIGHLIGHT_SEARCH_DEBOUNCE_MS = 250;
/** Highlights fetched per "page" of an open book group. */
export const GROUP_PAGE_SIZE = 50;

type Show = "unposted" | "all";

const plural = (n: number, word: string) => `${formatNumber(n)} ${n === 1 ? word : `${word}s`}`;

/** `?show=all` (absent = unposted only), replaced in place so toggling adds no history. */
function useShowFilter() {
  const [params, setParams] = useSearchParams();
  const show: Show = params.get("show") === "all" ? "all" : "unposted";
  const setShow = (next: Show) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next === "all") p.set("show", "all");
        else p.delete("show");
        return p;
      },
      { replace: true },
    );
  return { show, setShow };
}

function HighlightItem({ highlight }: { highlight: Highlight }) {
  const date = formatDate(highlight.createdAt);
  const text = highlight.text?.trim() ?? "";
  return (
    <li
      data-posted={String(highlight.posted)}
      className={cn(
        "flex flex-col gap-3 rounded-xl border bg-card px-5 py-4 shadow-xs sm:px-6",
        highlight.posted ? "border-border/70" : "border-dashed border-border",
      )}
    >
      <blockquote className="font-serif text-lg leading-relaxed text-pretty text-card-foreground">
        {text || <span className="text-muted-foreground italic">(No text)</span>}
      </blockquote>
      {highlight.note && (
        <p className="border-l-2 border-border pl-3 text-sm text-muted-foreground italic">
          <span className="sr-only">Note: </span>
          {highlight.note}
        </p>
      )}
      <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        {date && highlight.createdAt && (
          <span>
            Highlighted <time dateTime={highlight.createdAt}>{date}</time>
          </span>
        )}
        {highlight.posted && (
          <Badge variant="outline" className="font-normal">
            Posted
          </Badge>
        )}
        {highlight.quoteId !== null && (
          <Link
            href={`/quotes/${highlight.quoteId}`}
            className="rounded-sm text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            View quote
          </Link>
        )}
        {text && (
          <span className="ml-auto">
            <CopyButton text={formatHighlightCopy({ text, book: highlight.book })} />
          </span>
        )}
      </footer>
    </li>
  );
}

/** One open book's highlights, fetched a page at a time. */
function GroupItems({ group, filter }: { group: HighlightBookGroup; filter: HighlightFilter }) {
  const params = { ...filter, bookId: group.book.id, limit: GROUP_PAGE_SIZE };
  const query = useInfiniteQuery({
    queryKey: queryKeys.highlights.list(params),
    queryFn: ({ pageParam }) => fetchHighlights({ ...params, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total && last.items.length > 0 ? loaded : undefined;
    },
    placeholderData: keepPreviousData,
  });

  if (query.isPending) {
    return (
      <p role="status" className="px-1 py-3 text-sm text-muted-foreground">
        Loading highlights…
      </p>
    );
  }
  if (query.isError && !query.data) {
    return (
      <div role="alert" className="flex items-center gap-3 px-1 py-3 text-sm">
        <span>The highlights couldn’t be loaded.</span>
        <Button variant="outline" size="sm" onClick={() => query.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const items = query.data.pages.flatMap((p) => p.items);
  const total = query.data.pages.at(-1)?.total ?? items.length;
  const remaining = total - items.length;
  return (
    <div className="flex flex-col gap-3">
      <ul className={cn("flex flex-col gap-3", query.isPlaceholderData && "opacity-60")}>
        {items.map((h) => (
          <HighlightItem key={h.id} highlight={h} />
        ))}
      </ul>
      {query.hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={query.isFetchingNextPage}
          onClick={() => query.fetchNextPage()}
        >
          {query.isFetchingNextPage
            ? "Loading…"
            : `Show ${formatNumber(Math.min(remaining, GROUP_PAGE_SIZE))} more`}
          <span className="text-muted-foreground tabular-nums">{`of ${formatNumber(remaining)}`}</span>
        </Button>
      )}
    </div>
  );
}

function BookGroup({
  group,
  filter,
  open,
  onToggle,
}: {
  group: HighlightBookGroup;
  filter: HighlightFilter;
  open: boolean;
  onToggle: () => void;
}) {
  const headingId = useId();
  const panelId = useId();
  const title = group.book.title ?? "Untitled book";
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-border/70 pb-2">
        <h2 id={headingId} className="min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={onToggle}
            className="group flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-sm text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-4 shrink-0 self-center text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
            />
            <span className="font-serif text-xl font-medium text-pretty group-hover:text-primary">
              {title}
            </span>
            {group.book.author && (
              <span className="text-sm text-muted-foreground">{group.book.author}</span>
            )}
            <span className="text-xs text-muted-foreground tabular-nums">
              {plural(group.count, "highlight")}
            </span>
          </button>
        </h2>
        <Link
          href={`/books/${group.book.id}`}
          className="rounded-sm text-xs text-muted-foreground underline-offset-4 outline-none hover:text-primary hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          Open book<span className="sr-only">{`: ${title}`}</span> →
        </Link>
      </div>
      <div id={panelId} hidden={!open}>
        {open && <GroupItems group={group} filter={filter} />}
      </div>
    </section>
  );
}

/** "What should I post next?": a random unposted highlight matching the search. */
function useShuffle(q: string) {
  return useMutation({
    mutationFn: async (): Promise<Highlight | null> => {
      const filter = { unposted: true, q: q || undefined, limit: 1 };
      const first = await fetchHighlights(filter);
      let total = first.total;
      // Two requests (count, then a random offset): if the set shrank in between, the offset can
      // land past the end, so re-roll against the newer total rather than report "nothing left".
      for (let attempt = 0; total > 0 && attempt < 3; attempt++) {
        const offset = Math.floor(Math.random() * total);
        const page =
          attempt === 0 && offset === 0 ? first : await fetchHighlights({ ...filter, offset });
        const pick = page.items[0];
        if (pick) return pick;
        total = page.total;
      }
      if (total > 0) throw new Error("the highlights changed while picking; try again");
      return null;
    },
  });
}

function RandomPick({
  highlight,
  onAnother,
  onClose,
  busy,
}: {
  highlight: Highlight | null;
  onAnother: () => void;
  onClose: () => void;
  busy: boolean;
}) {
  const text = highlight?.text?.trim() ?? "";
  return (
    <section
      aria-label="Random pick"
      className="relative flex flex-col gap-3 rounded-xl border border-primary/40 bg-card px-5 py-5 shadow-sm sm:px-6"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium tracking-wide text-primary uppercase">Post this next?</p>
        <Button variant="ghost" size="icon" className="size-7" onClick={onClose} aria-label="Close">
          <XIcon aria-hidden className="size-4" />
        </Button>
      </div>
      {highlight ? (
        <>
          <blockquote className="font-serif text-xl leading-relaxed text-pretty">
            {text || <span className="text-muted-foreground italic">(No text)</span>}
          </blockquote>
          {highlight.note && (
            <p className="border-l-2 border-border pl-3 text-sm text-muted-foreground italic">
              <span className="sr-only">Note: </span>
              {highlight.note}
            </p>
          )}
          <p className="text-sm text-muted-foreground">{formatAttribution(highlight.book)}</p>
        </>
      ) : (
        <p className="font-serif text-lg italic">Nothing unposted matches — everything’s a pic.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {highlight && text && (
          <CopyButton text={formatHighlightCopy({ text, book: highlight.book })} />
        )}
        <Button variant="outline" size="sm" onClick={onAnother} disabled={busy}>
          <ShuffleIcon aria-hidden className="size-3.5" />
          Another
        </Button>
      </div>
    </section>
  );
}

function GroupSkeleton() {
  return (
    <div aria-hidden className="animate-pulse border-b border-border/60 pb-3">
      <div className="h-6 w-1/2 rounded bg-muted" />
    </div>
  );
}

export function HighlightsPage() {
  const { q, draft, setDraft } = useUrlSearch(HIGHLIGHT_SEARCH_DEBOUNCE_MS);
  const { show, setShow } = useShowFilter();
  const inputId = useId();
  // Groups the reader opened or closed; untouched groups default to "only the first is open".
  const [toggled, setToggled] = useState<Record<number, boolean>>({});
  // The shuffled highlight (null highlight = nothing left to post) and the search it was picked
  // for; kept while "Another" loads, dropped once the search moves on.
  const [shuffled, setShuffled] = useState<{ highlight: Highlight | null; q: string } | null>(null);
  const pick = shuffled?.q === q ? shuffled : null;

  const filter: HighlightFilter = { unposted: show === "unposted", q: q || undefined };
  const query = useQuery({
    queryKey: queryKeys.highlights.books(filter),
    queryFn: () => fetchHighlightBooks(filter),
    placeholderData: keepPreviousData,
  });
  const groups = query.data?.items ?? [];
  const total = query.data?.total ?? 0;

  const shuffle = useShuffle(q);
  const runShuffle = () =>
    shuffle.mutate(undefined, { onSuccess: (highlight) => setShuffled({ highlight, q }) });

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-3xl font-medium tracking-tight">Highlights</h1>
          <p className="text-sm text-muted-foreground">
            Apple Books highlights waiting their turn — ideas for the next pic.
          </p>
        </div>
        <Button variant="outline" onClick={runShuffle} disabled={shuffle.isPending}>
          <ShuffleIcon aria-hidden className="size-4" />
          Shuffle
        </Button>
      </header>

      {shuffle.isError && (
        <p role="alert" className="text-sm text-destructive">
          Couldn’t pick a highlight: {shuffle.error.message}
        </p>
      )}
      {pick && (
        <RandomPick
          highlight={pick.highlight}
          busy={shuffle.isPending}
          onAnother={runShuffle}
          onClose={() => setShuffled(null)}
        />
      )}

      <section className="flex flex-col gap-4" aria-label="Filters">
        <label htmlFor={inputId} className="sr-only">
          Search highlights
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
            placeholder="Search highlights and notes…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="h-12 rounded-xl bg-card pl-12 font-serif text-lg shadow-xs dark:bg-card"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={show}
            onValueChange={(v) => v && setShow(v as Show)}
            aria-label="Show"
          >
            <ToggleGroupItem
              value="unposted"
              className="data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
            >
              Unposted
            </ToggleGroupItem>
            <ToggleGroupItem
              value="all"
              className="data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
            >
              All
            </ToggleGroupItem>
          </ToggleGroup>
          <p aria-live="polite" className="tabular-nums">
            {query.isSuccess &&
              `${plural(total, show === "unposted" ? "unposted highlight" : "highlight")} in ${plural(
                groups.length,
                "book",
              )}${q ? ` matching “${q}”` : ""}`}
          </p>
        </div>
      </section>

      {query.isPending ? (
        <div
          role="status"
          aria-busy="true"
          aria-label="Loading highlights"
          className="flex flex-col gap-6"
        >
          <GroupSkeleton />
          <GroupSkeleton />
          <GroupSkeleton />
        </div>
      ) : query.isError && !query.data ? (
        <div
          role="alert"
          className="rounded-xl border border-destructive/40 bg-destructive/5 px-6 py-8 text-center"
        >
          <p className="font-serif text-lg">The highlights couldn’t be loaded.</p>
          <p className="mt-1 text-sm text-muted-foreground">{query.error?.message}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => query.refetch()}>
            Try again
          </Button>
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <p className="font-serif text-xl italic">
            {q
              ? `No highlights match “${q}”.`
              : show === "unposted"
                ? "Every highlight has been posted."
                : "No highlights yet."}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {q
              ? "Try another word from the passage or your note."
              : "Highlights arrive from Apple Books when you run the importer."}
          </p>
        </div>
      ) : (
        <div
          className={cn(
            "flex flex-col gap-8 transition-opacity",
            query.isPlaceholderData && "opacity-60",
          )}
        >
          {groups.map((group, i) => (
            <BookGroup
              key={group.book.id}
              group={group}
              filter={filter}
              open={toggled[group.book.id] ?? i === 0}
              onToggle={() =>
                setToggled((prev) => ({
                  ...prev,
                  [group.book.id]: !(prev[group.book.id] ?? i === 0),
                }))
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
