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

/** The book page (`/books/:id`) when the id is known, else a books search by title. */
export function bookHref(title: string, id?: number | null): string {
  if (id != null) return `/books/${id}`;
  return `/books?q=${encodeURIComponent(title)}`;
}
