import { useId } from "react";
import { Link } from "wouter";
import type { QuoteHighlight } from "@/api";
import { bookHref, formatDate } from "@/lib/format";

/** Apple Books highlights linked to the quote. */
export function QuoteHighlights({ highlights }: { highlights: QuoteHighlight[] }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2 id={headingId} className="font-serif text-2xl font-medium tracking-tight">
        Apple Books highlights
      </h2>
      <ul className="flex flex-col gap-4">
        {highlights.map((h) => {
          const date = formatDate(h.createdAt);
          return (
            <li
              key={h.id}
              className="rounded-xl border border-border/70 bg-card px-5 py-4 shadow-xs sm:px-6"
            >
              {h.text && (
                <blockquote className="border-l-2 border-primary/40 pl-4 font-serif text-lg leading-relaxed text-pretty">
                  {h.text}
                </blockquote>
              )}
              {h.note && (
                <p className="mt-3 text-sm text-muted-foreground">
                  <span className="sr-only">Note: </span>
                  <span className="italic">{h.note}</span>
                </p>
              )}
              <p className="mt-3 flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                {h.book.title ? (
                  <Link
                    href={bookHref(h.book.title)}
                    className="font-serif text-sm italic text-foreground/80 underline-offset-4 hover:text-primary hover:underline"
                  >
                    {h.book.title}
                  </Link>
                ) : (
                  <span className="font-serif text-sm italic">Untitled book</span>
                )}
                {h.book.author && <span>{h.book.author}</span>}
                {date && h.createdAt && (
                  <span className="sm:ml-auto">
                    Highlighted <time dateTime={h.createdAt}>{date}</time>
                  </span>
                )}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
