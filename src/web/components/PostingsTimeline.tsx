import { ExternalLinkIcon, HeartIcon, MessageCircleIcon } from "lucide-react";
import type { LinkMethod, Posting } from "@/api";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PostThumbnail } from "./PostThumbnail";

const METHOD_LABEL: Record<LinkMethod, string> = {
  caption: "Caption",
  image: "Image",
  manual: "Manual",
};

const METHOD_TITLE: Record<LinkMethod, string> = {
  caption: "Matched from the post caption",
  image: "Read from the post image",
  manual: "Linked by hand",
};

function methodTitle(p: Posting): string {
  const base = METHOD_TITLE[p.method];
  return p.confidence === null ? base : `${base} · ${Math.round(p.confidence * 100)}% confidence`;
}

function Metric({
  value,
  label,
  icon: Icon,
}: {
  value: number | null;
  label: string;
  icon: typeof HeartIcon;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Icon aria-hidden className="size-3.5 text-muted-foreground/80" />
      <span className="font-medium text-foreground tabular-nums">
        {value === null ? "—" : formatNumber(value)}
      </span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

/** Every posting of the quote, oldest first, as a vertical timeline. */
export function PostingsTimeline({ postings }: { postings: Posting[] }) {
  return (
    <ol aria-label="Postings" className="relative flex flex-col gap-4">
      {postings.map((p, i) => {
        const date = formatDate(p.postedAt);
        const review = p.status === "needs_review";
        return (
          <li
            key={p.postId}
            data-status={p.status}
            className={cn(
              "relative flex gap-4 rounded-xl border bg-card p-4 shadow-xs sm:gap-5",
              review
                ? "border-amber-400/70 bg-amber-50/60 dark:border-amber-500/40 dark:bg-amber-950/20"
                : "border-border/70",
            )}
          >
            <PostThumbnail mediaUrl={p.mediaUrl} date={date} />
            <div className="flex min-w-0 flex-1 flex-col gap-2.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-serif text-sm text-muted-foreground italic">
                  {i === 0 ? "First posted" : `Repost ${i}`}
                </span>
                {p.postedAt && date ? (
                  <time dateTime={p.postedAt} className="font-serif text-lg font-medium">
                    {date}
                  </time>
                ) : (
                  <span className="font-serif text-lg text-muted-foreground">Undated</span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <Metric value={p.likes} label="likes" icon={HeartIcon} />
                <Metric value={p.comments} label="comments" icon={MessageCircleIcon} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" title={methodTitle(p)} className="font-normal">
                  {METHOD_LABEL[p.method]}
                </Badge>
                {review && (
                  <Badge
                    variant="outline"
                    className="border-amber-500/60 bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
                  >
                    Needs review
                  </Badge>
                )}
                {p.permalink && (
                  <a
                    href={p.permalink}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto inline-flex items-center gap-1 rounded-sm text-sm text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    Open on Instagram
                    <ExternalLinkIcon aria-hidden className="size-3.5" />
                  </a>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
