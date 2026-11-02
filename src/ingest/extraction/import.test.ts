import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../../../test/helpers/db";
import { getPost, upsertPost } from "../../server/repos/posts";
import { upsertQuote } from "../../server/repos/quotes";
import { type ImportOptions, importExtractions, listExtractionFiles } from "./import";

const NOW = new Date("2026-03-01T12:00:00.000Z");
const WILDE = "Be yourself; everyone else is already taken.";

let db: Database;
let root: string;
let opts: ImportOptions;

beforeEach(() => {
  db = createTestDb();
  root = mkdtempSync(join(tmpdir(), "quotes-extractions-"));
  opts = {
    importedDir: join(root, "imported"),
    failedDir: join(root, "failed"),
    now: () => NOW,
  };
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function writeFile(name: string, content: unknown): string {
  const path = join(root, name);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

function quote(text: string, extra: Record<string, unknown> = {}) {
  return { text, author: null, source: null, found_in: "caption", confidence: 0.95, ...extra };
}

function links() {
  return db
    .query(
      `SELECT p.ig_media_id AS igMediaId, q.text, pq.method, pq.confidence, pq.status
       FROM post_quotes pq JOIN posts p ON p.id = pq.post_id JOIN quotes q ON q.id = pq.quote_id
       ORDER BY p.ig_media_id, q.text`,
    )
    .all();
}

function count(table: string): number {
  return (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("importExtractions", () => {
  test("a valid file creates quotes and links, marks posts extracted and moves the file", () => {
    const p1 = upsertPost(db, { igMediaId: "ig1" });
    const p2 = upsertPost(db, { igMediaId: "ig2" });
    const file = writeFile("batch.json", {
      results: [
        {
          ig_media_id: "ig1",
          quotes: [
            quote(WILDE, {
              author: "Oscar Wilde",
              source: "De Profundis",
              found_in: "image",
              confidence: 0.9,
            }),
          ],
          no_quote: false,
        },
        { ig_media_id: "ig2", quotes: [], no_quote: true },
      ],
    });

    const summary = importExtractions(db, [file], opts);

    expect(summary).toEqual({
      filesImported: 1,
      filesFailed: 0,
      postsExtracted: 2,
      quotesCreated: 1,
      quotesLinked: 1,
      needsReview: 0,
      errors: [],
    });
    expect(links()).toEqual([
      { igMediaId: "ig1", text: WILDE, method: "image", confidence: 0.9, status: "confirmed" },
    ]);
    expect(db.query("SELECT author, source_title AS sourceTitle FROM quotes").get()).toEqual({
      author: "Oscar Wilde",
      sourceTitle: "De Profundis",
    });
    expect(getPost(db, p1.id)?.extractedAt).toBe(NOW.toISOString());
    expect(getPost(db, p2.id)?.extractedAt).toBe(NOW.toISOString());
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(opts.importedDir, "batch.json"))).toBe(true);
  });

  test("found_in caption or both links with method caption", () => {
    upsertPost(db, { igMediaId: "ig1" });
    const file = writeFile("a.json", {
      results: [
        {
          ig_media_id: "ig1",
          quotes: [
            quote("Alpha quote about the sea.", { found_in: "caption" }),
            quote("Beta quote about the mountains.", { found_in: "both" }),
          ],
        },
      ],
    });
    importExtractions(db, [file], opts);
    expect(links().map((l) => (l as { method: string }).method)).toEqual(["caption", "caption"]);
  });

  test("the same quote on two posts yields one quote with two postings", () => {
    upsertPost(db, { igMediaId: "ig1" });
    upsertPost(db, { igMediaId: "ig2" });
    const file = writeFile("a.json", {
      results: [
        { ig_media_id: "ig1", quotes: [quote(WILDE)] },
        { ig_media_id: "ig2", quotes: [quote(`"${WILDE.toUpperCase()}"`)] },
      ],
    });

    const summary = importExtractions(db, [file], opts);

    expect(count("quotes")).toBe(1);
    expect(count("post_quotes")).toBe(2);
    expect(summary.quotesCreated).toBe(1);
    expect(summary.quotesLinked).toBe(2);
  });

  test("confidence below 0.8 is linked as needs_review", () => {
    upsertPost(db, { igMediaId: "ig1" });
    const file = writeFile("a.json", {
      results: [{ ig_media_id: "ig1", quotes: [quote(WILDE, { confidence: 0.79 })] }],
    });
    const summary = importExtractions(db, [file], opts);
    expect(links()).toMatchObject([{ status: "needs_review", confidence: 0.79 }]);
    expect(summary.needsReview).toBe(1);
  });

  test("a likely (near-duplicate) match is linked as needs_review", () => {
    upsertQuote(db, {
      text: "Waste no more time arguing about what a good man should be. Be one.",
    });
    upsertPost(db, { igMediaId: "ig1" });
    const file = writeFile("a.json", {
      results: [
        {
          ig_media_id: "ig1",
          quotes: [
            quote("Waste no more time arguing about what a good man shoud be. Be one.", {
              confidence: 1,
            }),
          ],
        },
      ],
    });
    const content = readFileSync(file, "utf8");
    expect(importExtractions(db, [file], opts).needsReview).toBe(1);
    expect(links()).toMatchObject([{ status: "needs_review" }]);

    // On re-import the text now matches exactly, but the stored link still needs review.
    const again = importExtractions(db, [writeFile("a.json", content)], opts);
    expect(again.needsReview).toBe(1);
  });

  test("an archive name collision keeps both files (and pairs the error sidecar)", () => {
    upsertPost(db, { igMediaId: "ig1" });
    const good = { results: [{ ig_media_id: "ig1", quotes: [quote(WILDE)] }] };
    importExtractions(db, [writeFile("a.json", good)], opts);
    importExtractions(db, [writeFile("a.json", { ...good, marker: 2 })], opts);
    importExtractions(db, [writeFile("b.json", "bad")], opts);
    importExtractions(db, [writeFile("b.json", "worse")], opts);

    expect(JSON.parse(readFileSync(join(opts.importedDir, "a.json"), "utf8"))).toEqual(good);
    expect(JSON.parse(readFileSync(join(opts.importedDir, "a-1.json"), "utf8")).marker).toBe(2);
    expect(readFileSync(join(opts.failedDir, "b.json"), "utf8")).toBe("bad");
    expect(readFileSync(join(opts.failedDir, "b-1.json"), "utf8")).toBe("worse");
    expect(existsSync(join(opts.failedDir, "b.json.error.txt"))).toBe(true);
    expect(existsSync(join(opts.failedDir, "b-1.json.error.txt"))).toBe(true);
  });

  test("an invalid JSON shape moves the file to failed/ with the error and writes nothing", () => {
    upsertPost(db, { igMediaId: "ig1" });
    const file = writeFile("bad.json", {
      results: [{ ig_media_id: "ig1", quotes: [quote(WILDE, { found_in: "video" })] }],
    });

    const summary = importExtractions(db, [file], opts);

    expect(summary.filesFailed).toBe(1);
    expect(summary.filesImported).toBe(0);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]?.file).toBe(file);
    expect(count("quotes")).toBe(0);
    expect(count("post_quotes")).toBe(0);
    expect(db.query("SELECT extracted_at FROM posts").get()).toEqual({ extracted_at: null });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(opts.failedDir, "bad.json"))).toBe(true);
    expect(readFileSync(join(opts.failedDir, "bad.json.error.txt"), "utf8")).toContain("found_in");
  });

  test("unparseable JSON is moved to failed/", () => {
    const file = writeFile("broken.json", "{ not json");
    const summary = importExtractions(db, [file], opts);
    expect(summary.filesFailed).toBe(1);
    expect(existsSync(join(opts.failedDir, "broken.json"))).toBe(true);
    expect(existsSync(join(opts.failedDir, "broken.json.error.txt"))).toBe(true);
  });

  test("an unknown ig_media_id is a per-result error; other results still import", () => {
    upsertPost(db, { igMediaId: "ig1" });
    const file = writeFile("a.json", {
      results: [
        { ig_media_id: "nope", quotes: [quote("Some other quote entirely here.")] },
        { ig_media_id: "ig1", quotes: [quote(WILDE)] },
      ],
    });

    const summary = importExtractions(db, [file], opts);

    expect(summary.filesImported).toBe(1);
    expect(summary.postsExtracted).toBe(1);
    expect(summary.errors).toEqual([
      { file, igMediaId: "nope", message: expect.stringContaining("nope") },
    ]);
    expect(count("quotes")).toBe(1);
    expect(existsSync(join(opts.importedDir, "a.json"))).toBe(true);
  });

  test("a quote that normalizes to empty rolls back only its result", () => {
    upsertPost(db, { igMediaId: "ig1" });
    upsertPost(db, { igMediaId: "ig2" });
    const file = writeFile("a.json", {
      results: [
        { ig_media_id: "ig1", quotes: [quote("A fine quote to keep."), quote("...")] },
        { ig_media_id: "ig2", quotes: [quote(WILDE)] },
      ],
    });

    const summary = importExtractions(db, [file], opts);

    expect(summary.errors).toMatchObject([{ igMediaId: "ig1" }]);
    expect(links()).toMatchObject([{ igMediaId: "ig2", text: WILDE }]);
    expect(db.query("SELECT extracted_at FROM posts WHERE ig_media_id = 'ig1'").get()).toEqual({
      extracted_at: null,
    });
  });

  test("re-importing the same file is idempotent", () => {
    upsertPost(db, { igMediaId: "ig1" });
    upsertPost(db, { igMediaId: "ig2" });
    const content = {
      results: [
        { ig_media_id: "ig1", quotes: [quote(WILDE, { confidence: 0.5 })] },
        { ig_media_id: "ig2", quotes: [quote(WILDE), quote("Another distinct quote, friend.")] },
      ],
    };
    importExtractions(db, [writeFile("a.json", content)], opts);
    const before = links();

    const summary = importExtractions(db, [writeFile("a.json", content)], opts);

    expect(links()).toEqual(before);
    expect(count("quotes")).toBe(2);
    expect(summary.quotesCreated).toBe(0);
    expect(summary.errors).toEqual([]);
    expect(existsSync(join(opts.importedDir, "a.json"))).toBe(true);
  });
});

describe("listExtractionFiles", () => {
  test("lists top-level .json files sorted, ignoring subdirectories and other files", () => {
    mkdirSync(join(root, "imported"));
    writeFileSync(join(root, "imported", "old.json"), "{}");
    writeFileSync(join(root, "b.json"), "{}");
    writeFileSync(join(root, "a.json"), "{}");
    writeFileSync(join(root, "notes.txt"), "");
    expect(listExtractionFiles(root)).toEqual([join(root, "a.json"), join(root, "b.json")]);
  });

  test("returns [] when the directory does not exist", () => {
    expect(listExtractionFiles(join(root, "missing"))).toEqual([]);
  });
});
