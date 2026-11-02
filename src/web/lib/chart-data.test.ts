import { describe, expect, test } from "bun:test";
import { postingItem } from "../../../test/helpers/web";
import { formatDelta, sortPostings, toChartData } from "./chart-data";

describe("toChartData", () => {
  test("one point per posting, in order, with likes, comments and delta vs. the first", () => {
    const data = toChartData([
      postingItem({ postId: 10, postedAt: "2025-01-05T12:00:00.000Z", likes: 100, comments: 10 }),
      postingItem({ postId: 11, postedAt: "2025-06-01T12:00:00.000Z", likes: 150, comments: 4 }),
      postingItem({ postId: 12, postedAt: "2026-02-10T12:00:00.000Z", likes: 80, comments: 10 }),
    ]);

    expect(data).toEqual([
      {
        postId: 10,
        label: "#1",
        date: "Jan 5, 2025",
        axisLabel: "#1 · Jan 5, 2025",
        likes: 100,
        comments: 10,
        likesDelta: 0,
        commentsDelta: 0,
        likesDeltaPct: 0,
        commentsDeltaPct: 0,
      },
      {
        postId: 11,
        label: "#2",
        date: "Jun 1, 2025",
        axisLabel: "#2 · Jun 1, 2025",
        likes: 150,
        comments: 4,
        likesDelta: 50,
        commentsDelta: -6,
        likesDeltaPct: 50,
        commentsDeltaPct: -60,
      },
      {
        postId: 12,
        label: "#3",
        date: "Feb 10, 2026",
        axisLabel: "#3 · Feb 10, 2026",
        likes: 80,
        comments: 10,
        likesDelta: -20,
        commentsDelta: 0,
        likesDeltaPct: -20,
        commentsDeltaPct: 0,
      },
    ]);
  });

  test("missing metrics stay null, and so do their deltas", () => {
    const [first, second] = toChartData([
      postingItem({ postId: 1, likes: null, comments: 5 }),
      postingItem({ postId: 2, likes: 40, comments: null }),
    ]);
    expect(first?.likes).toBeNull();
    expect(second?.likes).toBe(40);
    expect(second?.likesDelta).toBeNull();
    expect(second?.likesDeltaPct).toBeNull();
    expect(second?.comments).toBeNull();
    expect(second?.commentsDelta).toBeNull();
  });

  test("a zero baseline gives an absolute delta but no percentage", () => {
    const [, second] = toChartData([
      postingItem({ postId: 1, likes: 0, comments: 0 }),
      postingItem({ postId: 2, likes: 12, comments: 3 }),
    ]);
    expect(second?.likesDelta).toBe(12);
    expect(second?.likesDeltaPct).toBeNull();
  });

  test("an undated posting gets an em dash for its date", () => {
    const [point] = toChartData([postingItem({ postedAt: null })]);
    expect(point?.date).toBe("—");
  });

  test("an empty list gives an empty series", () => {
    expect(toChartData([])).toEqual([]);
  });
});

describe("formatDelta", () => {
  test("signs the change and adds a percentage when there is one", () => {
    expect(formatDelta(50, 50)).toBe("+50 (+50%)");
    expect(formatDelta(-6, -60)).toBe("−6 (−60%)");
    expect(formatDelta(1200, null)).toBe("+1,200");
    expect(formatDelta(0, 0)).toBe("±0");
    expect(formatDelta(null, null)).toBe("—");
  });

  test("rounds percentages to whole numbers", () => {
    expect(formatDelta(1, 33.3333)).toBe("+1 (+33%)");
  });

  test("a non-zero change under 1% is not shown as ±0%", () => {
    expect(formatDelta(1, 0.1)).toBe("+1 (+<1%)");
    expect(formatDelta(-1, -0.1)).toBe("−1 (−<1%)");
  });
});

describe("sortPostings", () => {
  test("orders oldest first, undated last, without mutating the input", () => {
    const input = [
      postingItem({ postId: 3, postedAt: null }),
      postingItem({ postId: 2, postedAt: "2026-01-01T00:00:00.000Z" }),
      postingItem({ postId: 1, postedAt: "2025-01-01T00:00:00.000Z" }),
    ];
    expect(sortPostings(input).map((p) => p.postId)).toEqual([1, 2, 3]);
    expect(input.map((p) => p.postId)).toEqual([3, 2, 1]);
  });
});
