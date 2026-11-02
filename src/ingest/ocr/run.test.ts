import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createTestDb } from "../../../test/helpers/db";
import { markExtracted, upsertPost } from "../../server/repos/posts";
import type { OcrImage } from "./parse";
import { type OcrRunner, ocrPath, readPostOcr, runOcr } from "./run";

let db: Database;
let root: string;
let mediaDir: string;
let ocrDir: string;

beforeEach(() => {
  db = createTestDb();
  root = mkdtempSync(join(tmpdir(), "quotes-ocr-"));
  mediaDir = join(root, "media");
  ocrDir = join(root, "ocr");
  mkdirSync(mediaDir, { recursive: true });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function touch(name: string): void {
  writeFileSync(join(mediaDir, name), "x");
}

/** Fake runner: one line per image naming the file; records every call. */
function fakeRunner(fail: (path: string) => boolean = () => false) {
  const calls: string[][] = [];
  const runner: OcrRunner = async (paths) => {
    calls.push(paths.map((p) => basename(p)));
    return paths.map(
      (path): OcrImage =>
        fail(path)
          ? { path, lines: [], error: "boom" }
          : {
              path,
              lines: [
                {
                  text: `text of ${basename(path)}`,
                  confidence: 0.9,
                  box: { x: 0, y: 0, w: 1, h: 0.1 },
                },
              ],
            },
    );
  };
  return { runner, calls };
}

describe("runOcr", () => {
  test("OCRs every image of every unextracted post into ocr/<ig_media_id>.json", async () => {
    upsertPost(db, { igMediaId: "solo", mediaType: "IMAGE", postedAt: "2020-01-01T00:00:00Z" });
    upsertPost(db, {
      igMediaId: "car",
      mediaType: "CAROUSEL_ALBUM",
      postedAt: "2020-01-02T00:00:00Z",
    });
    const done = upsertPost(db, { igMediaId: "done", mediaType: "IMAGE" });
    markExtracted(db, done.id, "2024-01-01T00:00:00Z");
    touch("solo.jpg");
    touch("car_2.jpg");
    touch("car_1.jpg");
    touch("done.jpg");

    const { runner, calls } = fakeRunner();
    const summary = await runOcr(db, { mediaDir, ocrDir, runner });

    expect(calls.flat().sort()).toEqual(["car_1.jpg", "car_2.jpg", "solo.jpg"]);
    expect(summary).toMatchObject({
      posts: 2,
      postsSkipped: 0,
      images: 3,
      imagesSkipped: 0,
      lines: 3,
      failures: [],
      noMedia: [],
    });

    const car = readPostOcr(ocrDir, "car");
    expect(car?.ig_media_id).toBe("car");
    expect(car?.images.map((i) => i.file)).toEqual(["car_1.jpg", "car_2.jpg"]);
    expect(car?.images[0]?.lines[0]?.text).toBe("text of car_1.jpg");
    expect(existsSync(ocrPath(ocrDir, "done"))).toBe(false);
  });

  test("is idempotent: images already OCR'd are skipped on the next run", async () => {
    upsertPost(db, { igMediaId: "solo", mediaType: "IMAGE" });
    touch("solo.jpg");
    await runOcr(db, { mediaDir, ocrDir, runner: fakeRunner().runner });

    const second = fakeRunner();
    const summary = await runOcr(db, { mediaDir, ocrDir, runner: second.runner });
    expect(second.calls).toEqual([]);
    expect(summary).toMatchObject({ posts: 1, postsSkipped: 1, images: 0, imagesSkipped: 1 });
  });

  test("OCRs only a post's new images and keeps the earlier ones", async () => {
    upsertPost(db, { igMediaId: "car", mediaType: "CAROUSEL_ALBUM" });
    touch("car_1.jpg");
    await runOcr(db, { mediaDir, ocrDir, runner: fakeRunner().runner });
    touch("car_2.jpg");

    const second = fakeRunner();
    await runOcr(db, { mediaDir, ocrDir, runner: second.runner });
    expect(second.calls).toEqual([["car_2.jpg"]]);
    expect(readPostOcr(ocrDir, "car")?.images.map((i) => i.file)).toEqual([
      "car_1.jpg",
      "car_2.jpg",
    ]);
  });

  test("reports failed images and does not store them, so they are retried", async () => {
    upsertPost(db, { igMediaId: "car", mediaType: "CAROUSEL_ALBUM" });
    touch("car_1.jpg");
    touch("car_2.jpg");
    const failing = fakeRunner((p) => p.endsWith("car_2.jpg"));
    const summary = await runOcr(db, { mediaDir, ocrDir, runner: failing.runner });

    expect(summary.failures).toEqual([
      { igMediaId: "car", path: join(mediaDir, "car_2.jpg"), message: "boom" },
    ]);
    expect(readPostOcr(ocrDir, "car")?.images.map((i) => i.file)).toEqual(["car_1.jpg"]);

    const retry = fakeRunner();
    await runOcr(db, { mediaDir, ocrDir, runner: retry.runner });
    expect(retry.calls).toEqual([["car_2.jpg"]]);
  });

  test("a runner that throws fails that post's images without stopping the run", async () => {
    upsertPost(db, { igMediaId: "a", mediaType: "IMAGE", postedAt: "2020-01-01T00:00:00Z" });
    upsertPost(db, { igMediaId: "b", mediaType: "IMAGE", postedAt: "2020-01-02T00:00:00Z" });
    touch("a.jpg");
    touch("b.jpg");
    const runner: OcrRunner = async (paths) => {
      if (paths[0]?.endsWith("a.jpg")) throw new Error("crashed");
      return fakeRunner().runner(paths);
    };
    const summary = await runOcr(db, { mediaDir, ocrDir, runner });
    expect(summary.failures).toEqual([
      { igMediaId: "a", path: join(mediaDir, "a.jpg"), message: "crashed" },
    ]);
    expect(readPostOcr(ocrDir, "a")).toBeNull();
    expect(readPostOcr(ocrDir, "b")?.images).toHaveLength(1);
  });

  test("lists image posts with no media on disk; ignores videos without images", async () => {
    upsertPost(db, { igMediaId: "gone", mediaType: "IMAGE" });
    upsertPost(db, { igMediaId: "vid", mediaType: "VIDEO" });
    const summary = await runOcr(db, { mediaDir, ocrDir, runner: fakeRunner().runner });
    expect(summary.noMedia).toEqual(["gone"]);
    expect(summary.posts).toBe(0);
  });

  test("runs at most `concurrency` OCR calls at once", async () => {
    for (let i = 0; i < 10; i++) {
      upsertPost(db, { igMediaId: `p${i}`, mediaType: "IMAGE" });
      touch(`p${i}.jpg`);
    }
    let active = 0;
    let peak = 0;
    const inner = fakeRunner().runner;
    const runner: OcrRunner = async (paths) => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active--;
      return inner(paths);
    };
    const summary = await runOcr(db, { mediaDir, ocrDir, runner, concurrency: 3 });
    expect(summary.images).toBe(10);
    expect(peak).toBe(3);
  });

  test("rejects an unreadable OCR file instead of silently redoing it", async () => {
    upsertPost(db, { igMediaId: "solo", mediaType: "IMAGE" });
    touch("solo.jpg");
    mkdirSync(ocrDir, { recursive: true });
    writeFileSync(ocrPath(ocrDir, "solo"), "{bad");
    expect(() => readPostOcr(ocrDir, "solo")).toThrow(/solo/);
  });

  test("a corrupt OCR file fails that post (left untouched) without stopping the run", async () => {
    upsertPost(db, { igMediaId: "bad", mediaType: "IMAGE", postedAt: "2020-01-01T00:00:00Z" });
    upsertPost(db, { igMediaId: "good", mediaType: "IMAGE", postedAt: "2020-01-02T00:00:00Z" });
    touch("bad.jpg");
    touch("good.jpg");
    mkdirSync(ocrDir, { recursive: true });
    writeFileSync(ocrPath(ocrDir, "bad"), "{bad");

    const { runner, calls } = fakeRunner();
    const summary = await runOcr(db, { mediaDir, ocrDir, runner });
    expect(calls).toEqual([["good.jpg"]]);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]).toMatchObject({ igMediaId: "bad" });
    expect(summary.failures[0]?.message).toMatch(/Corrupt OCR file/);
    expect(readFileSync(ocrPath(ocrDir, "bad"), "utf8")).toBe("{bad");
  });
});
