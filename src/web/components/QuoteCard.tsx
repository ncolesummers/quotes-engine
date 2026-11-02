import { Link } from "wouter";
import type { QuoteSearchItem } from "@/api";
import { bookHref, formatDate, formatNumber } from "@/lib/format";
import { PostedBadge } from "./PostedBadge";

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <span className="whitespace-nowrap">
      <span className="font-medium text-foreground tabular-nums">{formatNumber(value)}</span>{" "}
      {label}
    </span>
  );
}

/** One search result: the quote is the hero; attribution and engagement sit quietly below. */
export function QuoteCard({ quote }: { quote: QuoteSearchItem }) {
  const lastPosted = formatDate(quote.lastPostedAt);
  const posted = quote.postingCount > 0;

  return (
    <article className="group relative rounded-xl border border-border/70 bg-card px-5 py-6 shadow-xs transition-colors hover:border-primary/40 sm:px-8 sm:py-8">
      <blockquote className="font-serif text-xl leading-relaxed text-card-foreground text-pretty sm:text-2xl sm:leading-relaxed">
        <Link
          href={`/quotes/${quote.id}`}
          className="rounded-sm outline-none decoration-primary/50 underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {quote.text}
        </Link>
      </blockquote>

      {(quote.author || quote.sourceTitle) && (
        <p className="mt-4 text-sm text-muted-foreground">
          <span aria-hidden>— </span>
          {quote.author && <span className="font-medium text-foreground/80">{quote.author}</span>}
          {quote.author && quote.sourceTitle && ", "}
          {quote.sourceTitle && (
            <Link
              href={bookHref(quote.sourceTitle)}
              className="font-serif italic underline-offset-4 hover:text-primary hover:underline"
            >
              {quote.sourceTitle}
            </Link>
          )}
        </p>
      )}

      <footer className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/60 pt-4 text-xs text-muted-foreground">
        <PostedBadge count={quote.postingCount} />
        {posted && (
          <>
            <Metric value={quote.totalLikes} label="likes" />
            {quote.maxLikes !== null && <Metric value={quote.maxLikes} label="best" />}
            <Metric value={quote.totalComments} label="comments" />
            {lastPosted && quote.lastPostedAt && (
              <span className="whitespace-nowrap sm:ml-auto">
                Last posted <time dateTime={quote.lastPostedAt}>{lastPosted}</time>
              </span>
            )}
          </>
        )}
      </footer>
    </article>
  );
}
