import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { createTestDb } from "../../../test/helpers/db";
import { recordMetrics, upsertPost } from "./posts";
import {
  getQuoteDetail,
  linkPostQuote,
  mergeQuotes,
  type SearchQuotesParams,
  searchQuotes,
  upsertQuote,
} from "./quotes";

let db: Database;

beforeEach(() => {
  db = createTestDb();
});

const CONFIRMED = { method: "caption", confidence: 1, status: "confirmed" } as const;

function countQuotes(): number {
  return (db.query("SELECT COUNT(*) AS n FROM quotes").get() as { n: number }).n;
}

function post(igMediaId: string, likes: number, comments: number, postedAt: string): number {
  const p = upsertPost(db, { igMediaId, postedAt });
  recordMetrics(db, p.id, likes, comments, postedAt);
  return p.id;
}

function addHighlight(quoteId: number, bookTitle: string | null = null): void {
  const book = db
    .query<{ id: number }, { title: string | null }>(
      "INSERT INTO books (asset_id, title) VALUES (lower(hex(randomblob(8))), $title) RETURNING id",
    )
    .get({ title: bookTitle });
  db.query(
    "INSERT INTO highlights (annotation_uuid, book_id, text, quote_id) VALUES (lower(hex(randomblob(8))), $bookId, 'x', $quoteId)",
  ).run({ bookId: book?.id ?? null, quoteId });
}

function search(params: Partial<SearchQuotesParams> = {}) {
  return searchQuotes(db, { sort: "recent", limit: 50, offset: 0, ...params });
}

describe("upsertQuote", () => {
  test("creates a new quote", () => {
    const res = upsertQuote(db, {
      text: "The obstacle is the way.",
      author: "Marcus Aurelius",
      sourceTitle: "Meditations",
    });
    expect(res.match).toBe("new");
    expect(res.candidateId).toBeUndefined();
    expect(res.quote.id).toBeGreaterThan(0);
    expect(res.quote.text).toBe("The obstacle is the way.");
    expect(res.quote.normalizedText).toBe("the obstacle is the way");
    expect(res.quote.author).toBe("Marcus Aurelius");
    expect(res.quote.sourceTitle).toBe("Meditations");
  });

  test("an exact duplicate with different punctuation returns the existing quote", () => {
    const first = upsertQuote(db, { text: "The obstacle is the way." });
    const second = upsertQuote(db, { text: "“The obstacle, is the way!”" });
    expect(second.match).toBe("existing");
    expect(second.quote.id).toBe(first.quote.id);
    expect(countQuotes()).toBe(1);
  });

  test("an existing match fills in a missing author and source", () => {
    const first = upsertQuote(db, { text: "The obstacle is the way." });
    const second = upsertQuote(db, {
      text: "The obstacle is the way",
      author: "Marcus Aurelius",
      sourceTitle: "Meditations",
    });
    expect(second.quote.id).toBe(first.quote.id);
    expect(second.quote.author).toBe("Marcus Aurelius");
    expect(second.quote.sourceTitle).toBe("Meditations");
  });

  test("a typo variant is created but reported as likely with candidateId", () => {
    const original = upsertQuote(db, {
      text: "Waste no more time arguing about what a good man should be. Be one.",
    });
    const typo = upsertQuote(db, {
      text: "Waste no more time arguing about what a good man shoud be. Be one.",
    });
    expect(typo.match).toBe("likely");
    expect(typo.candidateId).toBe(original.quote.id);
    expect(typo.quote.id).not.toBe(original.quote.id);
    expect(countQuotes()).toBe(2);
  });

  test("an unrelated quote is new with no candidate", () => {
    upsertQuote(db, { text: "Waste no more time arguing about what a good man should be." });
    const res = upsertQuote(db, { text: "You have power over your mind, not outside events." });
    expect(res.match).toBe("new");
    expect(res.candidateId).toBeUndefined();
  });

  test("rejects text that normalizes to nothing", () => {
    expect(() => upsertQuote(db, { text: "  ... #quote " })).toThrow();
  });
});

describe("linkPostQuote", () => {
  test("is idempotent", () => {
    const q = upsertQuote(db, { text: "A quote" }).quote;
    const p = upsertPost(db, { igMediaId: "ig1" });
    linkPostQuote(db, p.id, q.id, CONFIRMED);
    linkPostQuote(db, p.id, q.id, CONFIRMED);
    expect(db.query("SELECT COUNT(*) AS n FROM post_quotes").get()).toEqual({ n: 1 });
  });

  test("does not overwrite an existing link's status", () => {
    const q = upsertQuote(db, { text: "A quote" }).quote;
    const p = upsertPost(db, { igMediaId: "ig1" });
    linkPostQuote(db, p.id, q.id, { method: "manual", confidence: 1, status: "confirmed" });
    linkPostQuote(db, p.id, q.id, { method: "image", confidence: 0.6, status: "needs_review" });
    expect(db.query("SELECT method, status FROM post_quotes").get()).toEqual({
      method: "manual",
      status: "confirmed",
    });
  });
});

describe("searchQuotes", () => {
  let reposted: number;
  let single: number;
  let unposted: number;

  beforeEach(() => {
    reposted = upsertQuote(db, {
      text: "The obstacle is the way.",
      author: "Marcus Aurelius",
      sourceTitle: "Meditations",
    }).quote.id;
    single = upsertQuote(db, {
      text: "We suffer more often in imagination than in reality.",
      author: "Seneca",
      sourceTitle: "Letters from a Stoic",
    }).quote.id;
    unposted = upsertQuote(db, {
      text: "No man is free who is not master of himself.",
      author: "Epictetus",
    }).quote.id;

    const p1 = post("p1", 100, 5, "2026-01-01T00:00:00.000Z");
    const p2 = post("p2", 50, 20, "2026-03-01T00:00:00.000Z");
    const p3 = post("p3", 120, 1, "2026-02-01T00:00:00.000Z");
    linkPostQuote(db, p1, reposted, CONFIRMED);
    linkPostQuote(db, p2, reposted, CONFIRMED);
    linkPostQuote(db, p3, single, CONFIRMED);
  });

  test("the same quote on two posts aggregates postings and likes", () => {
    const row = search().items.find((r) => r.id === reposted);
    expect(row).toMatchObject({
      postingCount: 2,
      totalLikes: 150,
      maxLikes: 100,
      totalComments: 25,
      lastPostedAt: "2026-03-01T00:00:00.000Z",
    });
  });

  test("an unposted quote has zero aggregates", () => {
    const row = search().items.find((r) => r.id === unposted);
    expect(row).toMatchObject({
      postingCount: 0,
      totalLikes: 0,
      maxLikes: null,
      totalComments: 0,
      lastPostedAt: null,
    });
  });

  test("returns the total count alongside the page", () => {
    const res = search({ limit: 1 });
    expect(res.items).toHaveLength(1);
    expect(res.total).toBe(3);
    expect(search({ limit: 1, offset: 1 }).items[0]?.id).not.toBe(res.items[0]?.id);
  });

  test("search by a word uses FTS", () => {
    expect(search({ q: "imagination" }).items.map((r) => r.id)).toEqual([single]);
    expect(search({ q: "IMAGIN" }).items.map((r) => r.id)).toEqual([single]);
  });

  test("search by author", () => {
    expect(search({ author: "seneca" }).items.map((r) => r.id)).toEqual([single]);
  });

  test("author and book filters treat % and _ literally", () => {
    expect(search({ author: "_" }).items).toEqual([]);
    expect(search({ book: "%" }).items).toEqual([]);
    const pct = upsertQuote(db, { text: "Give it all.", sourceTitle: "100% Effort" }).quote.id;
    expect(search({ book: "0%" }).items.map((r) => r.id)).toEqual([pct]);
  });

  test("search by book matches source title or a linked highlight's book", () => {
    expect(search({ book: "meditations" }).items.map((r) => r.id)).toEqual([reposted]);

    addHighlight(unposted, "Discourses");
    expect(search({ book: "discourses" }).items.map((r) => r.id)).toEqual([unposted]);
  });

  test("posted: 'no' and 'yes'", () => {
    expect(search({ posted: "no" }).items.map((r) => r.id)).toEqual([unposted]);
    expect(
      search({ posted: "yes" })
        .items.map((r) => r.id)
        .sort(),
    ).toEqual([reposted, single].sort());
  });

  test("minPostings: 2", () => {
    expect(search({ minPostings: 2 }).items.map((r) => r.id)).toEqual([reposted]);
  });

  test("sort orders", () => {
    const ids = (sort: SearchQuotesParams["sort"]) => search({ sort }).items.map((r) => r.id);
    expect(ids("likes")).toEqual([reposted, single, unposted]);
    expect(ids("comments")).toEqual([reposted, single, unposted]);
    expect(ids("postings")).toEqual([reposted, single, unposted]);
    expect(ids("recent")).toEqual([reposted, single, unposted]);

    // single (p3, Feb) becomes the most recent posting once reposted's March post is unlinked.
    db.query("DELETE FROM posts WHERE ig_media_id = 'p2'").run();
    expect(ids("recent")).toEqual([single, reposted, unposted]);
    expect(ids("likes")).toEqual([single, reposted, unposted]);
  });

  test("FTS queries containing quotes or operators don't throw", () => {
    for (const q of [
      '"',
      '"unbalanced',
      "obstacle AND",
      "OR",
      "NOT way",
      "a* b^ (c",
      "NEAR(x y)",
      "col:obstacle",
      "-way",
      "   ",
      "''",
    ]) {
      expect(() => search({ q })).not.toThrow();
    }
    expect(search({ q: '"obstacle"' }).items.map((r) => r.id)).toEqual([reposted]);
    expect(search({ q: "obstacle AND" }).items.map((r) => r.id)).toEqual([]);
  });
});

describe("getQuoteDetail", () => {
  test("returns the quote with postings ordered by posted_at", () => {
    const q = upsertQuote(db, { text: "The obstacle is the way." }).quote;
    const late = post("late", 7, 1, "2026-03-01T00:00:00.000Z");
    const early = post("early", 3, 2, "2026-01-01T00:00:00.000Z");
    linkPostQuote(db, late, q.id, CONFIRMED);
    linkPostQuote(db, early, q.id, { method: "image", confidence: 0.8, status: "needs_review" });

    const detail = getQuoteDetail(db, q.id);
    expect(detail?.quote.id).toBe(q.id);
    expect(detail?.postings).toEqual([
      expect.objectContaining({
        postId: early,
        igMediaId: "early",
        postedAt: "2026-01-01T00:00:00.000Z",
        likes: 3,
        comments: 2,
        method: "image",
        confidence: 0.8,
        status: "needs_review",
      }),
      expect.objectContaining({ postId: late, likes: 7, comments: 1, status: "confirmed" }),
    ]);
  });

  test("returns null for a missing quote", () => {
    expect(getQuoteDetail(db, 999)).toBeNull();
  });
});

describe("mergeQuotes", () => {
  test("keeps all postings and highlights, then deletes the dropped quote", () => {
    const keep = upsertQuote(db, { text: "Waste no more time arguing. Be one." }).quote;
    const drop = upsertQuote(db, {
      text: "Waste no more time argueing. Be one.",
      author: "Marcus Aurelius",
    }).quote;
    const p1 = post("p1", 10, 1, "2026-01-01T00:00:00.000Z");
    const p2 = post("p2", 20, 2, "2026-02-01T00:00:00.000Z");
    const p3 = post("p3", 30, 3, "2026-03-01T00:00:00.000Z");
    linkPostQuote(db, p1, keep.id, CONFIRMED);
    linkPostQuote(db, p2, drop.id, CONFIRMED);
    linkPostQuote(db, p3, keep.id, CONFIRMED);
    linkPostQuote(db, p3, drop.id, CONFIRMED); // shared post must not collide

    addHighlight(drop.id);

    const merged = mergeQuotes(db, keep.id, drop.id);

    expect(merged.id).toBe(keep.id);
    expect(merged.author).toBe("Marcus Aurelius");
    expect(getQuoteDetail(db, drop.id)).toBeNull();
    expect(
      getQuoteDetail(db, keep.id)
        ?.postings.map((p) => p.postId)
        .sort(),
    ).toEqual([p1, p2, p3].sort());
    expect(db.query("SELECT quote_id FROM highlights").get()).toEqual({ quote_id: keep.id });
    expect(search().items.find((r) => r.id === keep.id)?.postingCount).toBe(3);
  });

  test("rejects merging a quote into itself or a missing quote", () => {
    const q = upsertQuote(db, { text: "A quote" }).quote;
    expect(() => mergeQuotes(db, q.id, q.id)).toThrow();
    expect(() => mergeQuotes(db, q.id, 999)).toThrow();
  });
});
