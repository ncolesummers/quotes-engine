import { ImageOffIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A post's downloaded image, or a placeholder when there is none. A media file missing on
 * disk 404s, so a load error also falls back to the placeholder instead of a broken image.
 */
export function PostThumbnail({
  mediaUrl,
  date,
  className,
}: {
  mediaUrl: string | null;
  /** Formatted posting date, for the alt text. */
  date: string | null;
  /** Size classes; defaults to the timeline's 80/96px square. */
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const frame = cn(
    "size-20 shrink-0 overflow-hidden rounded-md border border-border/70 bg-muted sm:size-24",
    className,
  );
  if (!mediaUrl || failed) {
    return (
      <div aria-hidden className={cn(frame, "flex items-center justify-center")}>
        <ImageOffIcon className="size-5 text-muted-foreground/60" />
      </div>
    );
  }
  return (
    <img
      src={mediaUrl}
      alt={date ? `Instagram post from ${date}` : "Instagram post"}
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn(frame, "object-cover")}
    />
  );
}
