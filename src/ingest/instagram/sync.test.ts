import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../../../test/helpers/db";
import { getPostByIgMediaId, markExtracted } from "../../server/repos/posts";
import { InstagramApiError, type InstagramClient, type InstagramMedia } from "./client";
import {
  createFetchDownloader,
  type Downloader,
  mediaExtension,
  mediaTargets,
  syncInstagram,
} from "./sync";

const T1 = new Date("2026-03-01T12:00:00.000Z");
const T2 = new Date("2026-03-02T12:00:00.000Z");

let db: Database;
let mediaDir: string;

beforeEach(() => {
  db = createTestDb();
  mediaDir = mkdtempSync(join(tmpdir(), "quotes-media-"));
});

afterEach(() => {
  db.close();
  rmSync(mediaDir, { recursive: true, force: true });
});

function media(id: string, extra: Partial<InstagramMedia> = {}): InstagramMedia {
  return {
    id,
    caption: `caption ${id}`,
    mediaType: "IMAGE",
    mediaUrl: `https://cdn.example/${id}.jpg?sig=abc`,
    thumbnailUrl: null,
    permalink: `https://instagram.com/p/${id}`,
    timestamp: "2026-01-01T00:00:00.000Z",
    likeCount: 10,
    commentsCount: 1,
    children: [],
    ...extra,
  };
}

function fakeClient(
  items: InstagramMedia[],
  failAfter?: Error,
): Pick<InstagramClient, "listMedia"> {
  return {
    async *listMedia() {
      yield* items;
      if (failAfter) throw failAfter;
    },
  };
}

/** Records downloaded URLs and writes the URL as the file body. */
function fakeDownloader(fail: (url: string) => boolean = () => false) {
  const calls: { url: string; path: string }[] = [];
  const download: Downloader = async (url, path) => {
    calls.push({ url, path });
    await Bun.sleep(1);
    if (fail(url)) throw new Error(`HTTP 403 for ${url}`);
    writeFileSync(path, url);
  };
  return { calls, download };
}

function count(table: string): number {
  return (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("syncInstagram", () => {
  test("first run inserts posts and snapshots; second run adds snapshots with new counts", async () => {
    const dl = fakeDownloader();
    const first = await syncInstagram({
      db,
      client: fakeClient([media("a"), media("b"), media("c")]),
      mediaDir,
      now: () => T1,
      download: dl.download,
    });
    expect(first).toMatchObject({
      seen: 3,
      newPosts: 3,
      updatedPosts: 0,
      snapshots: 3,
      downloads: 3,
      errors: [],
    });
    expect(count("posts")).toBe(3);
    expect(count("metric_snapshots")).toBe(3);
    const a = getPostByIgMediaId(db, "a");
    expect(a).toMatchObject({
      caption: "caption a",
      mediaType: "IMAGE",
      permalink: "https://instagram.com/p/a",
      postedAt: "2026-01-01T00:00:00.000Z",
      likeCount: 10,
      commentsCount: 1,
      mediaPath: "a.jpg",
      metricsUpdatedAt: T1.toISOString(),
    });

    const second = await syncInstagram({
      db,
      client: fakeClient([media("a", { likeCount: 25, commentsCount: 3 }), media("b"), media("c")]),
      mediaDir,
      now: () => T2,
      download: dl.download,
    });
    expect(second).toMatchObject({
      seen: 3,
      newPosts: 0,
      updatedPosts: 3,
      snapshots: 3,
      downloads: 0,
      skippedDownloads: 3,
      errors: [],
    });
    expect(count("posts")).toBe(3);
    expect(count("metric_snapshots")).toBe(6);
    expect(getPostByIgMediaId(db, "a")).toMatchObject({
      likeCount: 25,
      commentsCount: 3,
      metricsUpdatedAt: T2.toISOString(),
    });
    expect(dl.calls).toHaveLength(3);
  });

  test("keeps extracted_at on existing posts", async () => {
    const dl = fakeDownloader();
    const opts = { db, client: fakeClient([media("a")]), mediaDir, now: () => T1 };
    await syncInstagram({ ...opts, download: dl.download });
    const post = getPostByIgMediaId(db, "a");
    if (!post) throw new Error("missing post");
    markExtracted(db, post.id, "2026-03-01T13:00:00.000Z");
    await syncInstagram({ ...opts, now: () => T2, download: dl.download });
    expect(getPostByIgMediaId(db, "a")?.extractedAt).toBe("2026-03-01T13:00:00.000Z");
  });

  test("media that already exists on disk is not downloaded again", async () => {
    writeFileSync(join(mediaDir, "a.jpg"), "existing");
    const dl = fakeDownloader();
    const summary = await syncInstagram({
      db,
      client: fakeClient([media("a"), media("b")]),
      mediaDir,
      now: () => T1,
      download: dl.download,
    });
    expect(dl.calls.map((c) => c.url)).toEqual(["https://cdn.example/b.jpg?sig=abc"]);
    expect(summary).toMatchObject({ downloads: 1, skippedDownloads: 1 });
    expect(readFileSync(join(mediaDir, "a.jpg"), "utf8")).toBe("existing");
    expect(getPostByIgMediaId(db, "a")?.mediaPath).toBe("a.jpg");
  });

  test("a carousel saves every child image and stores the first as media_path", async () => {
    const dl = fakeDownloader();
    const carousel = media("car", {
      mediaType: "CAROUSEL_ALBUM",
      mediaUrl: "https://cdn.example/cover.jpg",
      children: [
        { id: "c1", mediaType: "IMAGE", mediaUrl: "https://cdn.example/c1.jpg" },
        { id: "c2", mediaType: "IMAGE", mediaUrl: "https://cdn.example/c2.png" },
        { id: "c3", mediaType: "IMAGE", mediaUrl: "https://cdn.example/c3.jpg" },
      ],
    });
    const summary = await syncInstagram({
      db,
      client: fakeClient([carousel]),
      mediaDir,
      now: () => T1,
      download: dl.download,
    });
    expect(summary).toMatchObject({ downloads: 3, errors: [] });
    expect(existsSync(join(mediaDir, "car_1.jpg"))).toBe(true);
    expect(existsSync(join(mediaDir, "car_2.png"))).toBe(true);
    expect(existsSync(join(mediaDir, "car_3.jpg"))).toBe(true);
    expect(getPostByIgMediaId(db, "car")?.mediaPath).toBe("car_1.jpg");
  });

  test("a video downloads its thumbnail", async () => {
    const dl = fakeDownloader();
    await syncInstagram({
      db,
      client: fakeClient([
        media("v", {
          mediaType: "VIDEO",
          mediaUrl: "https://cdn.example/v.mp4",
          thumbnailUrl: "https://cdn.example/v-thumb.jpg",
        }),
      ]),
      mediaDir,
      now: () => T1,
      download: dl.download,
    });
    expect(dl.calls.map((c) => c.url)).toEqual(["https://cdn.example/v-thumb.jpg"]);
    expect(getPostByIgMediaId(db, "v")?.mediaPath).toBe("v.jpg");
  });

  test("a download failure is recorded and the sync continues", async () => {
    const dl = fakeDownloader((url) => url.includes("/b.jpg"));
    const summary = await syncInstagram({
      db,
      client: fakeClient([media("a"), media("b"), media("c")]),
      mediaDir,
      now: () => T1,
      download: dl.download,
    });
    expect(summary.downloads).toBe(2);
    expect(summary.snapshots).toBe(3);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatchObject({ igMediaId: "b" });
    expect(summary.errors[0]?.message).toContain("HTTP 403");
    expect(getPostByIgMediaId(db, "b")?.mediaPath).toBeNull();
    expect(getPostByIgMediaId(db, "c")?.mediaPath).toBe("c.jpg");
  });

  test("an item without any media URL is synced without a download", async () => {
    const dl = fakeDownloader();
    const summary = await syncInstagram({
      db,
      client: fakeClient([media("x", { mediaUrl: null })]),
      mediaDir,
      now: () => T1,
      download: dl.download,
    });
    expect(summary).toMatchObject({ newPosts: 1, snapshots: 1, downloads: 0, errors: [] });
    expect(dl.calls).toHaveLength(0);
  });

  test("an API error mid-listing is recorded and items already seen are kept", async () => {
    const dl = fakeDownloader();
    const summary = await syncInstagram({
      db,
      client: fakeClient([media("a")], new InstagramApiError("boom", { code: 190 })),
      mediaDir,
      now: () => T1,
      download: dl.download,
    });
    expect(count("posts")).toBe(1);
    expect(summary.downloads).toBe(1);
    expect(summary.errors).toEqual([{ igMediaId: null, message: "boom" }]);
    expect(summary.fatal).toBeInstanceOf(InstagramApiError);
  });

  test("limits concurrent downloads", async () => {
    let active = 0;
    let peak = 0;
    const download: Downloader = async (_url, path) => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      writeFileSync(path, "x");
      active--;
    };
    const items = Array.from({ length: 12 }, (_, i) => media(`m${i}`));
    const summary = await syncInstagram({
      db,
      client: fakeClient(items),
      mediaDir,
      now: () => T1,
      download,
      concurrency: 3,
    });
    expect(summary.downloads).toBe(12);
    expect(peak).toBe(3);
  });

  test("metricsOnly skips downloads for posts that already have media", async () => {
    const dl = fakeDownloader();
    await syncInstagram({
      db,
      client: fakeClient([media("a")]),
      mediaDir,
      now: () => T1,
      download: dl.download,
    });
    rmSync(join(mediaDir, "a.jpg"));
    const summary = await syncInstagram({
      db,
      client: fakeClient([media("a"), media("b")]),
      mediaDir,
      now: () => T2,
      download: dl.download,
      metricsOnly: true,
    });
    expect(dl.calls.map((c) => c.url)).toEqual([
      "https://cdn.example/a.jpg?sig=abc",
      "https://cdn.example/b.jpg?sig=abc",
    ]);
    expect(summary).toMatchObject({ snapshots: 2, downloads: 1 });
  });
});

describe("mediaTargets", () => {
  test("skips carousel video children but keeps child numbering", () => {
    const targets = mediaTargets(
      media("car", {
        mediaType: "CAROUSEL_ALBUM",
        children: [
          { id: "c1", mediaType: "VIDEO", mediaUrl: "https://cdn.example/c1.mp4" },
          { id: "c2", mediaType: "IMAGE", mediaUrl: "https://cdn.example/c2.jpg" },
        ],
      }),
    );
    expect(targets).toEqual([{ url: "https://cdn.example/c2.jpg", fileName: "car_2.jpg" }]);
  });

  test("falls back to the album's own image when a carousel has no children", () => {
    expect(mediaTargets(media("car", { mediaType: "CAROUSEL_ALBUM" }))).toEqual([
      { url: "https://cdn.example/car.jpg?sig=abc", fileName: "car.jpg" },
    ]);
  });
});

describe("mediaExtension", () => {
  test("reads the extension from the URL path and defaults to jpg", () => {
    expect(mediaExtension("https://cdn.example/a/b.png?x=1.gif")).toBe("png");
    expect(mediaExtension("https://cdn.example/a/b.JPEG")).toBe("jpeg");
    expect(mediaExtension("https://cdn.example/a/b")).toBe("jpg");
    expect(mediaExtension("https://cdn.example/a/b.exe")).toBe("jpg");
    expect(mediaExtension("not a url")).toBe("jpg");
  });
});

describe("createFetchDownloader", () => {
  test("writes the response body to the path", async () => {
    const download = createFetchDownloader(async () => new Response("bytes"));
    const path = join(mediaDir, "f.jpg");
    await download("https://cdn.example/f.jpg", path);
    expect(readFileSync(path, "utf8")).toBe("bytes");
  });

  test("throws on a non-OK response and leaves no file behind", async () => {
    const download = createFetchDownloader(async () => new Response("no", { status: 403 }));
    const path = join(mediaDir, "f.jpg");
    await expect(download("https://cdn.example/f.jpg", path)).rejects.toThrow("HTTP 403");
    expect(existsSync(path)).toBe(false);
  });
});
