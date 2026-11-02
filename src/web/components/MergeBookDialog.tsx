import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeftIcon, SearchIcon } from "lucide-react";
import { useId, useState } from "react";
import { type BookDetail, type BookRef, fetchBookDetail, fetchBooks } from "@/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { formatNumber } from "@/lib/format";
import { queryKeys } from "@/lib/query";
import { cn } from "@/lib/utils";

export const BOOK_MERGE_SEARCH_DEBOUNCE_MS = 250;
/** The server rejects longer `q` values (src/server/api.ts). */
const MAX_QUERY_LENGTH = 500;
const MAX_RESULTS = 8;

export interface MergeBookDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The book whose page this is. */
  book: BookRef;
  /** Opens straight on confirming this book (e.g. a possible duplicate). */
  preselect?: BookRef;
  /** Like `preselect`, by id only (e.g. the book a 409 named); loaded on open. */
  preselectId?: number;
  /** POSTs the merge, keeping `keepId`; resolves to the kept book's refreshed detail. */
  onMerge: (keepId: number, dropId: number) => Promise<BookDetail>;
}

/** Find another book and merge the two, choosing which record (title and author) to keep. */
export function MergeBookDialog({ open, onOpenChange, ...rest }: MergeBookDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        {/* Mounted only while open, so each opening starts fresh. */}
        <MergeBookBody {...rest} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function MergeBookBody({
  book,
  preselect,
  preselectId,
  onMerge,
  onDone,
}: Omit<MergeBookDialogProps, "open" | "onOpenChange"> & { onDone: () => void }) {
  const [draft, setDraft] = useState("");
  const [picked, setPicked] = useState<BookRef | null>(preselect ?? null);
  const [usePreselectId, setUsePreselectId] = useState(preselectId !== undefined);
  const q = useDebouncedValue(draft.trim(), BOOK_MERGE_SEARCH_DEBOUNCE_MS);

  const search = useQuery({
    queryKey: queryKeys.books.list({ q, sort: "title" }),
    queryFn: () => fetchBooks({ q, sort: "title" }),
    enabled: q !== "",
  });
  const candidates = (search.data?.items ?? [])
    .filter((b) => b.id !== book.id)
    .slice(0, MAX_RESULTS);

  const byId = useQuery({
    queryKey: queryKeys.books.detail(preselectId ?? 0),
    queryFn: () => fetchBookDetail(preselectId as number),
    enabled: usePreselectId && preselectId !== undefined && preselectId !== book.id,
  });
  // If the named book can't be loaded, searching is the fallback.
  const other = picked ?? (usePreselectId ? (byId.data?.book ?? null) : null);

  const back = () => {
    setPicked(null);
    setUsePreselectId(false);
  };

  if (other) {
    return (
      <ConfirmMerge book={book} other={other} onMerge={onMerge} onBack={back} onDone={onDone} />
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-serif text-xl font-medium">
          Merge with another book
        </DialogTitle>
        <DialogDescription>
          Pick the duplicate of this book. You’ll choose which title to keep before anything
          changes.
        </DialogDescription>
      </DialogHeader>
      <BookSearchInput value={draft} onChange={setDraft} />
      <div aria-live="polite" className="min-h-24">
        {q === "" ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Type part of a title or an author.
          </p>
        ) : search.isPending ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Searching…</p>
        ) : search.isError ? (
          <p role="alert" className="py-6 text-center text-sm text-destructive">
            {search.error.message}
          </p>
        ) : candidates.length === 0 ? (
          <p className="py-6 text-center font-serif italic text-muted-foreground">
            No other books match “{q}”.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {candidates.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => setPicked(b)}
                  className="w-full rounded-lg border border-border/70 bg-card px-4 py-3 text-left transition-colors outline-none hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <span className="font-serif text-lg leading-snug">
                    {b.title ?? "Untitled book"}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{b.author ?? "No author"}</span>
                    <span aria-hidden>·</span>
                    <span>{quoteCountLabel(b.quoteCount)}</span>
                    <span className="ml-auto tabular-nums">#{b.id}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function quoteCountLabel(n: number): string {
  return `${formatNumber(n)} ${n === 1 ? "quote" : "quotes"}`;
}

function BookSearchInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const inputId = useId();
  return (
    <div className="relative">
      <label htmlFor={inputId} className="sr-only">
        Search books to merge
      </label>
      <SearchIcon
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        id={inputId}
        type="search"
        autoFocus
        autoComplete="off"
        maxLength={MAX_QUERY_LENGTH}
        placeholder="Search a title or an author…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-card pl-9 font-serif"
      />
    </div>
  );
}

function ConfirmMerge({
  book,
  other,
  onMerge,
  onBack,
  onDone,
}: {
  book: BookRef;
  other: BookRef;
  onMerge: MergeBookDialogProps["onMerge"];
  onBack: () => void;
  onDone: () => void;
}) {
  const [keepId, setKeepId] = useState(book.id);
  const name = useId();
  const merge = useMutation({
    mutationFn: () => onMerge(keepId, keepId === book.id ? other.id : book.id),
    onSuccess: onDone,
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-serif text-xl font-medium">Merge these books?</DialogTitle>
        <DialogDescription>
          Every quote and highlight moves to the book you keep, and the other record is deleted. A
          missing author is filled in from it.
        </DialogDescription>
      </DialogHeader>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">Which record to keep?</legend>
        {[book, other].map((b) => (
          <label
            key={b.id}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-lg border bg-card px-4 py-3 transition-colors",
              keepId === b.id ? "border-primary/60 ring-1 ring-primary/30" : "border-border/70",
            )}
          >
            <input
              type="radio"
              name={name}
              value={b.id}
              aria-label={`Keep “${b.title ?? "Untitled book"}”`}
              checked={keepId === b.id}
              onChange={() => setKeepId(b.id)}
              disabled={merge.isPending}
              className="mt-1.5 accent-primary"
            />
            <span className="flex flex-col gap-0.5">
              <span className="font-serif text-lg leading-snug">
                Keep “<span>{b.title ?? "Untitled book"}</span>”
              </span>
              <span className="text-xs text-muted-foreground">
                {b.author ?? "No author"}
                {b.id === book.id ? " · this book" : ` · #${b.id}`}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {merge.error && (
        <p role="alert" className="text-sm text-destructive">
          {merge.error.message}
        </p>
      )}
      <DialogFooter className="sm:justify-between">
        <Button
          variant="ghost"
          onClick={() => {
            merge.reset();
            onBack();
          }}
          disabled={merge.isPending}
        >
          <ArrowLeftIcon aria-hidden />
          Back to search
        </Button>
        <Button onClick={() => merge.mutate()} disabled={merge.isPending}>
          {merge.isPending ? "Merging…" : "Merge books"}
        </Button>
      </DialogFooter>
    </>
  );
}
