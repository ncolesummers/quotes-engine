import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/** Copies `text` to the clipboard; reads "Copied" for two seconds afterwards. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (e.g. insecure context); the text stays selectable.
    }
  };

  return (
    <Button variant="ghost" size="sm" onClick={copy} className="h-7 gap-1.5 px-2 text-xs">
      {copied ? (
        <CheckIcon aria-hidden className="size-3.5 text-primary" />
      ) : (
        <CopyIcon aria-hidden className="size-3.5" />
      )}
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </Button>
  );
}
