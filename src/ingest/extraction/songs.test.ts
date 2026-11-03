// Songs as a quote source in extraction (#42). The repo is public: every lyric, artist and song
// title here is invented.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../../../test/helpers/db";
import { upsertPost } from "../../server/repos/posts";
import { assembleResult } from "./assemble";
import { stripOuterQuotes } from "./caption";
import { buildClassificationPrompt, CLASSIFICATION_EXAMPLE } from "./classification-prompt";
import { ClassificationFileSchema, ClassifiedQuoteSchema } from "./classification-schema";
import { importExtractions } from "./import";
import { buildExtractionPrompt, EXAMPLE_OUTPUT } from "./prompt";
import { ExtractionFileSchema } from "./schema";

const LYRIC = "Static on the radio, lanterns in the rain";

describe("ExtractionFileSchema kind", () => {
  const q = { text: LYRIC, found_in: "caption", confidence: 0.9 };
  const file = (quote: Record<string, unknown>) => ({
    results: [{ ig_media_id: "ig1", quotes: [quote] }],
  });
  const kindOf = (quote: Record<string, unknown>) =>
    ExtractionFileSchema.parse(file(quote)).results[0]?.quotes[0]?.kind;

  test("defaults to book", () => {
    expect(kindOf(q)).toBe("book");
  });

  test("accepts song and other, rejects anything else", () => {
    expect(kindOf({ ...q, kind: "song" })).toBe("song");
    expect(kindOf({ ...q, kind: "other" })).toBe("other");
    expect(ExtractionFileSchema.safeParse(file({ ...q, kind: "poem" })).success).toBe(false);
  });

  test("null means book, like the other nullable fields", () => {
    expect(kindOf({ ...q, kind: null })).toBe("book");
  });
});

describe("ClassifiedQuoteSchema kind", () => {
  const base = { author: "Paper Lanterns", source: "Northbound Static", confidence: 0.9 };

  test("defaults to book and accepts song", () => {
    expect(ClassifiedQuoteSchema.parse({ ...base, from_caption: true }).kind).toBe("book");
    const song = ClassifiedQuoteSchema.parse({ ...base, from_caption: true, kind: "song" });
    expect(song.kind).toBe("song");
  });

  test("null means book", () => {
    expect(ClassifiedQuoteSchema.parse({ ...base, from_caption: true, kind: null }).kind).toBe(
      "book",
    );
  });

  test("rejects an unknown kind", () => {
    const parsed = ClassifiedQuoteSchema.safeParse({ ...base, from_caption: true, kind: "x" });
    expect(parsed.success).toBe(false);
  });
});

describe("stripOuterQuotes with music notes", () => {
  test("removes music-note markers wrapping a lyric", () => {
    expect(stripOuterQuotes(`🎵 ${LYRIC} 🎵`)).toBe(LYRIC);
    expect(stripOuterQuotes("♪ Made-up line ♪")).toBe("Made-up line");
    expect(stripOuterQuotes("🎶“Another invented line”🎶")).toBe("Another invented line");
  });

  test("removes notes carrying a U+FE0F variation selector", () => {
    expect(stripOuterQuotes(`🎵\uFE0F ${LYRIC} 🎵\uFE0F`)).toBe(LYRIC);
    expect(stripOuterQuotes(`♪\uFE0F${LYRIC}♪\uFE0F`)).toBe(LYRIC);
  });

  test("leaves a note inside the text alone", () => {
    expect(stripOuterQuotes("Hum ♪ along")).toBe("Hum ♪ along");
  });
});

describe("assembleResult kind", () => {
  test("carries a song's kind into the extraction, without the music notes", () => {
    const post = {
      ig_media_id: "p1",
      posted_at: null,
      caption: `🎵 ${LYRIC} 🎵\n#paperlanterns`,
      caption_lines: [],
      images: [],
    };
    const r = assembleResult(
      {
        ig_media_id: "p1",
        no_quote: false,
        quotes: [
          ClassifiedQuoteSchema.parse({
            from_caption: true,
            kind: "song",
            author: "Paper Lanterns",
            source: "Northbound Static",
            confidence: 0.85,
          }),
        ],
      },
      post,
      null,
    );
    expect(r.quotes[0]).toEqual({
      text: LYRIC,
      author: "Paper Lanterns",
      source: "Northbound Static",
      kind: "song",
      found_in: "caption",
      confidence: 0.85,
    });
  });
});

describe("importExtractions kind", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "quotes-songs-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("a song creates no books row and is stored as a song", () => {
    const db = createTestDb();
    upsertPost(db, { igMediaId: "ig1" });
    const file = join(root, "batch.json");
    writeFileSync(
      file,
      JSON.stringify({
        results: [
          {
            ig_media_id: "ig1",
            quotes: [
              {
                text: LYRIC,
                author: "Paper Lanterns",
                source: "Northbound Static",
                kind: "song",
                found_in: "caption",
                confidence: 0.9,
              },
            ],
          },
        ],
      }),
    );
    const summary = importExtractions(db, [file], {
      importedDir: join(root, "imported"),
      failedDir: join(root, "failed"),
    });
    expect(summary.errors).toEqual([]);
    expect(summary.quotesCreated).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM books").get()).toEqual({ n: 0 });
    expect(
      db
        .query(
          "SELECT source_kind AS kind, author, source_title AS title, book_id AS bookId FROM quotes",
        )
        .get(),
    ).toEqual({ kind: "song", author: "Paper Lanterns", title: "Northbound Static", bookId: null });
  });
});

describe("prompts know about songs", () => {
  const paths = { batchPath: "/x/todo/batch-001.json", outPath: "/x/out/batch-001.json" };

  for (const [name, prompt] of [
    ["extraction", buildExtractionPrompt(paths)],
    ["classification", buildClassificationPrompt(paths)],
  ] as const) {
    test(`${name} prompt: lyrics are quotes, artist in author, song in source, kind`, () => {
      expect(prompt).toContain("Lyrics are quotes");
      expect(prompt).toContain("artist");
      expect(prompt).toContain('"kind"');
      expect(prompt).toContain('"song"');
      expect(prompt).toContain("🎵");
      expect(prompt).toContain("♪");
    });
  }

  test("the classification prompt still forbids writing out lyric text", () => {
    const prompt = buildClassificationPrompt(paths);
    expect(prompt).toContain("Never write quote text");
    expect(prompt).toMatch(/lyric/i);
  });

  test("both examples include a valid song entry", () => {
    const extraction = ExtractionFileSchema.parse(EXAMPLE_OUTPUT);
    expect(extraction.results.flatMap((r) => r.quotes).some((q) => q.kind === "song")).toBe(true);
    const classification = ClassificationFileSchema.parse(CLASSIFICATION_EXAMPLE);
    expect(classification.results.flatMap((r) => r.quotes).some((q) => q.kind === "song")).toBe(
      true,
    );
  });
});
