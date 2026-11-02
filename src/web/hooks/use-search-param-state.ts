import { useCallback } from "react";
import { useSearchParams } from "wouter";

/** New values for URL params; null, undefined and "" delete the key. */
export type ParamPatch = Record<string, string | null | undefined>;

/** A copy of `prev` with `patch` applied (keys not in `patch` are kept). */
export function applyParamPatch(prev: URLSearchParams, patch: ParamPatch): URLSearchParams {
  const next = new URLSearchParams(prev);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === "") next.delete(key);
    else next.set(key, value);
  }
  return next;
}

/**
 * The URL search params plus a patcher that writes several at once. Writes use `replace`, so
 * toggling filters adds no history entries.
 */
export function useSearchParamState(): [URLSearchParams, (patch: ParamPatch) => void] {
  const [params, setParams] = useSearchParams();
  const patch = useCallback(
    (p: ParamPatch) => setParams((prev) => applyParamPatch(prev, p), { replace: true }),
    [setParams],
  );
  return [params, patch];
}

/** One URL param: its value (null when absent) and a setter (null deletes it). */
export function useSearchParam(key: string): [string | null, (value: string | null) => void] {
  const [params, patch] = useSearchParamState();
  const set = useCallback((value: string | null) => patch({ [key]: value }), [key, patch]);
  return [params.get(key), set];
}
