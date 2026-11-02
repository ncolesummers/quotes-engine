import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../../../test/helpers/db";
import { markExtracted, upsertPost } from "../../server/repos/posts";
import type { OcrLine } from "../ocr/parse";
import { writePostOcr } from "../ocr/run";
import { formatOcrLine, writeClassificationBatches } from "./classify-batches";

let db: Database;
let root: string;
let mediaDir: string;
let ocrDir: string;
let extractionsDir: string;
let todoDir: string;

beforeEach(() => {
  db = createTestDb();
  root = mkdtempSync(join(tmpdir(), "quotes-classify-"));
  mediaDir = join(root, "media");
  ocrDir = join(root, "ocr");
  extractionsDir = join(root, "extractions");
  todoDir = join(extractionsDir, "todo");
  mkdirSync(mediaDir, { recursive: true });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function l(text: string): OcrLine {
  return { text, confidence: 0.9, box: { x: 0, y: 0, w: 1, h: 0.1 } };
}

/** Creates the media files and their OCR for a post. */
function withOcr(id: string, images: Record<string, string[]>): void {
  for (const file of Object.keys(images)) writeFileSync(join(mediaDir, file), "x");
  writePostOcr(ocrDir, {
    ig_media_id: id,
    images: Object.entries(images).map(([file, lines]) => ({
      file,
      path: join(mediaDir, file),
      lines: lines.map(l),
    })),
  });
}

function write(size?: number) {
  return writeClassificationBatches(db, { mediaDir, ocrDir, todoDir, size });
}

function readBatch(name: string) {
  return JSON.parse(readFileSync(join(todoDir, name), "utf8"));
}

describe("formatOcrLine", () => {
  test("prefixes a JSON-quoted line with its image and line number", () => {
    expect(formatOcrLine(1, 0, "Once you've got a")).toBe(`img1:L0 "Once you've got a"`);
    expect(formatOcrLine(2, 13, 'He said "no"')).toBe(`img2:L13 "He said \\"no\\""`);
  });
});

describe("writeClassificationBatches", () => {
  test("gives each post its caption and numbered OCR lines per image", () => {
    upsertPost(db, {
      igMediaId: "solo",
      mediaType: "IMAGE",
      caption: "#bookstagram #joeabercrombie",
      postedAt: "2020-01-01T00:00:00Z",
    });
    withOcr("solo", { "solo.jpg": ["Once you've got a", "task to do"] });

    const summary = write();
    expect(summary).toMatchObject({ posts: 1, missingOcr: [], missingMedia: [], skipped: 0 });
    expect(summary.batches).toEqual([join(todoDir, "batch-001.json")]);
    expect(readBatch("batch-001.json")).toEqual({
      posts: [
        {
          ig_media_id: "solo",
          posted_at: "2020-01-01T00:00:00.000Z",
          caption: "#bookstagram #joeabercrombie",
          images: [
            {
              image: 1,
              file: "solo.jpg",
              lines: [`img1:L0 "Once you've got a"`, `img1:L1 "task to do"`],
            },
          ],
        },
      ],
    });
  });

  test("numbers carousel images from 1 in media order, restarting line numbers per image", () => {
    upsertPost(db, { igMediaId: "car", mediaType: "CAROUSEL_ALBUM", caption: "x" });
    withOcr("car", {
      "car_2.jpg": ["second"],
      "car_1.jpg": ["first a", "first b"],
      "car_10.jpg": [],
    });

    write();
    const [post] = readBatch("batch-001.json").posts;
    expect(post.images).toEqual([
      { image: 1, file: "car_1.jpg", lines: [`img1:L0 "first a"`, `img1:L1 "first b"`] },
      { image: 2, file: "car_2.jpg", lines: [`img2:L0 "second"`] },
      { image: 3, file: "car_10.jpg", lines: [] },
    ]);
  });

  test("does not list media paths or anything that invites reading the images", () => {
    upsertPost(db, { igMediaId: "solo", mediaType: "IMAGE", caption: "x" });
    withOcr("solo", { "solo.jpg": ["a"] });
    write();
    const [post] = readBatch("batch-001.json").posts;
    expect(post.media_paths).toBeUndefined();
  });

  test("leaves out posts whose images are not all OCR'd, and lists them", () => {
    upsertPost(db, { igMediaId: "half", mediaType: "CAROUSEL_ALBUM", caption: "x" });
    withOcr("half", { "half_1.jpg": ["a"] });
    writeFileSync(join(mediaDir, "half_2.jpg"), "x");
    upsertPost(db, { igMediaId: "none", mediaType: "IMAGE", caption: "x" });
    writeFileSync(join(mediaDir, "none.jpg"), "x");

    const summary = write();
    expect(summary.missingOcr).toEqual(["half", "none"]);
    expect(summary.posts).toBe(0);
    expect(summary.batches).toEqual([]);
  });

  test("skips extracted posts, lists missing media, keeps caption-only videos", () => {
    const done = upsertPost(db, { igMediaId: "done", mediaType: "IMAGE", caption: "x" });
    markExtracted(db, done.id, "2024-01-01T00:00:00Z");
    upsertPost(db, { igMediaId: "gone", mediaType: "IMAGE", caption: "x" });
    upsertPost(db, { igMediaId: "vid", mediaType: "VIDEO", caption: "A quote. #author" });
    upsertPost(db, { igMediaId: "empty", mediaType: "VIDEO" });

    const summary = write();
    expect(summary).toMatchObject({ posts: 1, skipped: 1, missingMedia: ["gone"] });
    const [post] = readBatch("batch-001.json").posts;
    expect(post).toMatchObject({ ig_media_id: "vid", images: [] });
  });

  test("chunks into batches of `size`, clearing old batch files first", () => {
    mkdirSync(todoDir, { recursive: true });
    writeFileSync(join(todoDir, "batch-099.json"), "{}");
    for (let i = 0; i < 5; i++) {
      upsertPost(db, { igMediaId: `p${i}`, mediaType: "IMAGE", caption: "x" });
      withOcr(`p${i}`, { [`p${i}.jpg`]: ["line"] });
    }
    const summary = write(2);
    expect(summary.batches.map((b) => b.slice(todoDir.length + 1))).toEqual([
      "batch-001.json",
      "batch-002.json",
      "batch-003.json",
    ]);
    expect(existsSync(join(todoDir, "batch-099.json"))).toBe(false);
  });

  test("refuses to run while extraction or classification results are waiting", () => {
    mkdirSync(join(extractionsDir, "classified"), { recursive: true });
    writeFileSync(join(extractionsDir, "classified", "batch-001.json"), "{}");
    expect(() => write()).toThrow(/extract:assemble/);
    rmSync(join(extractionsDir, "classified"), { recursive: true });

    writeFileSync(join(extractionsDir, "batch-001.json"), "{}");
    expect(() => write()).toThrow(/import:extractions/);
  });
});
