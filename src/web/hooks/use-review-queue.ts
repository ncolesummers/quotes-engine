import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type DuplicatePair,
  dismissDuplicate,
  fetchReview,
  mergeQuote,
  type QuotePatch,
  type ReviewAction,
  type ReviewLink,
  type ReviewQueue,
  resolveReviewLink,
  type Stats,
  updateQuote,
} from "@/api";
import { queryKeys } from "@/lib/query";

/** Every review mutation shares this key, so refetches wait until the last one settles. */
const REVIEW_MUTATION = ["review"] as const;

const sameLink = (x: ReviewLink, y: { postId: number; quoteId: number }) =>
  x.postId === y.postId && x.quoteId === y.quoteId;

const samePair = (x: DuplicatePair, y: DuplicatePair) => x.a.id === y.a.id && x.b.id === y.b.id;

/**
 * Refetch the queue and everything a review action can change. While several actions are in
 * flight only the last to settle refetches, so an earlier response can't resurrect an item
 * that a later action already removed from the cache.
 */
function refreshAfterReview(queryClient: QueryClient, quoteIds: number[]) {
  for (const id of quoteIds) {
    queryClient.invalidateQueries({ queryKey: queryKeys.quotes.detail(id) });
  }
  queryClient.invalidateQueries({ queryKey: queryKeys.quotes.searches });
  queryClient.invalidateQueries({ queryKey: queryKeys.books.all });
  if (queryClient.isMutating({ mutationKey: REVIEW_MUTATION }) <= 1) {
    queryClient.invalidateQueries({ queryKey: queryKeys.review });
    queryClient.invalidateQueries({ queryKey: queryKeys.stats });
  }
}

/** Remove matching items from the cached queue (and adjust the nav badge) right away. */
async function removeOptimistically(
  queryClient: QueryClient,
  update: (queue: ReviewQueue) => ReviewQueue,
  needsReviewDelta = 0,
) {
  await queryClient.cancelQueries({ queryKey: queryKeys.review });
  await queryClient.cancelQueries({ queryKey: queryKeys.stats });
  queryClient.setQueryData<ReviewQueue>(queryKeys.review, (q) => (q ? update(q) : q));
  if (needsReviewDelta !== 0) {
    queryClient.setQueryData<Stats>(queryKeys.stats, (s) =>
      s ? { ...s, needsReview: Math.max(0, s.needsReview + needsReviewDelta) } : s,
    );
  }
}

/** The review queue plus its actions; every action updates the queue and badge immediately. */
export function useReviewQueue() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: queryKeys.review, queryFn: fetchReview });

  const resolve = useMutation({
    mutationKey: REVIEW_MUTATION,
    mutationFn: ({ link, action }: { link: ReviewLink; action: ReviewAction }) =>
      resolveReviewLink(link.postId, link.quoteId, action),
    onMutate: ({ link }) =>
      removeOptimistically(
        queryClient,
        (q) => ({ ...q, links: q.links.filter((l) => !sameLink(l, link)) }),
        -1,
      ),
    onSettled: (_data, _error, { link }) => refreshAfterReview(queryClient, [link.quoteId]),
  });

  const dismiss = useMutation({
    mutationKey: REVIEW_MUTATION,
    mutationFn: (pair: DuplicatePair) => dismissDuplicate(pair.a.id, pair.b.id),
    onMutate: (pair) =>
      removeOptimistically(queryClient, (q) => ({
        ...q,
        duplicates: q.duplicates.filter((p) => !samePair(p, pair)),
      })),
    onSettled: () => refreshAfterReview(queryClient, []),
  });

  /** Merge `dropId` into `keepId`; pairs involving the dropped quote leave the queue. */
  const merge = async (keepId: number, dropId: number) => {
    const detail = await mergeQuote(keepId, dropId);
    await removeOptimistically(queryClient, (q) => ({
      ...q,
      duplicates: q.duplicates.filter((p) => p.a.id !== dropId && p.b.id !== dropId),
    }));
    queryClient.setQueryData(queryKeys.quotes.detail(keepId), detail);
    queryClient.removeQueries({ queryKey: queryKeys.quotes.detail(dropId) });
    refreshAfterReview(queryClient, [keepId]);
    return detail;
  };

  /** PATCH a quote and show the change on every queued link to it. */
  const editQuote = async (quoteId: number, patch: QuotePatch) => {
    const quote = await updateQuote(quoteId, patch);
    const fields = { text: quote.text, author: quote.author, sourceTitle: quote.sourceTitle };
    queryClient.setQueryData<ReviewQueue>(queryKeys.review, (q) =>
      q
        ? {
            ...q,
            links: q.links.map((l) =>
              l.quoteId === quoteId ? { ...l, quote: { ...l.quote, ...fields } } : l,
            ),
          }
        : q,
    );
    refreshAfterReview(queryClient, [quoteId]);
    return quote;
  };

  return { query, resolve, dismiss, merge, editQuote };
}
