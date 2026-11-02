import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon, MergeIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  ApiError,
  conflictIdOf,
  fetchQuoteDetail,
  mergeQuote,
  type QuoteDetail,
  type QuotePatch,
  updateQuote,
} from "@/api";
import { InlineEdit } from "@/components/InlineEdit";
import { MergeQuoteDialog } from "@/components/MergeQuoteDialog";
import { PostedBadge } from "@/components/PostedBadge";
import { PostingsComparison } from "@/components/PostingsComparison";
import { PostingsTimeline } from "@/components/PostingsTimeline";
import { QuoteHighlights } from "@/components/QuoteHighlights";
import { Button } from "@/components/ui/button";
import { sortPostings, toChartData } from "@/lib/chart-data";
import { bookHref } from "@/lib/format";
import { queryKeys } from "@/lib/query";

export const DUPLICATE_TEXT_MESSAGE = "Another quote already has this text — merge instead?";

/** A positive integer id from the route, or null. */
function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const isNotFound = (err: unknown) => err instanceof ApiError && err.status === 404;

function NotFound() {
  return (
    <div className="flex flex-col items-start gap-3 py-10">
      <h1 className="font-serif text-3xl font-medium tracking-tight">Quote not found</h1>
      <p className="text-muted-foreground">
        It may have been merged into another quote, or never existed.
      </p>
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-primary underline-offset-4 hover:underline"
      >
        <ArrowLeftIcon aria-hidden className="size-4" />
        Back to search
      </Link>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading quote"
      className="flex animate-pulse flex-col gap-6 py-6"
    >
      <div className="h-3 w-24 rounded bg-muted" />
      <div className="flex flex-col gap-3">
        <div className="h-8 w-full rounded bg-muted" />
        <div className="h-8 w-10/12 rounded bg-muted" />
        <div className="h-8 w-7/12 rounded bg-muted" />
      </div>
      <div className="h-4 w-1/3 rounded bg-muted" />
      <div className="mt-6 h-28 rounded-xl bg-muted" />
      <div className="h-28 rounded-xl bg-muted" />
    </div>
  );
}

export function QuoteDetailPage({ id: rawId }: { id: string }) {
  const id = parseId(rawId);
  const queryClient = useQueryClient();
  const headingId = useId();
  const postingsHeadingId = useId();
  const [merge, setMerge] = useState<{ open: boolean; query: string; preselectId?: number }>({
    open: false,
    query: "",
  });

  const query = useQuery({
    queryKey: queryKeys.quotes.detail(id ?? 0),
    queryFn: () => fetchQuoteDetail(id as number),
    enabled: id !== null,
  });

  const postings = useMemo(() => sortPostings(query.data?.postings ?? []), [query.data]);
  const chartData = useMemo(() => toChartData(postings), [postings]);

  if (id === null || isNotFound(query.error)) return <NotFound />;
  if (query.isPending) return <DetailSkeleton />;
  // A failed background refetch keeps the loaded data; only show the error when there is none.
  if (query.data === undefined) {
    return (
      <div
        role="alert"
        className="my-8 rounded-xl border border-destructive/40 bg-destructive/5 px-6 py-8 text-center"
      >
        <p className="font-serif text-lg">This quote couldn’t be loaded.</p>
        <p className="mt-1 text-sm text-muted-foreground">{query.error?.message}</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={() => query.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const { quote, highlights } = query.data;
  const detailKey = queryKeys.quotes.detail(id);

  const refreshLists = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.quotes.searches });
    queryClient.invalidateQueries({ queryKey: queryKeys.stats });
  };

  const save = (field: keyof QuotePatch) => async (value: string | null) => {
    const updated = await updateQuote(id, { [field]: value });
    queryClient.setQueryData<QuoteDetail>(detailKey, (prev) =>
      prev ? { ...prev, quote: updated } : prev,
    );
    refreshLists();
  };

  const onMerge = async (dropId: number) => {
    const detail = await mergeQuote(id, dropId);
    queryClient.setQueryData(detailKey, detail);
    queryClient.removeQueries({ queryKey: queryKeys.quotes.detail(dropId) });
    refreshLists();
    return detail;
  };

  return (
    <div className="flex flex-col gap-14 py-4">
      <article aria-labelledby={headingId} className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1
            id={headingId}
            className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase"
          >
            Quote <span className="tabular-nums">#{quote.id}</span>
          </h1>
          <PostedBadge count={postings.length} />
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => setMerge({ open: true, query: "" })}
          >
            <MergeIcon aria-hidden />
            Merge with…
          </Button>
        </div>

        <figure className="flex flex-col gap-5">
          <blockquote className="relative font-serif text-3xl leading-snug font-normal tracking-tight text-pretty sm:text-4xl sm:leading-snug">
            <span
              aria-hidden
              className="pointer-events-none absolute -top-6 -left-2 font-serif text-7xl leading-none text-primary/15 select-none sm:-left-8"
            >
              “
            </span>
            <InlineEdit
              noun="text"
              label="Quote text"
              value={quote.text}
              required
              multiline
              onSave={save("text")}
              inputClassName="font-serif text-xl leading-relaxed sm:text-2xl"
              renderError={(error, draft) =>
                error instanceof ApiError && error.status === 409 ? (
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1 font-sans">
                    {DUPLICATE_TEXT_MESSAGE}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setMerge({
                          open: true,
                          query: draft,
                          preselectId: conflictIdOf(error) ?? undefined,
                        })
                      }
                    >
                      Merge instead
                    </Button>
                  </span>
                ) : (
                  <span className="font-sans">{error.message}</span>
                )
              }
            >
              {(text) => <span>{text}</span>}
            </InlineEdit>
          </blockquote>

          <figcaption className="flex flex-wrap items-baseline gap-x-2 gap-y-2 text-base text-muted-foreground">
            <span aria-hidden>—</span>
            <InlineEdit noun="author" label="Author" value={quote.author} onSave={save("author")}>
              {(author) => <span className="font-medium text-foreground/85">{author}</span>}
            </InlineEdit>
            <span aria-hidden className="text-muted-foreground/50">
              ·
            </span>
            <InlineEdit
              noun="book"
              label="Book"
              value={quote.sourceTitle}
              onSave={save("sourceTitle")}
            >
              {(title) => (
                <Link
                  href={bookHref(title)}
                  className="font-serif italic underline-offset-4 hover:text-primary hover:underline"
                >
                  {title}
                </Link>
              )}
            </InlineEdit>
          </figcaption>
        </figure>

        <div className="border-l-2 border-border pl-4 text-sm text-muted-foreground">
          <InlineEdit
            noun="notes"
            label="Notes"
            value={quote.notes}
            multiline
            onSave={save("notes")}
            placeholder="Context, where it came from, why you posted it…"
          >
            {(notes) => <span className="whitespace-pre-line text-foreground/80">{notes}</span>}
          </InlineEdit>
        </div>
      </article>

      <section aria-labelledby={postingsHeadingId} className="flex flex-col gap-4">
        <h2 id={postingsHeadingId} className="font-serif text-2xl font-medium tracking-tight">
          Every time it was posted
        </h2>
        {postings.length === 0 ? (
          <p className="rounded-xl border border-dashed px-6 py-8 text-center font-serif italic text-muted-foreground">
            This quote hasn’t been posted yet.
          </p>
        ) : (
          <PostingsTimeline postings={postings} />
        )}
      </section>

      {postings.length >= 2 && <PostingsComparison data={chartData} />}

      {highlights.length > 0 && <QuoteHighlights highlights={highlights} />}

      <MergeQuoteDialog
        open={merge.open}
        onOpenChange={(open) => setMerge((m) => ({ ...m, open }))}
        keepId={id}
        initialQuery={merge.query}
        preselectId={merge.preselectId}
        onMerge={onMerge}
      />
    </div>
  );
}
