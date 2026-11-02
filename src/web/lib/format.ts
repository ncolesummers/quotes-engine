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

/** `/books?q=<title>` (until #25 adds book pages). */
export function bookHref(title: string): string {
  return `/books?q=${encodeURIComponent(title)}`;
}
