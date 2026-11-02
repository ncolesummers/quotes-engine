import type { Stats } from "@/api";
import { formatNumber } from "@/lib/format";

const ITEMS: { key: keyof Stats; label: string }[] = [
  { key: "quotes", label: "quotes" },
  { key: "posts", label: "posts" },
  { key: "repostedQuotes", label: "reposted" },
  { key: "highlightsBacklog", label: "highlights unposted" },
];

/** A quiet line of archive totals under the header. */
export function StatsStrip({
  stats,
  failed = false,
}: {
  stats: Stats | undefined;
  failed?: boolean;
}) {
  return (
    <section aria-label="Archive stats" className="text-xs text-muted-foreground">
      {stats ? (
        <ul className="flex flex-wrap gap-x-5 gap-y-1">
          {ITEMS.map(({ key, label }) => (
            <li key={key} className="whitespace-nowrap">
              <span className="font-medium text-foreground/80 tabular-nums">
                {formatNumber(stats[key])}
              </span>{" "}
              {label}
            </li>
          ))}
        </ul>
      ) : failed ? (
        <p>Stats unavailable</p>
      ) : (
        <div aria-hidden className="h-4 w-64 max-w-full animate-pulse rounded bg-muted" />
      )}
    </section>
  );
}
