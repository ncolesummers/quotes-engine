import { ChevronLeftIcon, ChevronRightIcon, SplitIcon } from "lucide-react";
import { Link } from "wouter";
import type { DuplicatePair, DuplicateQuote } from "@/api";
import { Kbd } from "@/components/ExtractionReview";
import { PostedBadge } from "@/components/PostedBadge";
import { Button } from "@/components/ui/button";

export interface DuplicateReviewProps {
  pair: DuplicatePair;
  position: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  /** Keep `keep`, folding `drop` into it (asks for confirmation first). */
  onKeep: (keep: DuplicateQuote, drop: DuplicateQuote) => void;
  onDismiss: () => void;
}

function Side({
  quote,
  other,
  onKeep,
}: {
  quote: DuplicateQuote;
  other: DuplicateQuote;
  onKeep: () => void;
}) {
  return (
    <section
      aria-label={`Quote #${quote.id}`}
      className="flex min-w-0 flex-col gap-4 rounded-lg border border-border/70 bg-background/60 p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Link
          href={`/quotes/${quote.id}`}
          className="tabular-nums underline-offset-4 hover:text-primary hover:underline"
        >
          Quote #{quote.id}
        </Link>
        <PostedBadge count={quote.postingCount} className="ml-auto" />
      </div>
      <blockquote className="font-serif text-xl leading-snug text-pretty">{quote.text}</blockquote>
      {(quote.author || quote.sourceTitle) && (
        <p className="text-sm text-muted-foreground">
          — {quote.author && <span className="text-foreground/85">{quote.author}</span>}
          {quote.author && quote.sourceTitle && <span aria-hidden> · </span>}
          {quote.sourceTitle && <span className="font-serif italic">{quote.sourceTitle}</span>}
        </p>
      )}
      <Button
        variant="outline"
        size="sm"
        className="mt-auto self-start"
        onClick={onKeep}
        title={`Merge quote #${other.id} into this one`}
      >
        Keep #{quote.id}
      </Button>
    </section>
  );
}

/** Two quotes that look alike, side by side: keep one (merge) or mark them distinct. */
export function DuplicateReview({
  pair,
  position,
  total,
  onPrev,
  onNext,
  onKeep,
  onDismiss,
}: DuplicateReviewProps) {
  const { a, b } = pair;
  return (
    <article
      aria-label={`Quotes #${a.id} and #${b.id}`}
      className="flex flex-col gap-5 rounded-xl border border-border/70 bg-card p-4 shadow-xs sm:p-6 lg:-mx-28"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <span className="tabular-nums">
          {position} of {total}
        </span>
        <span className="font-serif text-base text-foreground tabular-nums">
          {Math.round(pair.score * 100)}% alike
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onPrev}
            disabled={position <= 1}
            aria-keyshortcuts="k"
          >
            <ChevronLeftIcon aria-hidden />
            Previous
            <Kbd>k</Kbd>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onNext}
            disabled={position >= total}
            aria-keyshortcuts="j"
          >
            Next
            <Kbd>j</Kbd>
            <ChevronRightIcon aria-hidden />
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Side quote={a} other={b} onKeep={() => onKeep(a, b)} />
        <Side quote={b} other={a} onKeep={() => onKeep(b, a)} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" onClick={onDismiss} aria-keyshortcuts="n">
          <SplitIcon aria-hidden />
          Not a duplicate
          <Kbd>n</Kbd>
        </Button>
        <p className="text-xs text-muted-foreground">
          Merging moves the other quote’s postings and highlights onto the one you keep.
        </p>
      </div>
    </article>
  );
}
