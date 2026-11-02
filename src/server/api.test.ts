import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Server, serve } from "bun";
import { createTestDb } from "../../test/helpers/db";
import { type Seeder, seed } from "../../test/helpers/seed";
import { createRoutes } from "./api";

let server: Server<undefined>;
let db: Database;
let s: Seeder;
let root: string;
let mediaDir: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "quotes-api-"));
  mediaDir = join(root, "media");
  mkdirSync(join(mediaDir, "sub"), { recursive: true });
  writeFileSync(join(mediaDir, "a.jpg"), "JPEGDATA");
  writeFileSync(join(mediaDir, "sub", "b c.png"), "PNGDATA");
  writeFileSync(join(root, "secret.txt"), "SECRET");
  mkdirSync(join(root, "outside"));
  writeFileSync(join(root, "outside", "secret.txt"), "SECRET");
  symlinkSync(join(root, "secret.txt"), join(mediaDir, "link.txt"));
  symlinkSync(join(root, "outside"), join(mediaDir, "linkdir"));
  server = serve({ port: 0, hostname: "127.0.0.1", routes: createRoutes(createTestDb()) });
});

afterAll(async () => {
  await server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  db = createTestDb();
  s = seed(db);
  server.reload({ routes: createRoutes(db, { mediaDir }) });
});

function url(path: string): string {
  return `${server.url.origin}${path}`;
}

async function get(path: string) {
  const res = await fetch(url(path));
  return { status: res.status, body: await res.json() };
}

async function send(method: string, path: string, body: unknown) {
  const res = await fetch(url(path), {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function expectError(r: { status: number; body: unknown }, status: number) {
  expect(r.status).toBe(status);
  expect(r.body).toEqual({ error: expect.any(String) });
}

describe("GET /api/quotes", () => {
  test("returns { items, total } with filters, sort and paging", async () => {
    const a = s.quote({ text: "Stay hungry, stay foolish", author: "Steve Jobs" });
    const b = s.quote({ text: "The obstacle is the way", author: "Marcus Aurelius" });
    s.quote({ text: "Never posted words", author: "Nobody" });
    s.posting(a.id, { likes: 10, comments: 1 });
    s.posting(b.id, { likes: 50, comments: 2 });
    s.posting(b.id, { likes: 5, comments: 0 });

    const all = await get("/api/quotes?sort=likes");
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(3);
    expect(all.body.items.map((q: { id: number }) => q.id).slice(0, 2)).toEqual([b.id, a.id]);
    expect(all.body.items[0]).toMatchObject({
      id: b.id,
      text: "The obstacle is the way",
      author: "Marcus Aurelius",
      postingCount: 2,
      totalLikes: 55,
    });

    const posted = await get("/api/quotes?posted=yes&minPostings=2");
    expect(posted.body.total).toBe(1);
    expect(posted.body.items[0].id).toBe(b.id);

    const search = await get("/api/quotes?q=hungry");
    expect(search.body.items.map((q: { id: number }) => q.id)).toEqual([a.id]);

    const byAuthor = await get("/api/quotes?author=marcus");
    expect(byAuthor.body.items.map((q: { id: number }) => q.id)).toEqual([b.id]);

    const page = await get("/api/quotes?limit=1&offset=1&sort=likes");
    expect(page.body.total).toBe(3);
    expect(page.body.items.map((q: { id: number }) => q.id)).toEqual([a.id]);
  });

  test("defaults: sort=recent, limit=50", async () => {
    for (let i = 0; i < 55; i++) s.quote({ text: `quote number ${i} words` });
    const r = await get("/api/quotes");
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(55);
    expect(r.body.items).toHaveLength(50);
  });

  test.each([
    "sort=bogus",
    "posted=maybe",
    "limit=0",
    "limit=1000",
    "limit=abc",
    "offset=-1",
    "minPostings=1.5",
    "bookId=0",
    "bookId=abc",
  ])("400 on bad param %s", async (qs) => {
    expectError(await get(`/api/quotes?${qs}`), 400);
  });

  test("?bookId= filters by the exact linked book", async () => {
    const dune = s.book({ assetId: null, title: "Dune", author: "Frank Herbert" });
    const messiah = s.book({ assetId: null, title: "Dune Messiah", author: "Frank Herbert" });
    const a = s.quote({ text: "Fear is the mind-killer" });
    const b = s.quote({ text: "Power over spice" });
    db.run(`UPDATE quotes SET book_id = ${dune.id} WHERE id = ${a.id}`);
    db.run(`UPDATE quotes SET book_id = ${messiah.id} WHERE id = ${b.id}`);

    const r = await get(`/api/quotes?bookId=${dune.id}`);
    expect(r.status).toBe(200);
    expect(r.body.items.map((q: { id: number }) => q.id)).toEqual([a.id]);
    expect(r.body.total).toBe(1);
  });
});

describe("GET /api/authors", () => {
  test("returns distinct authors with quote counts, by name", async () => {
    s.quote({ text: "one", author: "Robin Hobb" });
    s.quote({ text: "two", author: "Robin Hobb" });
    s.quote({ text: "three", author: "Ken Liu" });
    s.quote({ text: "anonymous", author: null });

    const r = await get("/api/authors");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      items: [
        { name: "Ken Liu", quoteCount: 1 },
        { name: "Robin Hobb", quoteCount: 2 },
      ],
    });
  });

  test("an empty archive returns no authors", async () => {
    expect((await get("/api/authors")).body).toEqual({ items: [] });
  });
});

describe("GET /api/quotes/:id", () => {
  test("returns quote, postings with media urls, and linked highlights", async () => {
    const q = s.quote({ text: "Be here now", author: "Ram Dass" });
    const p = s.posting(q.id, {
      permalink: "https://instagram.com/p/x",
      mediaPath: "sub/b c.png",
      postedAt: "2026-02-01T00:00:00.000Z",
      likes: 7,
      comments: 3,
    });
    s.posting(q.id, { postedAt: "2026-03-01T00:00:00.000Z" });
    const book = s.book({ title: "Be Here Now", author: "Ram Dass" });
    const h = s.highlight({ bookId: book.id, text: "Be here now.", quoteId: q.id });

    const r = await get(`/api/quotes/${q.id}`);
    expect(r.status).toBe(200);
    expect(r.body.quote).toMatchObject({ id: q.id, text: "Be here now", author: "Ram Dass" });
    expect(r.body.postings).toHaveLength(2);
    expect(r.body.postings[0]).toMatchObject({
      postId: p.id,
      permalink: "https://instagram.com/p/x",
      likes: 7,
      comments: 3,
      mediaUrl: "/media/sub/b%20c.png",
    });
    expect(r.body.postings[1].mediaUrl).toBeNull();
    expect(r.body.highlights).toEqual([
      {
        id: h.id,
        text: "Be here now.",
        note: null,
        location: null,
        createdAt: null,
        book: { id: book.id, title: "Be Here Now", author: "Ram Dass" },
      },
    ]);
  });

  test("404 on unknown id", async () => {
    expectError(await get("/api/quotes/999"), 404);
  });

  test("400 on non-numeric id", async () => {
    expectError(await get("/api/quotes/abc"), 400);
  });
});

describe("PATCH /api/quotes/:id", () => {
  test("updates fields and recomputes normalized_text", async () => {
    const q = s.quote({ text: "old text here", author: "A" });
    const r = await send("PATCH", `/api/quotes/${q.id}`, {
      text: "  New Text, here!  ",
      author: null,
      sourceTitle: "Book",
      notes: "note",
    });
    expect(r.status).toBe(200);
    expect(r.body.quote).toMatchObject({
      id: q.id,
      text: "New Text, here!",
      normalizedText: "new text here",
      author: null,
      sourceTitle: "Book",
      notes: "note",
    });
    const searched = await get("/api/quotes?q=new");
    expect(searched.body.total).toBe(1);
  });

  test("partial update leaves other fields alone", async () => {
    const q = s.quote({ text: "keep me", author: "A", sourceTitle: "S" });
    const r = await send("PATCH", `/api/quotes/${q.id}`, { notes: "n" });
    expect(r.status).toBe(200);
    expect(r.body.quote).toMatchObject({
      text: "keep me",
      author: "A",
      sourceTitle: "S",
      notes: "n",
    });
  });

  test("409 when the new text collides with another quote", async () => {
    const taken = s.quote({ text: "taken text" });
    const q = s.quote({ text: "other" });
    const r = await send("PATCH", `/api/quotes/${q.id}`, { text: "Taken, text!" });
    expect(r.status).toBe(409);
    // The client opens the merge dialog on this quote, so the id is part of the body.
    expect(r.body).toEqual({ error: expect.any(String), conflictId: taken.id });
  });

  test("editing a quote to its own normalized text is not a conflict", async () => {
    const q = s.quote({ text: "same words" });
    const r = await send("PATCH", `/api/quotes/${q.id}`, { text: "Same words." });
    expect(r.status).toBe(200);
    expect(r.body.quote.text).toBe("Same words.");
  });

  test.each([
    ["unknown field", { bogus: 1 }],
    ["empty body", {}],
    ["empty text", { text: "   " }],
    ["text that normalizes to nothing", { text: "!!! #tag" }],
    ["wrong type", { author: 5 }],
  ])("400 on %s", async (_name, body) => {
    const q = s.quote({ text: "x y z" });
    expectError(await send("PATCH", `/api/quotes/${q.id}`, body), 400);
  });

  test("400 on invalid JSON", async () => {
    const q = s.quote({ text: "x y z" });
    expectError(await send("PATCH", `/api/quotes/${q.id}`, "{nope"), 400);
  });

  test("404 on unknown id", async () => {
    expectError(await send("PATCH", "/api/quotes/999", { notes: "x" }), 404);
  });
});

describe("POST /api/quotes/:id/merge", () => {
  test("merges dropId into id and returns the kept quote's detail", async () => {
    const keep = s.quote({ text: "keep this quote" });
    const drop = s.quote({ text: "keep this quote now", author: "Someone" });
    s.posting(drop.id);
    const r = await send("POST", `/api/quotes/${keep.id}/merge`, { dropId: drop.id });
    expect(r.status).toBe(200);
    expect(r.body.quote).toMatchObject({ id: keep.id, author: "Someone" });
    expect(r.body.postings).toHaveLength(1);
    expect(r.body.highlights).toEqual([]);
    expectError(await get(`/api/quotes/${drop.id}`), 404);
  });

  test("400 on missing or self dropId", async () => {
    const q = s.quote({ text: "a b c" });
    expectError(await send("POST", `/api/quotes/${q.id}/merge`, {}), 400);
    expectError(await send("POST", `/api/quotes/${q.id}/merge`, { dropId: q.id }), 400);
  });

  test("404 when either quote is unknown", async () => {
    const q = s.quote({ text: "a b c" });
    expectError(await send("POST", `/api/quotes/${q.id}/merge`, { dropId: 999 }), 404);
    expectError(await send("POST", `/api/quotes/999/merge`, { dropId: q.id }), 404);
  });
});

describe("GET /api/highlights", () => {
  function fixture() {
    const book1 = s.book({ title: "Meditations", author: "Marcus Aurelius" });
    const book2 = s.book({ title: "Walden", author: "Thoreau" });
    const posted = s.quote({ text: "posted one" });
    s.posting(posted.id);
    const unpostedQuote = s.quote({ text: "linked but unposted" });
    const h1 = s.highlight({
      bookId: book1.id,
      text: "You have power over your mind",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const h2 = s.highlight({
      bookId: book1.id,
      text: "posted one",
      quoteId: posted.id,
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    const h3 = s.highlight({
      bookId: book2.id,
      text: "linked but unposted",
      note: "go to the woods",
      quoteId: unpostedQuote.id,
      createdAt: "2026-01-03T00:00:00.000Z",
    });
    return { book1, book2, h1, h2, h3 };
  }

  test("lists highlights with book info, newest first", async () => {
    const { book1, h1, h2, h3 } = fixture();
    const r = await get("/api/highlights");
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(3);
    expect(r.body.items.map((h: { id: number }) => h.id)).toEqual([h3.id, h2.id, h1.id]);
    expect(r.body.items[2]).toEqual({
      id: h1.id,
      annotationUuid: h1.annotationUuid,
      text: "You have power over your mind",
      note: null,
      location: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      quoteId: null,
      posted: false,
      book: {
        id: book1.id,
        assetId: book1.assetId,
        title: "Meditations",
        author: "Marcus Aurelius",
      },
    });
    expect(r.body.items[1].posted).toBe(true);
  });

  test("filters by unposted, book and q", async () => {
    const { h1, h3 } = fixture();
    const unposted = await get("/api/highlights?unposted=1");
    expect(unposted.body.items.map((h: { id: number }) => h.id)).toEqual([h3.id, h1.id]);
    const book = await get("/api/highlights?book=medit");
    expect(book.body.total).toBe(2);
    const q = await get("/api/highlights?q=woods");
    expect(q.body.items.map((h: { id: number }) => h.id)).toEqual([h3.id]);
    const page = await get("/api/highlights?limit=1&offset=1");
    expect(page.body.total).toBe(3);
    expect(page.body.items).toHaveLength(1);
  });

  test("filters by exact bookId, combined with unposted and q", async () => {
    const { book1, book2, h1, h2, h3 } = fixture();
    const one = await get(`/api/highlights?bookId=${book1.id}`);
    expect(one.body.total).toBe(2);
    expect(one.body.items.map((h: { id: number }) => h.id)).toEqual([h2.id, h1.id]);
    const unposted = await get(`/api/highlights?bookId=${book1.id}&unposted=1`);
    expect(unposted.body.items.map((h: { id: number }) => h.id)).toEqual([h1.id]);
    const q = await get(`/api/highlights?bookId=${book2.id}&q=woods`);
    expect(q.body.items.map((h: { id: number }) => h.id)).toEqual([h3.id]);
    const none = await get("/api/highlights?bookId=999");
    expect(none.body).toEqual({ items: [], total: 0 });
  });

  test.each(["unposted=yes", "limit=0", "offset=x", "bookId=0", "bookId=abc"])(
    "400 on bad param %s",
    async (qs) => {
      expectError(await get(`/api/highlights?${qs}`), 400);
    },
  );
});

describe("GET /api/highlights/books", () => {
  function fixture() {
    const older = s.book({ title: "Meditations", author: "Marcus Aurelius" });
    const newer = s.book({ title: "Walden", author: "Thoreau" });
    const empty = s.book({ title: "No highlights" });
    const posted = s.quote({ text: "posted one" });
    s.posting(posted.id);
    s.highlight({
      bookId: older.id,
      text: "power over your mind",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    s.highlight({
      bookId: older.id,
      text: "posted one",
      quoteId: posted.id,
      createdAt: "2026-01-05T00:00:00.000Z",
    });
    s.highlight({ bookId: older.id, text: "undated", createdAt: null });
    s.highlight({
      bookId: newer.id,
      text: "I went to the woods",
      note: "deliberately",
      createdAt: "2026-01-03T00:00:00.000Z",
    });
    return { older, newer, empty };
  }

  test("counts highlights per book, most recent highlight first", async () => {
    const { older, newer } = fixture();
    const r = await get("/api/highlights/books");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      total: 4,
      items: [
        {
          book: {
            id: older.id,
            assetId: older.assetId,
            title: "Meditations",
            author: "Marcus Aurelius",
          },
          count: 3,
          lastHighlightedAt: "2026-01-05T00:00:00.000Z",
        },
        {
          book: { id: newer.id, assetId: newer.assetId, title: "Walden", author: "Thoreau" },
          count: 1,
          lastHighlightedAt: "2026-01-03T00:00:00.000Z",
        },
      ],
    });
  });

  test("unposted and q narrow the counts (and the sort follows)", async () => {
    const { older, newer } = fixture();
    const unposted = await get("/api/highlights/books?unposted=1");
    expect(unposted.body.total).toBe(3);
    expect(
      unposted.body.items.map((g: { book: { id: number }; count: number }) => [g.book.id, g.count]),
    ).toEqual([
      [newer.id, 1],
      [older.id, 2],
    ]);
    expect(unposted.body.items[1].lastHighlightedAt).toBe("2026-01-01T00:00:00.000Z");

    const q = await get("/api/highlights/books?q=DELIBERATE");
    expect(q.body).toMatchObject({ total: 1, items: [{ book: { id: newer.id }, count: 1 }] });
  });

  test("400 on bad unposted", async () => {
    expectError(await get("/api/highlights/books?unposted=maybe"), 400);
  });
});

describe("review", () => {
  test("GET /api/review lists needs_review links and likely-duplicate pairs", async () => {
    const q1 = s.quote({ text: "the only way out is through the forest of doubt and fear" });
    const q2 = s.quote({ text: "The only way out is through the forest of doubt and fears." });
    const q3 = s.quote({ text: "something entirely different" });
    const confirmed = s.post({ caption: "c" });
    s.link(confirmed.id, q3.id);
    const pending = s.post({ caption: "pending caption", mediaPath: "a.jpg" });
    s.link(pending.id, q3.id, { method: "image", confidence: 0.6, status: "needs_review" });

    const r = await get("/api/review");
    expect(r.status).toBe(200);
    expect(r.body.links).toEqual([
      {
        postId: pending.id,
        quoteId: q3.id,
        method: "image",
        confidence: 0.6,
        post: {
          id: pending.id,
          igMediaId: pending.igMediaId,
          permalink: null,
          caption: "pending caption",
          postedAt: pending.postedAt,
          mediaUrl: "/media/a.jpg",
        },
        quote: { id: q3.id, text: q3.text, author: null, sourceTitle: null },
      },
    ]);
    expect(r.body.duplicates).toHaveLength(1);
    expect(r.body.duplicates[0]).toMatchObject({
      a: { id: q1.id, text: q1.text, postingCount: 0 },
      b: { id: q2.id, text: q2.text, postingCount: 0 },
    });
    expect(r.body.duplicates[0].score).toBeGreaterThanOrEqual(0.85);
    expect(r.body.duplicates[0].score).toBeLessThan(1);
  });

  test("confirm sets status to confirmed", async () => {
    const q = s.quote({ text: "a quote" });
    const p = s.posting(q.id, {}, { status: "needs_review" });
    const r = await send("POST", `/api/review/${p.id}/${q.id}`, { action: "confirm" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ postId: p.id, quoteId: q.id, action: "confirm" });
    const detail = await get(`/api/quotes/${q.id}`);
    expect(detail.body.postings[0].status).toBe("confirmed");
    expect((await get("/api/review")).body.links).toEqual([]);
  });

  test("reject deletes the link", async () => {
    const q = s.quote({ text: "a quote" });
    const p = s.posting(q.id, {}, { status: "needs_review" });
    const r = await send("POST", `/api/review/${p.id}/${q.id}`, { action: "reject" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ postId: p.id, quoteId: q.id, action: "reject" });
    const detail = await get(`/api/quotes/${q.id}`);
    expect(detail.body.postings).toEqual([]);
  });

  test("dismissed duplicate pairs don't come back", async () => {
    const q1 = s.quote({ text: "the only way out is through the forest of doubt and fear" });
    const q2 = s.quote({ text: "The only way out is through the forest of doubt and fears." });
    expect((await get("/api/review")).body.duplicates).toHaveLength(1);

    const r = await send("POST", "/api/review/duplicates/dismiss", { aId: q2.id, bId: q1.id });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ aId: q1.id, bId: q2.id });
    expect((await get("/api/review")).body.duplicates).toEqual([]);
    // Dismissing again is harmless.
    expect(
      (await send("POST", "/api/review/duplicates/dismiss", { aId: q1.id, bId: q2.id })).status,
    ).toBe(200);
    expect((await get("/api/review")).body.duplicates).toEqual([]);
  });

  test("dismiss: 400 on bad body or the same quote, 404 on an unknown quote", async () => {
    const q = s.quote({ text: "a quote" });
    const path = "/api/review/duplicates/dismiss";
    expectError(await send("POST", path, { aId: q.id }), 400);
    expectError(await send("POST", path, { aId: q.id, bId: "x" }), 400);
    expectError(await send("POST", path, { aId: q.id, bId: q.id }), 400);
    expectError(await send("POST", path, { aId: q.id, bId: 9999 }), 404);
  });

  test("400 on bad action or ids, 404 on unknown link", async () => {
    const q = s.quote({ text: "a quote" });
    const p = s.post();
    expectError(await send("POST", `/api/review/${p.id}/${q.id}`, { action: "maybe" }), 400);
    expectError(await send("POST", `/api/review/x/${q.id}`, { action: "confirm" }), 400);
    expectError(await send("POST", `/api/review/${p.id}/${q.id}`, { action: "confirm" }), 404);
  });
});

describe("GET /api/stats", () => {
  test("returns totals", async () => {
    const once = s.quote({ text: "posted once" });
    const twice = s.quote({ text: "posted twice" });
    s.quote({ text: "never posted" });
    s.posting(once.id);
    s.posting(twice.id);
    s.posting(twice.id, {}, { status: "needs_review" });
    const book = s.book();
    s.highlight({ bookId: book.id, text: "backlog 1" });
    s.highlight({ bookId: book.id, text: "backlog 2", quoteId: once.id });

    const r = await get("/api/stats");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      quotes: 3,
      posts: 3,
      repostedQuotes: 1,
      highlights: 2,
      highlightsBacklog: 1,
      needsReview: 1,
    });
  });
});

describe("cross-origin mutation guard", () => {
  test("403 when Origin is another site", async () => {
    const q = s.quote({ text: "guarded quote" });
    const res = await fetch(url(`/api/quotes/${q.id}`), {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ notes: "pwned" }),
    });
    expectError({ status: res.status, body: await res.json() }, 403);
    expect((await get(`/api/quotes/${q.id}`)).body.quote.notes).toBeNull();
  });

  test("415 when the body isn't sent as application/json", async () => {
    const q = s.quote({ text: "guarded quote" });
    const p = s.posting(q.id, {}, { status: "needs_review" });
    const res = await fetch(url(`/api/review/${p.id}/${q.id}`), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ action: "reject" }),
    });
    expectError({ status: res.status, body: await res.json() }, 415);
    expect((await get("/api/review")).body.links).toHaveLength(1);
  });

  test("allows a same-origin request", async () => {
    const q = s.quote({ text: "guarded quote" });
    const res = await fetch(url(`/api/quotes/${q.id}`), {
      method: "PATCH",
      headers: { "content-type": "application/json; charset=utf-8", origin: server.url.origin },
      body: JSON.stringify({ notes: "ok" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("GET /media/*", () => {
  test.each(["/media/link.txt", "/media/linkdir/secret.txt"])(
    "refuses symlinks escaping the media dir: %s",
    async (path) => {
      const res = await fetch(url(path));
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("SECRET");
    },
  );

  test("serves files from the media dir", async () => {
    const res = await fetch(url("/media/a.jpg"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("JPEGDATA");
    const nested = await fetch(url("/media/sub/b%20c.png"));
    expect(nested.status).toBe(200);
    expect(nested.headers.get("content-type")).toContain("image/png");
    expect(await nested.text()).toBe("PNGDATA");
  });

  test("404 on missing file or directory", async () => {
    expectError(await get("/media/nope.jpg"), 404);
    expectError(await get("/media/sub"), 404);
  });

  test.each([
    "/media/..%2Fsecret.txt",
    "/media/%2e%2e/secret.txt",
    "/media/sub/..%2F..%2Fsecret.txt",
    "/media/%2Fetc%2Fpasswd",
  ])("rejects traversal %s", async (path) => {
    const res = await fetch(url(path));
    expect([400, 403, 404]).toContain(res.status);
    expect(await res.text()).not.toContain("SECRET");
  });

  test("rejects a raw ../ request line", async () => {
    // fetch() normalizes "..", so send the request line by hand.
    let raw = "";
    const sock = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port as number,
      socket: {
        data(_sock, chunk) {
          raw += chunk.toString();
        },
      },
    });
    sock.write("GET /media/../secret.txt HTTP/1.1\r\nHost: x\r\n\r\n");
    for (let i = 0; i < 50 && !raw.includes("\r\n\r\n"); i++) await Bun.sleep(10);
    await Bun.sleep(20);
    sock.end();
    expect(raw).toStartWith("HTTP/1.1 403");
    expect(raw).not.toContain("SECRET");
  });
});

describe("books", () => {
  function linkBook(quoteId: number, bookId: number) {
    db.run(`UPDATE quotes SET book_id = ${bookId} WHERE id = ${quoteId}`);
  }

  function fixture() {
    const hobb = s.book({ assetId: "HOBB", title: "Fool's Errand", author: "Robin Hobb" });
    const dune = s.book({ title: "Dune", author: "Frank Herbert" });
    const reposted = s.quote({ text: "Hope is a dangerous thing", author: "Robin Hobb" });
    const once = s.quote({ text: "Second Hobb quote", author: "Robin Hobb" });
    const never = s.quote({ text: "Third Hobb quote", author: "Robin Hobb" });
    for (const q of [reposted, once, never]) linkBook(q.id, hobb.id);
    const p1 = s.posting(reposted.id, {
      postedAt: "2026-01-01T00:00:00.000Z",
      permalink: "https://instagram.com/p/one",
      mediaPath: "a.jpg",
      likes: 10,
      comments: 1,
    });
    const p2 = s.posting(reposted.id, {
      postedAt: "2026-10-25T00:00:00.000Z",
      permalink: "https://instagram.com/p/two",
      mediaPath: "sub/b c.png",
      likes: 30,
      comments: 4,
    });
    s.posting(once.id, { postedAt: "2026-05-01T00:00:00.000Z" });
    const loose = s.highlight({
      bookId: hobb.id,
      text: "An unposted highlight",
      createdAt: "2025-09-09T00:00:00.000Z",
    });
    return { hobb, dune, reposted, once, never, p1, p2, loose };
  }

  test("GET /api/books lists books with counts, sorted and searchable", async () => {
    const { hobb, dune } = fixture();
    const r = await get("/api/books");
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([
      {
        id: dune.id,
        assetId: dune.assetId,
        title: "Dune",
        author: "Frank Herbert",
        source: "apple_books",
        quoteCount: 0,
        postedCount: 0,
        unpostedHighlightCount: 0,
        lastPostedAt: null,
        issues: [],
      },
      {
        id: hobb.id,
        assetId: "HOBB",
        title: "Fool's Errand",
        author: "Robin Hobb",
        source: "apple_books",
        quoteCount: 3,
        postedCount: 2,
        unpostedHighlightCount: 1,
        lastPostedAt: "2026-10-25T00:00:00.000Z",
        issues: [],
      },
    ]);
    const byQuotes = await get("/api/books?sort=quotes");
    expect(byQuotes.body.items.map((b: { id: number }) => b.id)).toEqual([hobb.id, dune.id]);
    const q = await get("/api/books?q=herbert");
    expect(q.body.items.map((b: { id: number }) => b.id)).toEqual([dune.id]);
    expectError(await get("/api/books?sort=nope"), 400);
  });

  test("GET /api/books/:id splits posted and unposted entries with postings", async () => {
    const { hobb, reposted, once, never, p1, p2, loose } = fixture();
    const r = await get(`/api/books/${hobb.id}`);
    expect(r.status).toBe(200);
    expect(r.body.book).toMatchObject({ id: hobb.id, quoteCount: 3, postedCount: 2 });

    const entries = r.body.entries as Array<{
      kind: string;
      quoteId: number | null;
      highlightId: number | null;
      posted: boolean;
      postings: unknown[];
    }>;
    expect(entries.map((e) => [e.kind, e.quoteId ?? e.highlightId, e.posted])).toEqual([
      ["quote", reposted.id, true],
      ["quote", once.id, true],
      ["quote", never.id, false],
      ["highlight", loose.id, false],
    ]);
    expect(entries[0]?.postings).toEqual([
      {
        postId: p1.id,
        postedAt: "2026-01-01T00:00:00.000Z",
        likes: 10,
        comments: 1,
        permalink: "https://instagram.com/p/one",
        mediaPath: "a.jpg",
        mediaUrl: "/media/a.jpg",
      },
      {
        postId: p2.id,
        postedAt: "2026-10-25T00:00:00.000Z",
        likes: 30,
        comments: 4,
        permalink: "https://instagram.com/p/two",
        mediaPath: "sub/b c.png",
        mediaUrl: "/media/sub/b%20c.png",
      },
    ]);
    expect(entries[3]).toMatchObject({
      text: "An unposted highlight",
      highlightedAt: "2025-09-09T00:00:00.000Z",
      postings: [],
    });
  });

  test("GET /api/books/:id: 404 on unknown, 400 on non-numeric", async () => {
    expectError(await get("/api/books/999"), 404);
    expectError(await get("/api/books/abc"), 400);
  });

  test("quote search rows and quote detail include the linked book", async () => {
    const { hobb, reposted } = fixture();
    const book = { id: hobb.id, title: "Fool's Errand", author: "Robin Hobb" };
    const search = await get("/api/quotes?q=hope");
    expect(search.body.items[0].book).toEqual(book);
    const detail = await get(`/api/quotes/${reposted.id}`);
    expect(detail.body.book).toEqual(book);
    const plain = s.quote({ text: "No book" });
    expect((await get(`/api/quotes/${plain.id}`)).body.book).toBeNull();
  });

  test("PATCH sourceTitle links the quote to a book", async () => {
    const q = s.quote({ text: "Edit me", author: "Robin Hobb" });
    const r = await send("PATCH", `/api/quotes/${q.id}`, { sourceTitle: "Fool’s Errand" });
    expect(r.status).toBe(200);
    expect(r.body.quote.bookId).toEqual(expect.any(Number));
    const books = await get("/api/books");
    expect(books.body.items).toEqual([
      expect.objectContaining({ id: r.body.quote.bookId, title: "Fool’s Errand", quoteCount: 1 }),
    ]);
  });
});

describe("book cleanup (#34)", () => {
  function linkBook(quoteId: number, bookId: number) {
    db.run(`UPDATE quotes SET book_id = ${bookId} WHERE id = ${quoteId}`);
  }

  test("POST /api/books/:id/merge moves the other book's quotes here and returns the detail", async () => {
    const keep = s.book({ assetId: null, title: "1Q84", author: "Haruki Murakami" });
    const drop = s.book({ assetId: null, title: "IQ84", author: "Haruki Murakami" });
    const q = s.quote({ text: "Something that has not yet happened" });
    linkBook(q.id, drop.id);
    s.highlight({ bookId: drop.id, text: "A loose highlight" });

    const r = await send("POST", `/api/books/${keep.id}/merge`, { dropId: drop.id });
    expect(r.status).toBe(200);
    expect(r.body.book).toMatchObject({ id: keep.id, title: "1Q84", quoteCount: 1 });
    expect(r.body.entries.map((e: { text: string }) => e.text)).toEqual([
      "Something that has not yet happened",
      "A loose highlight",
    ]);
    expect(r.body.possibleDuplicates).toEqual([]);
    expectError(await get(`/api/books/${drop.id}`), 404);
  });

  test("POST /api/books/:id/merge: 400 on itself or a bad body, 404 on unknown books", async () => {
    const b = s.book({ assetId: null, title: "Dune", author: "Frank Herbert" });
    expectError(await send("POST", `/api/books/${b.id}/merge`, {}), 400);
    expectError(await send("POST", `/api/books/${b.id}/merge`, { dropId: b.id }), 400);
    expectError(await send("POST", `/api/books/${b.id}/merge`, { dropId: 999 }), 404);
    expectError(await send("POST", "/api/books/999/merge", { dropId: b.id }), 404);
  });

  test("PATCH /api/books/:id edits title and author", async () => {
    const b = s.book({ assetId: null, title: "Senlin Ascends", author: "Mark Lawrence" });
    const r = await send("PATCH", `/api/books/${b.id}`, { author: "Josiah Bancroft" });
    expect(r.status).toBe(200);
    expect(r.body.book).toMatchObject({
      id: b.id,
      title: "Senlin Ascends",
      author: "Josiah Bancroft",
      normalizedKey: "senlin ascends|josiah bancroft",
    });
    const cleared = await send("PATCH", `/api/books/${b.id}`, { author: "" });
    expect(cleared.body.book.author).toBeNull();
  });

  test("PATCH /api/books/:id: 409 with conflictId when another book has that title and author", async () => {
    const wrong = s.book({ assetId: null, title: "The Faith of Beasts", author: "Jessyn" });
    const right = s.book({
      assetId: null,
      title: "The Faith of Beasts",
      author: "James S.A. Corey",
    });
    const r = await send("PATCH", `/api/books/${wrong.id}`, { author: "James S. A. Corey" });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: expect.any(String), conflictId: right.id });
  });

  test("PATCH /api/books/:id: 400 on empty title or no fields, 404 on unknown", async () => {
    const b = s.book({ assetId: null, title: "Dune", author: "Frank Herbert" });
    expectError(await send("PATCH", `/api/books/${b.id}`, { title: " " }), 400);
    expectError(await send("PATCH", `/api/books/${b.id}`, {}), 400);
    expectError(await send("PATCH", `/api/books/${b.id}`, { source: "x" }), 400);
    expectError(await send("PATCH", "/api/books/999", { title: "X" }), 404);
  });

  test("DELETE /api/books/:id deletes an empty book, refuses one with quotes or highlights", async () => {
    const empty = s.book({ assetId: null, title: "Empty", author: null });
    const used = s.book({ assetId: null, title: "Used", author: null });
    linkBook(s.quote({ text: "keeps it" }).id, used.id);

    const refused = await send("DELETE", `/api/books/${used.id}`, undefined);
    expectError(refused, 409);
    const ok = await send("DELETE", `/api/books/${empty.id}`, undefined);
    expect(ok).toEqual({ status: 200, body: { id: empty.id } });
    expectError(await get(`/api/books/${empty.id}`), 404);
    expectError(await send("DELETE", `/api/books/${empty.id}`, undefined), 404);
  });

  test("DELETE /api/books/:id is guarded against cross-origin requests", async () => {
    const b = s.book({ assetId: null, title: "Empty", author: null });
    const res = await fetch(url(`/api/books/${b.id}`), { method: "DELETE" });
    expect(res.status).toBe(415);
  });

  test("GET /api/books?attention=1 lists only books needing a look, with their issues", async () => {
    const a = s.book({ assetId: null, title: "Senlin Ascends", author: "Mark Lawrence" });
    const b = s.book({ assetId: null, title: "Senlin Ascends", author: "Josiah Bancroft" });
    const bare = s.book({ assetId: null, title: "The Jesus of Suburbia", author: null });
    s.book({ assetId: null, title: "Dune", author: "Frank Herbert" });
    const r = await get("/api/books?attention=1");
    expect(r.status).toBe(200);
    expect(r.body.items.map((x: { id: number; issues: string[] }) => [x.id, x.issues])).toEqual([
      [a.id, ["possible_duplicate"]],
      [b.id, ["possible_duplicate"]],
      [bare.id, ["no_author"]],
    ]);
    const detail = await get(`/api/books/${a.id}`);
    expect(detail.body.possibleDuplicates).toEqual([
      { id: b.id, title: "Senlin Ascends", author: "Josiah Bancroft", quoteCount: 0, score: 1 },
    ]);
  });

  test("GET /api/quotes?noBook=1 lists only quotes without a book", async () => {
    const book = s.book({ assetId: null, title: "Dune", author: "Frank Herbert" });
    const linked = s.quote({ text: "Fear is the mind-killer" });
    linkBook(linked.id, book.id);
    const loose = s.quote({ text: "An orphan line" });
    const r = await get("/api/quotes?noBook=1");
    expect(r.body.items.map((q: { id: number }) => q.id)).toEqual([loose.id]);
    expect(r.body.total).toBe(1);
  });
});

test("unknown /api route returns JSON 404", async () => {
  expectError(await get("/api/nope"), 404);
});
