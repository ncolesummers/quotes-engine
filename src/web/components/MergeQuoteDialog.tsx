import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeftIcon, SearchIcon } from "lucide-react";
import { useId, useState } from "react";
import { fetchQuotes, type QuoteDetail, type QuoteSearchItem } from "@/api";
import { PostedBadge } from "@/components/PostedBadge";
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
import { queryKeys } from "@/lib/query";

export const MERGE_SEARCH_DEBOUNCE_MS = 250;
const MERGE_SEARCH_LIMIT = 8;

export interface MergeQuoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The quote that is kept. */
  keepId: number;
  /** Prefills the search (e.g. with a draft that collided with another quote). */
  initialQuery?: string;
  /** POSTs the merge; resolves to the kept quote's refreshed detail. */
  onMerge: (dropId: number) => Promise<QuoteDetail>;
}

/** Find another quote and merge it into this one (its postings and highlights move here). */
export function MergeQuoteDialog({ open, onOpenChange, ...rest }: MergeQuoteDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        {/* Mounted only while open, so each opening starts fresh from `initialQuery`. */}
        <MergeQuoteBody {...rest} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function MergeQuoteBody({
  keepId,
  initialQuery = "",
  onMerge,
  onDone,
}: Omit<MergeQuoteDialogProps, "open" | "onOpenChange"> & { onDone: () => void }) {
  const [draft, setDraft] = useState(initialQuery);
  const [selected, setSelected] = useState<QuoteSearchItem | null>(null);
  const inputId = useId();
  const q = useDebouncedValue(draft.trim(), MERGE_SEARCH_DEBOUNCE_MS);

  const search = useQuery({
    queryKey: queryKeys.quotes.search({ q, limit: MERGE_SEARCH_LIMIT }),
    queryFn: () => fetchQuotes({ q, limit: MERGE_SEARCH_LIMIT }),
    enabled: q !== "",
  });
  const candidates = (search.data?.items ?? []).filter((item) => item.id !== keepId);

  const merge = useMutation({ mutationFn: onMerge, onSuccess: onDone });

  if (selected) {
    return (
      <>
        <DialogHeader>
          <DialogTitle className="font-serif text-xl font-medium">Merge these quotes?</DialogTitle>
          <DialogDescription>
            Its postings and highlights move to this quote, and quote #{selected.id} is deleted.
            Missing author, book or notes here are filled in from it.
          </DialogDescription>
        </DialogHeader>
        <blockquote className="rounded-lg border border-border/70 bg-card px-4 py-3 font-serif text-lg leading-relaxed">
          {selected.text}
          {selected.author && (
            <footer className="mt-2 font-sans text-sm text-muted-foreground">
              — {selected.author}
            </footer>
          )}
        </blockquote>
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
              setSelected(null);
            }}
            disabled={merge.isPending}
          >
            <ArrowLeftIcon aria-hidden />
            Back to search
          </Button>
          <Button onClick={() => merge.mutate(selected.id)} disabled={merge.isPending}>
            {merge.isPending ? "Merging…" : "Merge into this quote"}
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-serif text-xl font-medium">
          Merge with another quote
        </DialogTitle>
        <DialogDescription>
          Pick a duplicate to fold into this quote. You’ll confirm before anything changes.
        </DialogDescription>
      </DialogHeader>
      <div className="relative">
        <label htmlFor={inputId} className="sr-only">
          Search quotes to merge
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
          placeholder="Search a line, an author, a book…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="bg-card pl-9 font-serif"
        />
      </div>
      <div aria-live="polite" className="min-h-24">
        {q === "" ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Type to find the quote to merge in.
          </p>
        ) : search.isPending ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Searching…</p>
        ) : search.isError ? (
          <p role="alert" className="py-6 text-center text-sm text-destructive">
            {search.error.message}
          </p>
        ) : candidates.length === 0 ? (
          <p className="py-6 text-center font-serif italic text-muted-foreground">
            No other quotes match “{q}”.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {candidates.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setSelected(item)}
                  className="w-full rounded-lg border border-border/70 bg-card px-4 py-3 text-left transition-colors outline-none hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <span className="line-clamp-3 font-serif leading-snug">{item.text}</span>
                  <span className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {item.author && <span>{item.author}</span>}
                    <PostedBadge count={item.postingCount} />
                    <span className="ml-auto tabular-nums">#{item.id}</span>
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
