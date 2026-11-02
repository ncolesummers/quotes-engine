import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "wouter";
import { useDebouncedValue } from "@/hooks/use-debounced-value";

/**
 * A search box bound to the `?q=` URL param. The URL is the source of truth; the input keeps
 * a local draft so typing stays responsive, and the draft is written back to the URL (with
 * `replace`, so keystrokes don't pile up history) after it settles for `delayMs`.
 */
export function useUrlSearch(delayMs: number) {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";

  const [draft, setDraft] = useState(q);
  const debounced = useDebouncedValue(draft.trim(), delayMs);
  const lastWritten = useRef(q);
  const lastDebounced = useRef(debounced);

  // Draft settled -> URL. Only a new debounced value writes: when `q` changes from outside,
  // the stale draft must not undo it.
  useEffect(() => {
    if (debounced === lastDebounced.current) return;
    lastDebounced.current = debounced;
    if (debounced === q) return;
    lastWritten.current = debounced;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (debounced) next.set("q", debounced);
        else next.delete("q");
        return next;
      },
      { replace: true },
    );
  }, [debounced, q, setParams]);

  // URL changed elsewhere (back button, a link) -> draft.
  useEffect(() => {
    if (q !== lastWritten.current) {
      lastWritten.current = q;
      setDraft(q);
    }
  }, [q]);

  return { q, draft, setDraft };
}
