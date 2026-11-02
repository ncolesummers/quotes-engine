import { useEffect, useRef } from "react";

/** True when keys pressed in `target` are text entry (inputs, textareas, editable content). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return !["button", "checkbox", "radio", "range", "reset", "submit", "color", "file"].includes(
    type,
  );
}

/**
 * Single-key shortcuts on `window`, e.g. `{ j: next, k: prev }`. Ignored while typing, with a
 * modifier held, while a modal dialog is open, or when something already handled the key.
 */
export function useShortcuts(bindings: Record<string, () => void>, enabled = true): void {
  const latest = useRef(bindings);
  latest.current = bindings;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.isComposing) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      const action = latest.current[e.key];
      if (!action) return;
      e.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
