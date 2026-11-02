import type { Posting } from "@/api";
import { formatDate, formatNumber } from "./format";

/** One bar group in the comparison chart: a posting's metrics and its change vs. the first. */
export interface ChartPoint {
  postId: number;
  /** "#1", "#2", ... in posting order. */
  label: string;
  /** Formatted posting date, or "—" when unknown. */
  date: string;
  /** X-axis tick: "#1 · Jan 5, 2025" (kept in the data so skipped ticks can't misalign). */
  axisLabel: string;
  likes: number | null;
  comments: number | null;
  /** Absolute change vs. the first posting; null when either value is missing. */
  likesDelta: number | null;
  commentsDelta: number | null;
  /** Percentage change vs. the first posting; null when missing or the baseline is 0. */
  likesDeltaPct: number | null;
  commentsDeltaPct: number | null;
}

/** Oldest first; undated postings last. Ties keep their input order. Does not mutate. */
export function sortPostings<T extends Pick<Posting, "postedAt">>(postings: readonly T[]): T[] {
  return [...postings].sort((a, b) => {
    if (a.postedAt === b.postedAt) return 0;
    if (a.postedAt === null) return 1;
    if (b.postedAt === null) return -1;
    return a.postedAt < b.postedAt ? -1 : 1;
  });
}

function delta(value: number | null, base: number | null): [number | null, number | null] {
  if (value === null || base === null) return [null, null];
  const diff = value - base;
  return [diff, base === 0 ? null : (diff / base) * 100];
}

/** The series passed to the comparison chart. Expects postings already in date order. */
export function toChartData(
  postings: readonly Pick<Posting, "postId" | "postedAt" | "likes" | "comments">[],
): ChartPoint[] {
  const first = postings[0];
  return postings.map((p, i) => {
    const [likesDelta, likesDeltaPct] = delta(p.likes, first?.likes ?? null);
    const [commentsDelta, commentsDeltaPct] = delta(p.comments, first?.comments ?? null);
    const label = `#${i + 1}`;
    const date = formatDate(p.postedAt) ?? "—";
    return {
      postId: p.postId,
      label,
      date,
      axisLabel: `${label} · ${date}`,
      likes: p.likes,
      comments: p.comments,
      likesDelta,
      commentsDelta,
      likesDeltaPct,
      commentsDeltaPct,
    };
  });
}

function signed(n: number, suffix = ""): string {
  if (n === 0) return `±0${suffix}`;
  return `${n > 0 ? "+" : "−"}${formatNumber(Math.abs(n))}${suffix}`;
}

/** "+50 (+50%)", "−6 (−60%)", "+1 (+<1%)", "+12" (no baseline %), "±0", or "—" when unknown. */
export function formatDelta(diff: number | null, pct: number | null): string {
  if (diff === null) return "—";
  if (diff === 0) return signed(0);
  if (pct === null) return signed(diff);
  const rounded = Math.round(pct);
  const pctText = rounded === 0 ? `${diff > 0 ? "+" : "−"}<1%` : signed(rounded, "%");
  return `${signed(diff)} (${pctText})`;
}
