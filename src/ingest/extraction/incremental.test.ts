import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createTestDb } from "../../../test/helpers/db";
import { getPostByIgMediaId, markExtracted, upsertPost } from "../../server/repos/posts";
import type { OcrImage } from "../ocr/parse";
import { type OcrRunner, runOcr } from "../ocr/run";
import type { ClassificationFileSchema } from "./classification-schema";
import { writeClassificationBatches } from "./classify-batches";
import {
  type Classifier,
  type ClassifyOutcome,
  type ClassifyRequest,
  extractNewPosts,
  type IncrementalPaths,
} from "./incremental";

let db: Database;
let root: string;
let paths: IncrementalPaths;

const NOW = new Date("2026-11-02T06:00:00Z");
const now = () => NOW;

beforeEach(() => {
  db = createTestDb();
  root = mkdtempSync(join(tmpdir(), "quotes-incremental-"));
  paths = {
    mediaDir: join(root, "media"),
    ocrDir: join(root, "ocr"),
    extractionsDir: join(root, "extractions"),
  };
  mkdirSync(paths.mediaDir, { recursive: true });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const QUOTE_LINES = [
  "Once you've got a",
  "task to do, it's bet-",
  "ter to do it than",
  "live with the fear of it.",
  "— Joe Abercrombie",
];

/** A new image post with one media file on disk. */
function addPost(id: string, postedAt = "2026-11-01T00:00:00Z"): void {
  upsertPost(db, {
    igMediaId: id,
    mediaType: "IMAGE",
    caption: "#bookstagram #joeabercrombie",
    postedAt,
  });
  writeFileSync(join(paths.mediaDir, `${id}.jpg`), "x");
}

/** A fake Vision runner: every image reads as the Abercrombie quote. */
function fakeOcr(calls: string[][] = []): OcrRunner {
  return async (imagePaths) => {
    calls.push(imagePaths);
    return imagePaths.map(
      (path): OcrImage => ({
        path,
        lines: QUOTE_LINES.map((text) => ({
          text,
          confidence: 1,
          box: { x: 0, y: 0, w: 1, h: 0.1 },
        })),
      }),
    );
  };
}

type ClassificationInput = import("zod").input<typeof ClassificationFileSchema>;

/** Canned classification for a batch: lines 0–3 of image 1 for every post. */
function cannedClassification(batchPath: string): ClassificationInput {
  const batch = JSON.parse(readFileSync(batchPath, "utf8")) as {
    posts: { ig_media_id: string }[];
  };
  return {
    results: batch.posts.map((p) => ({
      ig_media_id: p.ig_media_id,
      no_quote: false,
      quotes: [
        {
          image: 1,
          lines: [0, 3],
          from_caption: false,
          author: "Joe Abercrombie",
          source: null,
          confidence: 0.95,
        },
      ],
    })),
  };
}

/** What each fake agent saw in its batch file (the staged copy is gone after the run). */
const seenBatches = new Map<string, string>();

/** A fake `claude -p`: writes the canned result file, then reports `outcome`. */
function fakeClassifier(
  requests: ClassifyRequest[],
  outcome: Partial<ClassifyOutcome> = {},
  { write = true }: { write?: boolean } = {},
): Classifier {
  return async (req) => {
    requests.push(req);
    seenBatches.set(req.batchPath, readFileSync(req.batchPath, "utf8"));
    if (write) {
      mkdirSync(dirname(req.outPath), { recursive: true });
      writeFileSync(req.outPath, JSON.stringify(cannedClassification(req.batchPath)));
    }
    return { exitCode: 0, timedOut: false, stdout: "", stderr: "", ...outcome };
  };
}

function extractedAt(id: string): string | null {
  return getPostByIgMediaId(db, id)?.extractedAt ?? null;
}

function quoteTexts(): string[] {
  return db
    .query<{ text: string }, []>("SELECT text FROM quotes ORDER BY id")
    .all()
    .map((r) => r.text);
}

describe("extractNewPosts", () => {
  test("happy path: OCRs, classifies each batch, assembles and imports", async () => {
    addPost("p1", "2026-10-31T00:00:00Z");
    addPost("p2", "2026-11-01T00:00:00Z");
    const ocrCalls: string[][] = [];
    const requests: ClassifyRequest[] = [];

    const summary = await extractNewPosts({
      db,
      paths,
      runOcr: fakeOcr(ocrCalls),
      runClassifier: fakeClassifier(requests),
      now,
    });

    expect(ocrCalls.flat()).toHaveLength(2);
    expect(requests).toHaveLength(1);
    const [req] = requests as [ClassifyRequest];
    // The agent works in its own staging dir, on a copy of the batch, and writes its result
    // there; it gets no other directory, so it can't touch todo/, classified/ or the repo.
    const staging = join(paths.extractionsDir, "classifying");
    expect(req.cwd).toBe(staging);
    expect(req.addDirs).toEqual([]);
    expect(dirname(req.outPath)).toBe(staging);
    expect(req.batchPath.startsWith(`${staging}/`)).toBe(true);
    expect(req.batchPath).not.toBe(req.outPath);
    expect(seenBatches.get(req.batchPath)).toBe(
      readFileSync(join(paths.extractionsDir, "todo", "batch-001.json"), "utf8"),
    );
    // The classification prompt for that batch, with absolute paths.
    expect(req.prompt).toContain(resolve(req.batchPath));
    expect(req.prompt).toContain(resolve(req.outPath));
    expect(req.prompt).toContain("Never write out quote text");

    expect(summary).toMatchObject({
      unextracted: 2,
      ocrImages: 2,
      batches: 1,
      classified: 1,
      postsExtracted: 2,
      quotesImported: 1,
      needsReview: 0,
      errors: [],
    });
    expect(extractedAt("p1")).toBe(NOW.toISOString());
    expect(extractedAt("p2")).toBe(NOW.toISOString());
    expect(quoteTexts()).toEqual([
      "Once you've got a task to do, it's better to do it than live with the fear of it.",
    ]);
    // Nothing is left pending for the next run.
    expect(existsSync(join(paths.extractionsDir, "classified", "batch-001.json"))).toBe(false);
    expect(existsSync(join(paths.extractionsDir, "batch-001.json"))).toBe(false);
    expect(existsSync(staging)).toBe(false);
  });

  test("runs one classifier per batch, sequentially", async () => {
    for (let i = 0; i < 5; i++) addPost(`p${i}`, `2026-10-2${i}T00:00:00Z`);
    let running = 0;
    let maxRunning = 0;
    const requests: ClassifyRequest[] = [];
    const inner = fakeClassifier(requests);
    const summary = await extractNewPosts({
      db,
      paths,
      runOcr: fakeOcr(),
      runClassifier: async (req) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await Bun.sleep(5);
        const out = await inner(req);
        running--;
        return out;
      },
      now,
      batchSize: 2,
    });
    expect(requests.map((r) => r.batchPath.split("/").at(-1))).toEqual([
      "batch-001.json",
      "batch-002.json",
      "batch-003.json",
    ]);
    expect(maxRunning).toBe(1);
    expect(summary).toMatchObject({ batches: 3, classified: 3, postsExtracted: 5, errors: [] });
  });

  test("no unextracted posts: returns early without OCR or spawning", async () => {
    let ocrCalled = false;
    let classifierCalled = false;
    const summary = await extractNewPosts({
      db,
      paths,
      runOcr: async () => {
        ocrCalled = true;
        return [];
      },
      runClassifier: async () => {
        classifierCalled = true;
        return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
      },
      now,
    });
    expect(ocrCalled).toBe(false);
    expect(classifierCalled).toBe(false);
    expect(summary).toMatchObject({ unextracted: 0, batches: 0, classified: 0, errors: [] });
    expect(existsSync(paths.extractionsDir)).toBe(false);
  });

  test("a non-zero exit is logged with stderr and its posts stay unextracted", async () => {
    addPost("p1");
    const logs: string[] = [];
    const summary = await extractNewPosts({
      db,
      paths,
      runOcr: fakeOcr(),
      // Even a result file written before the crash must not be imported.
      runClassifier: fakeClassifier([], { exitCode: 1, stderr: "API Error: overloaded" }),
      now,
      log: (m) => logs.push(m),
    });
    expect(extractedAt("p1")).toBeNull();
    expect(quoteTexts()).toEqual([]);
    expect(summary.classified).toBe(0);
    expect(summary.postsExtracted).toBe(0);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]?.stage).toBe("classify");
    expect(summary.errors[0]?.message).toContain("exited 1");
    expect(summary.errors[0]?.message).toContain("API Error: overloaded");
    expect(logs.join("\n")).toContain("API Error: overloaded");
    // The partial result is kept out of classified/ so it can't be assembled later.
    expect(existsSync(join(paths.extractionsDir, "classified", "batch-001.json"))).toBe(false);
  });

  test("a timeout leaves the posts unextracted", async () => {
    addPost("p1");
    const summary = await extractNewPosts({
      db,
      paths,
      runOcr: fakeOcr(),
      runClassifier: fakeClassifier([], { exitCode: null, timedOut: true }, { write: false }),
      now,
      log: () => {},
    });
    expect(extractedAt("p1")).toBeNull();
    expect(summary.errors.map((e) => e.message).join()).toContain("timed out");
  });

  test("an error result (is_error) with exit 0 counts as a failure", async () => {
    addPost("p1");
    const summary = await extractNewPosts({
      db,
      paths,
      runOcr: fakeOcr(),
      runClassifier: fakeClassifier([], { isError: true, stdout: "Credit balance is too low" }),
      now,
      log: () => {},
    });
    expect(extractedAt("p1")).toBeNull();
    expect(summary.errors[0]?.message).toContain("Credit balance is too low");
  });

  test("exit 0 without a result file is a failure", async () => {
    addPost("p1");
    const summary = await extractNewPosts({
      db,
      paths,
      runOcr: fakeOcr(),
      runClassifier: fakeClassifier([], {}, { write: false }),
      now,
      log: () => {},
    });
    expect(extractedAt("p1")).toBeNull();
    expect(summary.errors[0]?.message).toContain("no result file");
  });

  test("one failing batch doesn't stop the others", async () => {
    addPost("a", "2026-10-01T00:00:00Z");
    addPost("b", "2026-10-02T00:00:00Z");
    const ok = fakeClassifier([]);
    const summary = await extractNewPosts({
      db,
      paths,
      runOcr: fakeOcr(),
      runClassifier: async (req) =>
        req.batchPath.endsWith("batch-001.json")
          ? { exitCode: 2, timedOut: false, stdout: "", stderr: "boom" }
          : ok(req),
      now,
      batchSize: 1,
      log: () => {},
    });
    expect(extractedAt("a")).toBeNull();
    expect(extractedAt("b")).toBe(NOW.toISOString());
    expect(summary).toMatchObject({ batches: 2, classified: 1, postsExtracted: 1 });
    expect(summary.errors).toHaveLength(1);
  });

  test("a throwing classifier is reported, not thrown", async () => {
    addPost("p1");
    const summary = await extractNewPosts({
      db,
      paths,
      runOcr: fakeOcr(),
      runClassifier: async () => {
        throw new Error("spawn claude ENOENT");
      },
      now,
      log: () => {},
    });
    expect(extractedAt("p1")).toBeNull();
    expect(summary.errors[0]?.message).toContain("ENOENT");
  });

  test("OCR failures are reported and those posts are not classified", async () => {
    addPost("p1");
    const requests: ClassifyRequest[] = [];
    const summary = await extractNewPosts({
      db,
      paths,
      runOcr: async () => {
        throw new Error("OCR CLI timed out after 60000ms");
      },
      runClassifier: fakeClassifier(requests),
      now,
      log: () => {},
    });
    expect(requests).toHaveLength(0);
    expect(extractedAt("p1")).toBeNull();
    expect(summary.errors.map((e) => e.stage)).toContain("ocr");
    expect(summary.errors.map((e) => e.message).join()).toContain("timed out");
  });

  test("stale pending classification results are assembled and imported first", async () => {
    // A previous run classified p-old but crashed before assembling it.
    addPost("p-old", "2026-10-01T00:00:00Z");
    await extractNewPosts({
      db,
      paths,
      runOcr: fakeOcr(),
      runClassifier: fakeClassifier([]),
      now,
    });
    db.run("UPDATE posts SET extracted_at = NULL");
    db.run("DELETE FROM post_quotes");
    db.run("DELETE FROM quotes");
    const todo = join(paths.extractionsDir, "todo");
    const stale = writeClassificationBatches(db, {
      mediaDir: paths.mediaDir,
      ocrDir: paths.ocrDir,
      todoDir: todo,
    });
    const classified = join(paths.extractionsDir, "classified", "batch-001.json");
    writeFileSync(classified, JSON.stringify(cannedClassification(stale.batches[0] as string)));

    // Now a new post arrives.
    addPost("p-new", "2026-11-01T00:00:00Z");
    const requests: ClassifyRequest[] = [];
    const summary = await extractNewPosts({
      db,
      paths,
      runOcr: fakeOcr(),
      runClassifier: fakeClassifier(requests),
      now,
    });

    expect(summary.stale).toMatchObject({ classified: 1, postsExtracted: 1 });
    expect(extractedAt("p-old")).toBe(NOW.toISOString());
    expect(extractedAt("p-new")).toBe(NOW.toISOString());
    // Only the new post is classified again.
    expect(requests).toHaveLength(1);
    const batch = JSON.parse(seenBatches.get(requests[0]?.batchPath as string) as string);
    expect(batch.posts.map((p: { ig_media_id: string }) => p.ig_media_id)).toEqual(["p-new"]);
    expect(summary.errors).toEqual([]);
  });

  test("stale unimported extraction files are imported first", async () => {
    addPost("p1");
    mkdirSync(paths.extractionsDir, { recursive: true });
    writeFileSync(
      join(paths.extractionsDir, "batch-001.json"),
      JSON.stringify({
        results: [
          {
            ig_media_id: "p1",
            quotes: [
              {
                text: "A stale quote.",
                author: "X",
                source: null,
                found_in: "caption",
                confidence: 0.9,
              },
            ],
          },
        ],
      }),
    );
    const requests: ClassifyRequest[] = [];
    const summary = await extractNewPosts({
      db,
      paths,
      runOcr: fakeOcr(),
      runClassifier: fakeClassifier(requests),
      now,
    });
    expect(summary.stale).toMatchObject({ extractionFiles: 1, postsExtracted: 1 });
    expect(quoteTexts()).toEqual(["A stale quote."]);
    // p1 was extracted by the stale import, so nothing new is left to classify.
    expect(requests).toHaveLength(0);
    expect(summary.unextracted).toBe(0);
  });

  test("a result left in staging by an interrupted run is never imported", async () => {
    // The previous run was killed while (or right after) its agent wrote a result, before the
    // run was verified. That result is discarded, not assembled.
    addPost("p1");
    const staging = join(paths.extractionsDir, "classifying");
    mkdirSync(join(staging, "input"), { recursive: true });
    await runOcr(db, { mediaDir: paths.mediaDir, ocrDir: paths.ocrDir, runner: fakeOcr() });
    const todo = join(paths.extractionsDir, "todo");
    const { batches } = writeClassificationBatches(db, {
      mediaDir: paths.mediaDir,
      ocrDir: paths.ocrDir,
      todoDir: todo,
    });
    const leftover = join(staging, "batch-001.json");
    writeFileSync(leftover, JSON.stringify(cannedClassification(batches[0] as string)));

    const summary = await extractNewPosts({
      db,
      paths,
      runOcr: fakeOcr(),
      // This run's own agent fails, so nothing can legitimately mark p1 extracted.
      runClassifier: fakeClassifier([], { exitCode: 1 }, { write: false }),
      now,
      log: () => {},
    });
    expect(extractedAt("p1")).toBeNull();
    expect(quoteTexts()).toEqual([]);
    expect(summary.postsExtracted).toBe(0);
    expect(summary.errors.some((e) => e.stage === "stale" && e.subject === "batch-001.json")).toBe(
      true,
    );
    const failed = join(paths.extractionsDir, "classified", "failed");
    expect(existsSync(join(failed, "batch-001.json"))).toBe(true);
    expect(readFileSync(join(failed, "batch-001.json.error.txt"), "utf8")).toContain("interrupted");
    expect(existsSync(join(paths.extractionsDir, "classified", "batch-001.json"))).toBe(false);
  });

  test("pending files that can't be cleared are reported, nothing is spawned", async () => {
    addPost("p1");
    // A classification result without its todo batch can't be assembled.
    const classifiedDir = join(paths.extractionsDir, "classified");
    mkdirSync(classifiedDir, { recursive: true });
    writeFileSync(join(classifiedDir, "batch-001.json"), JSON.stringify({ results: [] }));
    const requests: ClassifyRequest[] = [];
    const summary = await extractNewPosts({
      db,
      paths,
      runOcr: fakeOcr(),
      runClassifier: fakeClassifier(requests),
      now,
      log: () => {},
    });
    expect(summary.errors.map((e) => e.stage)).toContain("stale");
    // The broken file was moved to classified/failed, so batches could still be written.
    expect(requests).toHaveLength(1);
    expect(extractedAt("p1")).toBe(NOW.toISOString());
  });
});

describe("extractNewPosts redo (#42)", () => {
  test("re-runs extraction for a post already marked no_quote", async () => {
    addPost("p1");
    markExtracted(db, getPostByIgMediaId(db, "p1")?.id ?? 0, "2026-01-01T00:00:00.000Z");
    const requests: ClassifyRequest[] = [];

    const skipped = await extractNewPosts({
      db,
      paths,
      runOcr: fakeOcr(),
      runClassifier: fakeClassifier(requests),
      now,
    });
    expect(skipped.unextracted).toBe(0);
    expect(requests).toHaveLength(0);

    const summary = await extractNewPosts({
      db,
      paths,
      runOcr: fakeOcr(),
      runClassifier: fakeClassifier(requests),
      now,
      redo: ["p1", "missing"],
    });
    expect(summary).toMatchObject({
      requeued: 1,
      unextracted: 1,
      classified: 1,
      postsExtracted: 1,
    });
    expect(summary.errors).toEqual([
      { stage: "redo", subject: "missing", message: "no post with this ig_media_id" },
    ]);
    expect(requests).toHaveLength(1);
    expect(extractedAt("p1")).toBe(NOW.toISOString());
    expect(quoteTexts()).toHaveLength(1);
  });
});
