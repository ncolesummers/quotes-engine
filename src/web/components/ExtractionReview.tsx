import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  XIcon,
} from "lucide-react";
import { type Ref, useRef } from "react";
import { ApiError, conflictIdOf, type LinkMethod, type QuotePatch, type ReviewLink } from "@/api";
import { InlineEdit, type InlineEditHandle } from "@/components/InlineEdit";
import { PostThumbnail } from "@/components/PostThumbnail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";

const METHOD_LABEL: Record<LinkMethod, string> = {
  image: "Read from the image",
  caption: "Matched in the caption",
  manual: "Linked by hand",
};

export function Kbd({ children }: { children: string }) {
  return (
    <kbd
      aria-hidden
      className="ml-1 hidden rounded border border-current/25 px-1 font-sans text-[0.7rem] leading-4 opacity-70 sm:inline-block"
    >
      {children}
    </kbd>
  );
}

export interface ExtractionReviewProps {
  link: ReviewLink;
  position: number;
  total: number;
  onConfirm: () => void;
  onReject: () => void;
  onPrev: () => void;
  onNext: () => void;
  onEdit: (patch: QuotePatch) => Promise<unknown>;
  /** Fold this link's quote into the existing quote its corrected text collided with. */
  onMergeInto: (conflictId: number) => Promise<unknown>;
  /** Exposes the text editor so the `e` shortcut can open it. */
  editRef?: Ref<InlineEditHandle>;
}

/** One `needs_review` link: the post's image, large, beside the quote read from it. */
export function ExtractionReview({
  link,
  position,
  total,
  onConfirm,
  onReject,
  onPrev,
  onNext,
  onEdit,
  onMergeInto,
  editRef,
}: ExtractionReviewProps) {
  const { post, quote } = link;
  const date = formatDate(post.postedAt);
  const save = (field: keyof QuotePatch) => (value: string | null) => onEdit({ [field]: value });
  const merging = useRef(false);

  return (
    <article
      aria-label={`Review post ${post.id}`}
      className="flex flex-col gap-6 rounded-xl border border-border/70 bg-card p-4 shadow-xs sm:p-6 lg:-mx-28"
    >
      <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span className="tabular-nums">
          {position} of {total}
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

      <div className="grid gap-6 md:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] md:gap-8">
        <figure className="flex flex-col gap-2">
          {post.mediaUrl ? (
            <a href={post.mediaUrl} target="_blank" rel="noreferrer" title="Open full size">
              <PostThumbnail
                mediaUrl={post.mediaUrl}
                date={date}
                className="size-auto min-h-64 w-full sm:size-auto sm:w-full"
              />
            </a>
          ) : (
            <PostThumbnail
              mediaUrl={null}
              date={date}
              className="aspect-square size-auto w-full sm:size-auto"
            />
          )}
          <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {date && <span>{date}</span>}
            {post.permalink && (
              <a
                href={post.permalink}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 underline-offset-4 hover:text-primary hover:underline"
              >
                View on Instagram
                <ExternalLinkIcon aria-hidden className="size-3" />
              </a>
            )}
          </figcaption>
        </figure>

        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {METHOD_LABEL[link.method]}
            </Badge>
            {link.confidence !== null && (
              <Badge
                variant="outline"
                className="font-normal tabular-nums text-muted-foreground"
                title="How sure the extraction was"
              >
                {Math.round(link.confidence * 100)}% confidence
              </Badge>
            )}
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              Quote #{quote.id}
            </span>
          </div>

          <blockquote className="font-serif text-2xl leading-snug tracking-tight text-pretty">
            <InlineEdit
              noun="text"
              label="Quote text"
              value={quote.text}
              required
              multiline
              editRef={editRef}
              onSave={save("text")}
              inputClassName="font-serif text-lg leading-relaxed"
              renderError={(error) => {
                const conflictId = conflictIdOf(error);
                if (!(error instanceof ApiError && error.status === 409 && conflictId)) {
                  return <span className="font-sans">{error.message}</span>;
                }
                return (
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1 font-sans">
                    Quote #{conflictId} already has this text.
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        if (merging.current) return;
                        merging.current = true;
                        try {
                          await onMergeInto(conflictId);
                        } finally {
                          merging.current = false;
                        }
                      }}
                    >
                      Merge into #{conflictId}
                    </Button>
                  </span>
                );
              }}
            >
              {(text) => <span>{text}</span>}
            </InlineEdit>
          </blockquote>

          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-2 text-sm text-muted-foreground">
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
              {(title) => <span className="font-serif italic">{title}</span>}
            </InlineEdit>
          </div>

          <section aria-label="Caption" className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
              Caption
            </h3>
            {post.caption ? (
              <p className="max-h-48 overflow-y-auto rounded-md bg-muted/50 px-3 py-2 text-sm whitespace-pre-line text-foreground/80">
                {post.caption}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground italic">No caption.</p>
            )}
          </section>

          <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
            <Button onClick={onConfirm} aria-keyshortcuts="c">
              <CheckIcon aria-hidden />
              Confirm
              <Kbd>c</Kbd>
            </Button>
            <Button variant="outline" onClick={onReject} aria-keyshortcuts="r">
              <XIcon aria-hidden />
              Reject
              <Kbd>r</Kbd>
            </Button>
            <span className="ml-auto text-xs text-muted-foreground">
              <kbd className="rounded border px-1 font-sans">e</kbd> fixes the text
            </span>
          </div>
        </div>
      </div>
    </article>
  );
}
