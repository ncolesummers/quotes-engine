import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
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

const linkKey = (l: { postId: number; quoteId: number }) => `${l.postId}-${l.quoteId}`;

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
  queryClient.invalidateQueries({ queryKey: queryKeys.authors });
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
  /**
   * The last confirm/reject/dismiss failure. Kept here rather than read from `mutation.error`,
   * which only tracks the latest call: an earlier failure would vanish once a later one passed.
   */
  const [actionError, setActionError] = useState<Error | null>(null);
  /** Links with a request in flight, so a double press doesn't send it twice. */
  const pendingLinks = useRef(new Set<string>());

  const resolveMutation = useMutation({
    mutationKey: REVIEW_MUTATION,
    mutationFn: ({ link, action }: { link: ReviewLink; action: ReviewAction }) =>
      resolveReviewLink(link.postId, link.quoteId, action),
    onMutate: ({ link }) => {
      setActionError(null);
      return removeOptimistically(
        queryClient,
        (q) => ({ ...q, links: q.links.filter((l) => !sameLink(l, link)) }),
        -1,
      );
    },
    onError: (error) => setActionError(error),
    // Hook-level callbacks run for every call; ones passed to `mutate` only for the latest.
    onSettled: (_data, _error, { link }) => {
      pendingLinks.current.delete(linkKey(link));
      refreshAfterReview(queryClient, [link.quoteId]);
    },
  });

  /** Confirm or reject `link`; ignored while a request for the same link is in flight. */
  const resolve = (link: ReviewLink, action: ReviewAction) => {
    const key = linkKey(link);
    if (pendingLinks.current.has(key)) return;
    pendingLinks.current.add(key);
    resolveMutation.mutate({ link, action });
  };

  const dismissMutation = useMutation({
    mutationKey: REVIEW_MUTATION,
    mutationFn: (pair: DuplicatePair) => dismissDuplicate(pair.a.id, pair.b.id),
    onMutate: (pair) => {
      setActionError(null);
      return removeOptimistically(queryClient, (q) => ({
        ...q,
        duplicates: q.duplicates.filter((p) => !samePair(p, pair)),
      }));
    },
    onError: (error) => setActionError(error),
    onSettled: () => refreshAfterReview(queryClient, []),
  });

  // Merge and edit share the review mutation key so their refetches wait for in-flight
  // confirms/rejects/dismissals too, and vice versa.
  const mergeMutation = useMutation({
    mutationKey: REVIEW_MUTATION,
    mutationFn: ({ keepId, dropId }: { keepId: number; dropId: number }) =>
      mergeQuote(keepId, dropId),
    onSuccess: async (detail, { keepId, dropId }) => {
      const kept = {
        id: keepId,
        text: detail.quote.text,
        author: detail.quote.author,
        sourceTitle: detail.quote.sourceTitle,
      };
      await removeOptimistically(queryClient, (q) => ({
        // The server moves the dropped quote's links onto the kept one, unless the kept quote
        // is already on that post.
        links: q.links.flatMap((l) => {
          if (l.quoteId !== dropId) return [l];
          if (q.links.some((o) => o.postId === l.postId && o.quoteId === keepId)) return [];
          return [{ ...l, quoteId: keepId, quote: kept }];
        }),
        duplicates: q.duplicates.filter((p) => p.a.id !== dropId && p.b.id !== dropId),
      }));
      queryClient.setQueryData(queryKeys.quotes.detail(keepId), detail);
      queryClient.removeQueries({ queryKey: queryKeys.quotes.detail(dropId) });
    },
    onSettled: (_data, _error, { keepId }) => refreshAfterReview(queryClient, [keepId]),
  });

  /** Merge `dropId` into `keepId`; pairs involving the dropped quote leave the queue. */
  const merge = (keepId: number, dropId: number) => mergeMutation.mutateAsync({ keepId, dropId });

  const editMutation = useMutation({
    mutationKey: REVIEW_MUTATION,
    mutationFn: ({ quoteId, patch }: { quoteId: number; patch: QuotePatch }) =>
      updateQuote(quoteId, patch),
    onSuccess: (quote, { quoteId }) => {
      const fields = { text: quote.text, author: quote.author, sourceTitle: quote.sourceTitle };
      const patchSide = <T extends { id: number }>(side: T): T =>
        side.id === quoteId ? { ...side, ...fields } : side;
      queryClient.setQueryData<ReviewQueue>(queryKeys.review, (q) =>
        q
          ? {
              links: q.links.map((l) =>
                l.quoteId === quoteId ? { ...l, quote: { ...l.quote, ...fields } } : l,
              ),
              duplicates: q.duplicates.map((p) => ({ ...p, a: patchSide(p.a), b: patchSide(p.b) })),
            }
          : q,
      );
    },
    onSettled: (_data, _error, { quoteId }) => refreshAfterReview(queryClient, [quoteId]),
  });

  /** PATCH a quote and show the change everywhere it is queued. */
  const editQuote = (quoteId: number, patch: QuotePatch) =>
    editMutation.mutateAsync({ quoteId, patch });

  return { query, resolve, dismiss: dismissMutation.mutate, merge, editQuote, actionError };
}
