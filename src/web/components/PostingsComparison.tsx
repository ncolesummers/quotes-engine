import { useId } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer, ChartTooltip } from "@/components/ui/chart";
import { type ChartPoint, formatDelta } from "@/lib/chart-data";
import { formatNumber } from "@/lib/format";

const chartConfig = {
  likes: { label: "Likes", color: "var(--chart-1)" },
  comments: { label: "Comments", color: "var(--chart-2)" },
} satisfies ChartConfig;

function value(n: number | null): string {
  return n === null ? "—" : formatNumber(n);
}

function PointTooltip({ point, first }: { point: ChartPoint; first: boolean }) {
  return (
    <div className="grid min-w-44 gap-1.5 rounded-lg border border-border/60 bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium">Posting {point.label}</span>
        <span className="text-muted-foreground">{point.date}</span>
      </div>
      {(["likes", "comments"] as const).map((key) => (
        <div key={key} className="flex items-center gap-2">
          <span
            aria-hidden
            className="size-2.5 shrink-0 rounded-[2px]"
            style={{ background: `var(--color-${key})` }}
          />
          <span className="text-muted-foreground">{chartConfig[key].label}</span>
          <span className="ml-auto font-mono font-medium tabular-nums">{value(point[key])}</span>
          {!first && (
            <span className="w-20 text-right font-mono text-muted-foreground tabular-nums">
              {formatDelta(point[`${key}Delta`], point[`${key}DeltaPct`])}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Likes and comments per posting (bars), plus a table of each posting's change vs. the first.
 * The table doubles as the chart's accessible text alternative. Callers hide this for < 2
 * postings — there is nothing to compare.
 */
export function PostingsComparison({ data }: { data: ChartPoint[] }) {
  const headingId = useId();
  const firstId = data[0]?.postId;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="font-serif text-2xl font-medium tracking-tight">
          How the postings compared
        </h2>
        <p className="text-sm text-muted-foreground">
          Likes on the left axis, comments on the right
        </p>
      </div>

      <div className="rounded-xl border border-border/70 bg-card p-4 shadow-xs sm:p-6">
        <ChartContainer
          config={chartConfig}
          className="aspect-auto h-64 w-full"
          aria-hidden
          data-testid="comparison-chart"
        >
          <BarChart data={data} margin={{ top: 8, right: 4, left: 4, bottom: 0 }} barGap={4}>
            <CartesianGrid vertical={false} strokeDasharray="2 4" />
            <XAxis dataKey="axisLabel" tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis yAxisId="likes" tickLine={false} axisLine={false} width={44} />
            <YAxis
              yAxisId="comments"
              orientation="right"
              tickLine={false}
              axisLine={false}
              width={36}
            />
            <ChartTooltip
              cursor={{ fill: "var(--muted)", opacity: 0.5 }}
              content={({ active, payload }) => {
                const point = payload?.[0]?.payload as ChartPoint | undefined;
                return active && point ? (
                  <PointTooltip point={point} first={point.postId === firstId} />
                ) : null;
              }}
            />
            <Bar yAxisId="likes" dataKey="likes" fill="var(--color-likes)" radius={[3, 3, 0, 0]} />
            <Bar
              yAxisId="comments"
              dataKey="comments"
              fill="var(--color-comments)"
              radius={[3, 3, 0, 0]}
            />
          </BarChart>
        </ChartContainer>

        <div className="mt-3 flex items-center justify-center gap-5 text-xs text-muted-foreground">
          {(["likes", "comments"] as const).map((key) => (
            <span key={key} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="size-2.5 rounded-[2px]"
                style={{ background: chartConfig[key].color }}
              />
              {chartConfig[key].label}
            </span>
          ))}
        </div>

        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <caption className="sr-only">
              Likes and comments per posting, and change vs. the first
            </caption>
            <thead>
              <tr className="border-b border-border/70 text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-3 font-normal">
                  Posting
                </th>
                <th scope="col" className="py-2 pr-3 font-normal">
                  Date
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-normal">
                  Likes
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-normal">
                  Comments
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-normal">
                  Likes vs. #1
                </th>
                <th scope="col" className="py-2 text-right font-normal">
                  Comments vs. #1
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((p, i) => (
                <tr key={p.postId} className="border-b border-border/40 last:border-0">
                  <th scope="row" className="py-2 pr-3 text-left font-medium">
                    {p.label}
                  </th>
                  <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">{p.date}</td>
                  <td className="py-2 pr-3 text-right">{value(p.likes)}</td>
                  <td className="py-2 pr-3 text-right">{value(p.comments)}</td>
                  <DeltaCell first={i === 0} diff={p.likesDelta} pct={p.likesDeltaPct} pad />
                  <DeltaCell first={i === 0} diff={p.commentsDelta} pct={p.commentsDeltaPct} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function DeltaCell({
  first,
  diff,
  pct,
  pad = false,
}: {
  first: boolean;
  diff: number | null;
  pct: number | null;
  pad?: boolean;
}) {
  const tone =
    first || diff === null || diff === 0
      ? "text-muted-foreground"
      : diff > 0
        ? "text-emerald-700 dark:text-emerald-400"
        : "text-primary";
  return (
    <td className={`py-2 text-right whitespace-nowrap ${pad ? "pr-3" : ""} ${tone}`}>
      {first ? "—" : formatDelta(diff, pct)}
    </td>
  );
}
