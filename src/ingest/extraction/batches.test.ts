import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../../../test/helpers/db";
import { markExtracted, upsertPost } from "../../server/repos/posts";
import { batchName, chunk, findMediaFiles, writeBatches } from "./batches";

let db: Database;
let root: string;
let mediaDir: string;
let todoDir: string;

beforeEach(() => {
  db = createTestDb();
  root = mkdtempSync(join(tmpdir(), "quotes-batches-"));
  mediaDir = join(root, "media");
  todoDir = join(root, "extractions", "todo");
  mkdirSync(mediaDir, { recursive: true });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function touch(name: string): string {
  const path = join(mediaDir, name);
  writeFileSync(path, "x");
  return path;
}

function readBatch(name: string) {
  return JSON.parse(readFileSync(join(todoDir, name), "utf8"));
}

describe("chunk", () => {
  test("splits into fixed-size chunks with a short last chunk", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });

  test("rejects a non-positive size", () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe("batchName", () => {
  test("zero-pads to three digits, starting at 1", () => {
    expect(batchName(0)).toBe("batch-001");
    expect(batchName(41)).toBe("batch-042");
  });
});

describe("findMediaFiles", () => {
  test("lists every carousel image for a post as absolute paths in index order", () => {
    touch("car_2.jpg");
    touch("car_10.jpg");
    touch("car_1.jpg");
    touch("carrot.jpg");
    touch("other_1.jpg");
    expect(findMediaFiles(mediaDir, "car")).toEqual([
      join(mediaDir, "car_1.jpg"),
      join(mediaDir, "car_2.jpg"),
      join(mediaDir, "car_10.jpg"),
    ]);
  });

  test("finds a single image and other image extensions", () => {
    touch("solo.jpg");
    touch("pic.png");
    expect(findMediaFiles(mediaDir, "solo")).toEqual([join(mediaDir, "solo.jpg")]);
    expect(findMediaFiles(mediaDir, "pic")).toEqual([join(mediaDir, "pic.png")]);
  });

  test("returns absolute paths even for a relative media dir", () => {
    touch("solo.jpg");
    const rel = join(root, "media").replace(process.cwd(), ".");
    const [path] = findMediaFiles(rel, "solo");
    expect(path?.startsWith("/")).toBe(true);
  });

  test("returns [] when the post has no media or the dir is missing", () => {
    expect(findMediaFiles(mediaDir, "none")).toEqual([]);
    expect(findMediaFiles(join(root, "missing"), "none")).toEqual([]);
  });
});

describe("writeBatches", () => {
  test("writes unextracted posts oldest first in batches of `size`", () => {
    for (const [id, postedAt] of [
      ["c", "2020-03-01T00:00:00Z"],
      ["a", "2019-01-01T00:00:00Z"],
      ["b", "2019-06-01T00:00:00Z"],
    ] as const) {
      upsertPost(db, { igMediaId: id, caption: `caption ${id}`, postedAt });
      touch(`${id}.jpg`);
    }

    const summary = writeBatches(db, { mediaDir, todoDir, size: 2 });

    expect(summary).toEqual({
      batches: [join(todoDir, "batch-001.json"), join(todoDir, "batch-002.json")],
      posts: 3,
      skipped: 0,
      missingMedia: [],
    });
    expect(readBatch("batch-001.json")).toEqual({
      posts: [
        {
          ig_media_id: "a",
          posted_at: "2019-01-01T00:00:00.000Z",
          caption: "caption a",
          media_paths: [join(mediaDir, "a.jpg")],
        },
        {
          ig_media_id: "b",
          posted_at: "2019-06-01T00:00:00.000Z",
          caption: "caption b",
          media_paths: [join(mediaDir, "b.jpg")],
        },
      ],
    });
    expect(
      readBatch("batch-002.json").posts.map((p: { ig_media_id: string }) => p.ig_media_id),
    ).toEqual(["c"]);
  });

  test("includes all carousel images", () => {
    upsertPost(db, { igMediaId: "car", mediaPath: "car_1.jpg" });
    touch("car_1.jpg");
    touch("car_2.jpg");
    writeBatches(db, { mediaDir, todoDir, size: 20 });
    expect(readBatch("batch-001.json").posts[0].media_paths).toEqual([
      join(mediaDir, "car_1.jpg"),
      join(mediaDir, "car_2.jpg"),
    ]);
  });

  test("skips extracted posts and posts with neither media nor caption", () => {
    const done = upsertPost(db, { igMediaId: "done", caption: "already" });
    markExtracted(db, done.id, "2026-01-01T00:00:00Z");
    upsertPost(db, { igMediaId: "empty", caption: "   " });
    upsertPost(db, { igMediaId: "nothing" });
    upsertPost(db, { igMediaId: "textonly", caption: "A quote in the caption." });
    upsertPost(db, { igMediaId: "imageonly" });
    touch("imageonly.jpg");

    const summary = writeBatches(db, { mediaDir, todoDir, size: 20 });

    expect(summary.posts).toBe(2);
    expect(summary.skipped).toBe(2);
    const posts = readBatch("batch-001.json").posts;
    expect(posts.map((p: { ig_media_id: string }) => p.ig_media_id).sort()).toEqual([
      "imageonly",
      "textonly",
    ]);
    const textOnly = posts.find((p: { ig_media_id: string }) => p.ig_media_id === "textonly");
    expect(textOnly).toEqual({
      ig_media_id: "textonly",
      posted_at: null,
      caption: "A quote in the caption.",
      media_paths: [],
    });
  });

  test("skips image posts whose media files are missing, and reports them", () => {
    upsertPost(db, { igMediaId: "lost", caption: "#joeabercrombie", mediaType: "IMAGE" });
    upsertPost(db, {
      igMediaId: "lostcar",
      caption: "#theexpanse",
      mediaType: "CAROUSEL_ALBUM",
      mediaPath: "lostcar_1.jpg",
    });
    upsertPost(db, { igMediaId: "vid", caption: "A quote in the caption.", mediaType: "VIDEO" });

    const summary = writeBatches(db, { mediaDir, todoDir, size: 20 });

    expect(summary.posts).toBe(1);
    expect(summary.missingMedia).toEqual(["lost", "lostcar"]);
    expect(
      readBatch("batch-001.json").posts.map((p: { ig_media_id: string }) => p.ig_media_id),
    ).toEqual(["vid"]);
  });

  test("refuses to run while result files are waiting to be imported", () => {
    mkdirSync(todoDir, { recursive: true });
    writeFileSync(join(todoDir, "batch-001.json"), "{}");
    writeFileSync(join(root, "extractions", "batch-001.json"), "{}");
    upsertPost(db, { igMediaId: "a", caption: "hi" });

    expect(() => writeBatches(db, { mediaDir, todoDir, size: 20 })).toThrow(/import:extractions/);
    expect(readFileSync(join(todoDir, "batch-001.json"), "utf8")).toBe("{}");
  });

  test("clears todo/ and rewrites it on every run", () => {
    mkdirSync(todoDir, { recursive: true });
    writeFileSync(join(todoDir, "batch-009.json"), "{}");
    writeFileSync(join(todoDir, "stray.txt"), "x");
    upsertPost(db, { igMediaId: "a", caption: "hi" });

    writeBatches(db, { mediaDir, todoDir, size: 20 });

    expect(readdirSync(todoDir)).toEqual(["batch-001.json"]);
  });

  test("leaves an empty todo/ when nothing is left to extract", () => {
    const summary = writeBatches(db, { mediaDir, todoDir, size: 20 });
    expect(summary).toEqual({ batches: [], posts: 0, skipped: 0, missingMedia: [] });
    expect(existsSync(todoDir)).toBe(true);
    expect(readdirSync(todoDir)).toEqual([]);
  });
});
