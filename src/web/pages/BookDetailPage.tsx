import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLinkIcon, MergeIcon, Trash2Icon } from "lucide-react";
import { useId, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  ApiError,
  type BookDetail,
  type BookEntry,
  type BookEntryPosting,
  type BookPatch,
  type BookRef,
  conflictIdOf,
  deleteBook,
  fetchBookDetail,
  mergeBook,
  type PossibleDuplicate,
  updateBook,
} from "@/api";
import { BookProgress, bookStatsLine } from "@/components/BookProgress";
import { CopyButton } from "@/components/CopyButton";
import { InlineEdit } from "@/components/InlineEdit";
import { MergeBookDialog } from "@/components/MergeBookDialog";
import { PostedBadge } from "@/components/PostedBadge";
import { PostThumbnail } from "@/components/PostThumbnail";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useSearchParam } from "@/hooks/use-search-param-state";
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
  const [value, setValue] = useSearchParam("show");
  const show = parseShow(value);
  const setShow = (next: Show) => setValue(SHOW_PARAM[next]);
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

export const DUPLICATE_BOOK_MESSAGE =
  "Another book already has this title and author — merge instead?";

function PossibleDuplicates({
  books,
  onMerge,
}: {
  books: PossibleDuplicate[];
  onMerge: (book: BookRef) => void;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex max-w-xl flex-col gap-3 rounded-xl border border-dashed border-primary/40 bg-primary/[0.03] px-5 py-4"
    >
      <div className="flex flex-col gap-0.5">
        <h2 id={headingId} className="font-serif text-lg font-medium">
          Possible duplicates
        </h2>
        <p className="text-sm text-muted-foreground">
          These titles look like this one. If one is the same book, merge them.
        </p>
      </div>
      <ul className="flex flex-col divide-y divide-border/60">
        {books.map((b) => (
          <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
            <div className="flex min-w-0 flex-1 flex-col">
              <Link
                href={`/books/${b.id}`}
                className="truncate font-serif text-base underline-offset-4 hover:text-primary hover:underline"
              >
                {b.title ?? "Untitled book"}
              </Link>
              <span className="text-xs text-muted-foreground">
                {b.author ?? <span className="italic">No author</span>}
                {" · "}
                {`${b.quoteCount} ${b.quoteCount === 1 ? "quote" : "quotes"}`}
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onMerge(b)}
              aria-label={`Merge “${b.title ?? "Untitled book"}” with this book`}
            >
              <MergeIcon aria-hidden />
              Merge…
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DeleteBook({ onDelete }: { onDelete: () => Promise<unknown> }) {
  const [confirming, setConfirming] = useState(false);
  const del = useMutation({ mutationFn: onDelete });
  if (!confirming) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setConfirming(true)}
        className="text-muted-foreground hover:text-destructive"
      >
        <Trash2Icon aria-hidden />
        Delete book
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span>Delete this empty book?</span>
      <Button variant="destructive" size="sm" onClick={() => del.mutate()} disabled={del.isPending}>
        {del.isPending ? "Deleting…" : "Yes, delete"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setConfirming(false)}
        disabled={del.isPending}
      >
        Cancel
      </Button>
      {del.error && (
        <p role="alert" className="basis-full text-destructive">
          {del.error.message}
        </p>
      )}
    </div>
  );
}

type MergeState = { open: boolean; preselect?: BookRef; preselectId?: number };

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
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [merge, setMerge] = useState<MergeState>({ open: false });
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

  const { book, entries, possibleDuplicates } = query.data;
  const detailKey = queryKeys.books.detail(id);

  const refreshLists = () => {
    // Books (lists and details: issues and duplicate hints may change), quote rows' book refs.
    queryClient.invalidateQueries({ queryKey: queryKeys.books.all });
    queryClient.invalidateQueries({ queryKey: queryKeys.quotes.all });
    queryClient.invalidateQueries({ queryKey: queryKeys.stats });
  };

  const save = (field: keyof BookPatch) => async (value: string | null) => {
    const patch: BookPatch = field === "title" ? { title: value ?? "" } : { author: value };
    const updated = await updateBook(id, patch);
    queryClient.setQueryData<BookDetail>(detailKey, (prev) =>
      prev
        ? { ...prev, book: { ...prev.book, title: updated.title, author: updated.author } }
        : prev,
    );
    refreshLists();
  };

  const renderSaveError = (error: Error) =>
    error instanceof ApiError && error.status === 409 ? (
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-sm">
        {DUPLICATE_BOOK_MESSAGE}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setMerge({ open: true, preselectId: conflictIdOf(error) ?? undefined })}
        >
          Merge instead
        </Button>
      </span>
    ) : (
      <span className="font-sans text-sm">{error.message}</span>
    );

  const onMerge = async (keepId: number, dropId: number) => {
    const merged = await mergeBook(keepId, dropId);
    queryClient.setQueryData(queryKeys.books.detail(keepId), merged);
    queryClient.removeQueries({ queryKey: queryKeys.books.detail(dropId) });
    refreshLists();
    if (keepId !== id) navigate(`/books/${keepId}`);
    return merged;
  };

  const onDelete = async () => {
    await deleteBook(id);
    queryClient.removeQueries({ queryKey: detailKey });
    refreshLists();
    navigate("/books");
  };
  const empty = entries.length === 0 && book.quoteCount === 0;
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          {back}
          <div className="flex items-center gap-2">
            {empty && <DeleteBook onDelete={onDelete} />}
            <Button variant="outline" size="sm" onClick={() => setMerge({ open: true })}>
              <MergeIcon aria-hidden />
              Merge with…
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <InlineEdit
            noun="title"
            label="Title"
            value={book.title}
            required
            onSave={save("title")}
            renderError={renderSaveError}
            inputClassName="font-serif text-2xl"
          >
            {(title) => (
              <h1 className="inline font-serif text-3xl leading-tight font-medium tracking-tight text-balance sm:text-4xl">
                {title}
              </h1>
            )}
          </InlineEdit>
          <div className="text-base text-muted-foreground">
            <InlineEdit
              noun="author"
              label="Author"
              value={book.author}
              onSave={save("author")}
              renderError={renderSaveError}
            >
              {(author) => <span>{author}</span>}
            </InlineEdit>
          </div>
        </div>
        <div className="flex max-w-md flex-col gap-2">
          <p className="text-sm text-muted-foreground tabular-nums">{bookStatsLine(book)}</p>
          <BookProgress book={book} />
        </div>
      </header>

      {possibleDuplicates.length > 0 && (
        <PossibleDuplicates
          books={possibleDuplicates}
          onMerge={(other) => setMerge({ open: true, preselect: other })}
        />
      )}

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

      <MergeBookDialog
        open={merge.open}
        onOpenChange={(open) => setMerge((m) => ({ ...m, open }))}
        book={book}
        preselect={merge.preselect}
        preselectId={merge.preselectId}
        onMerge={onMerge}
      />
    </div>
  );
}
