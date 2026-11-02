import { useRef, useState } from "react";
import type { DuplicateQuote, ReviewAction, ReviewLink } from "@/api";
import { DuplicateReview } from "@/components/DuplicateReview";
import { ExtractionReview } from "@/components/ExtractionReview";
import type { InlineEditHandle } from "@/components/InlineEdit";
import { MergeQuoteDialog } from "@/components/MergeQuoteDialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useReviewQueue } from "@/hooks/use-review-queue";
import { useSearchParam } from "@/hooks/use-search-param-state";
import { useShortcuts } from "@/hooks/use-shortcuts";

type Tab = "extractions" | "duplicates";

/** `index` kept inside `0..length-1`; removing the current item lands on the next one. */
const clamp = (index: number, length: number) => Math.max(0, Math.min(index, length - 1));

function Empty({ children }: { children: string }) {
  return (
    <p className="rounded-xl border border-dashed px-6 py-12 text-center font-serif text-lg italic text-muted-foreground">
      {children}
    </p>
  );
}

function Count({ n }: { n: number | undefined }) {
  if (n === undefined) return null;
  return (
    <span className="rounded-full bg-muted px-1.5 text-xs leading-5 tabular-nums text-muted-foreground">
      {n}
    </span>
  );
}

export function ReviewPage() {
  const [tabParam, setTabParam] = useSearchParam("tab");
  const tab: Tab = tabParam === "duplicates" ? "duplicates" : "extractions";
  const setTab = (next: string) => setTabParam(next === "duplicates" ? next : null);

  const { query, resolve, dismiss, merge, editQuote, actionError } = useReviewQueue();
  const links = query.data?.links ?? [];
  const duplicates = query.data?.duplicates ?? [];

  const [linkIndex, setLinkIndex] = useState(0);
  const [pairIndex, setPairIndex] = useState(0);
  const li = clamp(linkIndex, links.length);
  const pi = clamp(pairIndex, duplicates.length);
  const link = links[li];
  const pair = duplicates[pi];

  const [keep, setKeep] = useState<{ keep: DuplicateQuote; drop: DuplicateQuote } | null>(null);
  const editRef = useRef<InlineEditHandle>(null);

  const act = (target: ReviewLink | undefined, action: ReviewAction) => {
    if (!target) return;
    setLinkIndex(li);
    resolve(target, action);
  };
  const notDuplicate = () => {
    if (!pair) return;
    setPairIndex(pi);
    dismiss(pair);
  };

  useShortcuts(
    tab === "extractions"
      ? {
          c: () => act(link, "confirm"),
          r: () => act(link, "reject"),
          e: () => editRef.current?.edit(),
          j: () => setLinkIndex(clamp(li + 1, links.length)),
          k: () => setLinkIndex(clamp(li - 1, links.length)),
        }
      : {
          n: notDuplicate,
          j: () => setPairIndex(clamp(pi + 1, duplicates.length)),
          k: () => setPairIndex(clamp(pi - 1, duplicates.length)),
        },
    query.data !== undefined,
  );

  return (
    <div className="flex flex-col gap-6 py-2">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-serif text-3xl font-medium tracking-tight">Review</h1>
        <p className="text-sm text-muted-foreground">
          Check what was read from each post against the image, and settle look-alike quotes.
        </p>
      </header>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="extractions">
            Extractions <Count n={query.data?.links.length} />
          </TabsTrigger>
          <TabsTrigger value="duplicates">
            Duplicates <Count n={query.data?.duplicates.length} />
          </TabsTrigger>
        </TabsList>

        {actionError && (
          <p
            role="alert"
            className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {actionError.message}
          </p>
        )}

        {query.isPending ? (
          <div
            role="status"
            aria-label="Loading review queue"
            className="mt-2 h-96 animate-pulse rounded-xl bg-muted"
          />
        ) : query.data === undefined ? (
          <div
            role="alert"
            className="mt-2 rounded-xl border border-destructive/40 bg-destructive/5 px-6 py-8 text-center"
          >
            <p className="font-serif text-lg">The review queue couldn’t be loaded.</p>
            <p className="mt-1 text-sm text-muted-foreground">{query.error?.message}</p>
            <Button variant="outline" size="sm" className="mt-4" onClick={() => query.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <>
            <TabsContent value="extractions" className="mt-2">
              {link ? (
                <ExtractionReview
                  key={`${link.postId}-${link.quoteId}`}
                  link={link}
                  position={li + 1}
                  total={links.length}
                  editRef={editRef}
                  onConfirm={() => act(link, "confirm")}
                  onReject={() => act(link, "reject")}
                  onPrev={() => setLinkIndex(clamp(li - 1, links.length))}
                  onNext={() => setLinkIndex(clamp(li + 1, links.length))}
                  onEdit={(patch) => editQuote(link.quoteId, patch)}
                  onMergeInto={(conflictId) => merge(conflictId, link.quoteId)}
                />
              ) : (
                <Empty>Nothing to review — every extraction has been checked.</Empty>
              )}
            </TabsContent>
            <TabsContent value="duplicates" className="mt-2">
              {pair ? (
                <DuplicateReview
                  key={`${pair.a.id}-${pair.b.id}`}
                  pair={pair}
                  position={pi + 1}
                  total={duplicates.length}
                  onPrev={() => setPairIndex(clamp(pi - 1, duplicates.length))}
                  onNext={() => setPairIndex(clamp(pi + 1, duplicates.length))}
                  onKeep={(k, drop) => setKeep({ keep: k, drop })}
                  onDismiss={notDuplicate}
                />
              ) : (
                <Empty>No likely duplicates left.</Empty>
              )}
            </TabsContent>
          </>
        )}
      </Tabs>

      {keep && (
        <MergeQuoteDialog
          open
          onOpenChange={(open) => !open && setKeep(null)}
          keepId={keep.keep.id}
          preselectId={keep.drop.id}
          onMerge={(dropId) => merge(keep.keep.id, dropId)}
        />
      )}
    </div>
  );
}
