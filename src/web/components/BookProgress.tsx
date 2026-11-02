import type { BookSummary } from "@/api";
import { Progress } from "@/components/ui/progress";
import { formatDate, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

function plural(n: number, one: string, many: string): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

/** "12 quotes · 7 pics · last posted Oct 25, 2026" (the date only once something is posted). */
export function bookStatsLine(book: BookSummary): string {
  const parts = [
    plural(book.quoteCount, "quote", "quotes"),
    plural(book.postedCount, "pic", "pics"),
  ];
  const last = formatDate(book.lastPostedAt);
  if (last) parts.push(`last posted ${last}`);
  return parts.join(" · ");
}

/** Everything that could become a pic: the book's quotes plus its unposted highlights. */
export function bookTotal(book: BookSummary): number {
  return book.quoteCount + book.unpostedHighlightCount;
}

/** Posted vs. total, as a thin oxblood bar. */
export function BookProgress({ book, className }: { book: BookSummary; className?: string }) {
  const total = bookTotal(book);
  return (
    <Progress
      value={book.postedCount}
      max={Math.max(total, 1)}
      aria-valuemax={total}
      aria-label={`${formatNumber(book.postedCount)} of ${formatNumber(total)} posted`}
      className={cn("h-1.5 bg-muted", className)}
    />
  );
}
