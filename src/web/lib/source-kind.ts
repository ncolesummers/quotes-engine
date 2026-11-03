import type { SourceKind } from "@/api";

export interface SourceKindLabels {
  /** The selector option. */
  option: string;
  /** Field labels: who it is by, and what it is from. */
  author: string;
  source: string;
}

/** Per kind: for a song the author is the artist and the source the song (#42). */
export const SOURCE_KIND_LABELS: Record<SourceKind, SourceKindLabels> = {
  book: { option: "Book", author: "Author", source: "Book" },
  song: { option: "Song", author: "Artist", source: "Song" },
  other: { option: "Other", author: "Author", source: "Source" },
};

export const SOURCE_KINDS: SourceKind[] = ["book", "song", "other"];

/** The search page's Kind filter options (and chip labels). */
export const KIND_FILTER_LABEL: Record<SourceKind, string> = {
  book: "Books",
  song: "Songs",
  other: "Other",
};

/** A `?kind=` value, or null when absent or unknown. */
export function parseSourceKind(value: string | null | undefined): SourceKind | null {
  return SOURCE_KINDS.includes(value as SourceKind) ? (value as SourceKind) : null;
}
