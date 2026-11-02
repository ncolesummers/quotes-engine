const numberFormat = new Intl.NumberFormat("en-US");
const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function formatNumber(n: number): string {
  return numberFormat.format(n);
}

/** "Mar 5, 2026" from an ISO-8601 UTC string; null for missing/invalid input. */
export function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : dateFormat.format(date);
}

/** `<Author>, <Title>`, leaving out whichever is missing or blank ("" when both are). */
export function formatAttribution(book: { title: string | null; author: string | null }): string {
  return [book.author, book.title]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join(", ");
}

/** `“<text>” — <Author>, <Title>`, leaving out whichever of author and title is missing. */
export function formatHighlightCopy({
  text,
  book,
}: {
  text: string;
  book: { title: string | null; author: string | null };
}): string {
  const attribution = formatAttribution(book);
  const quoted = `“${text.trim()}”`;
  return attribution ? `${quoted} — ${attribution}` : quoted;
}

/** The book page (`/books/:id`) when the id is known, else a books search by title. */
export function bookHref(title: string, id?: number | null): string {
  if (id != null) return `/books/${id}`;
  return `/books?q=${encodeURIComponent(title)}`;
}
