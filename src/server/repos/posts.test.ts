import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { createTestDb } from "../../../test/helpers/db";
import { getPost, listUnextractedPosts, markExtracted, recordMetrics, upsertPost } from "./posts";

let db: Database;

beforeEach(() => {
  db = createTestDb();
});

describe("upsertPost", () => {
  test("inserts a new post and returns it", () => {
    const post = upsertPost(db, {
      igMediaId: "ig1",
      permalink: "https://instagram.com/p/1",
      caption: "Hello",
      mediaType: "IMAGE",
      postedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(post.id).toBeGreaterThan(0);
    expect(post.igMediaId).toBe("ig1");
    expect(post.caption).toBe("Hello");
    expect(post.postedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(post.likeCount).toBeNull();
    expect(post.extractedAt).toBeNull();
  });

  test("updates an existing post by ig_media_id without erasing omitted fields", () => {
    const first = upsertPost(db, { igMediaId: "ig1", caption: "Old", permalink: "p1" });
    const second = upsertPost(db, { igMediaId: "ig1", caption: "New" });
    expect(second.id).toBe(first.id);
    expect(second.caption).toBe("New");
    expect(second.permalink).toBe("p1");
    expect(db.query("SELECT COUNT(*) AS n FROM posts").get()).toEqual({ n: 1 });
  });

  test("stores postedAt as canonical UTC ISO-8601 and rejects invalid timestamps", () => {
    // Instagram's API returns offsets like +0000; mixed formats would break text ordering.
    const post = upsertPost(db, { igMediaId: "ig1", postedAt: "2026-01-01T02:00:00+0200" });
    expect(post.postedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(() => upsertPost(db, { igMediaId: "ig2", postedAt: "not a date" })).toThrow();
  });
});

describe("recordMetrics", () => {
  test("compares capturedAt chronologically regardless of input precision", () => {
    const post = upsertPost(db, { igMediaId: "ig1" });
    recordMetrics(db, post.id, 15, 3, "2026-01-01T00:00:00.500Z");
    recordMetrics(db, post.id, 10, 2, "2026-01-01T00:00:00Z");
    expect(getPost(db, post.id)?.likeCount).toBe(15);
    expect(getPost(db, post.id)?.metricsUpdatedAt).toBe("2026-01-01T00:00:00.500Z");
  });

  test("updates the post's counts and inserts a snapshot", () => {
    const post = upsertPost(db, { igMediaId: "ig1" });
    recordMetrics(db, post.id, 10, 2, "2026-01-01T00:00:00.000Z");
    recordMetrics(db, post.id, 15, 3, "2026-01-02T00:00:00.000Z");

    const updated = getPost(db, post.id);
    expect(updated?.likeCount).toBe(15);
    expect(updated?.commentsCount).toBe(3);
    expect(updated?.metricsUpdatedAt).toBe("2026-01-02T00:00:00.000Z");

    const snaps = db
      .query("SELECT likes, comments, captured_at FROM metric_snapshots ORDER BY captured_at")
      .all();
    expect(snaps).toEqual([
      { likes: 10, comments: 2, captured_at: "2026-01-01T00:00:00.000Z" },
      { likes: 15, comments: 3, captured_at: "2026-01-02T00:00:00.000Z" },
    ]);
  });

  test("an older snapshot does not overwrite newer current counts", () => {
    const post = upsertPost(db, { igMediaId: "ig1" });
    recordMetrics(db, post.id, 15, 3, "2026-01-02T00:00:00.000Z");
    recordMetrics(db, post.id, 10, 2, "2026-01-01T00:00:00.000Z");
    expect(getPost(db, post.id)?.likeCount).toBe(15);
    expect(db.query("SELECT COUNT(*) AS n FROM metric_snapshots").get()).toEqual({ n: 2 });
  });
});

describe("listUnextractedPosts / markExtracted", () => {
  test("lists posts without extracted_at, oldest first, and markExtracted removes them", () => {
    const a = upsertPost(db, { igMediaId: "a", postedAt: "2026-01-02T00:00:00.000Z" });
    const b = upsertPost(db, { igMediaId: "b", postedAt: "2026-01-01T00:00:00.000Z" });
    expect(listUnextractedPosts(db).map((p) => p.id)).toEqual([b.id, a.id]);

    markExtracted(db, b.id, "2026-02-01T00:00:00.000Z");
    expect(listUnextractedPosts(db).map((p) => p.id)).toEqual([a.id]);
    expect(getPost(db, b.id)?.extractedAt).toBe("2026-02-01T00:00:00.000Z");
  });
});
