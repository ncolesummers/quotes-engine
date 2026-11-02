import { describe, expect, test } from "bun:test";
import { ClassificationFileSchema, ClassifiedQuoteSchema } from "./classification-schema";

const base = { author: "Joe Abercrombie", source: null, confidence: 0.9 };

describe("ClassifiedQuoteSchema", () => {
  test("accepts an image line range and defaults from_caption to false", () => {
    const q = ClassifiedQuoteSchema.parse({ ...base, image: 1, lines: [0, 3] });
    expect(q).toEqual({ ...base, image: 1, lines: [0, 3], from_caption: false });
  });

  test("accepts a caption-only quote without line refs", () => {
    const q = ClassifiedQuoteSchema.parse({ ...base, from_caption: true });
    expect(q.image).toBeNull();
    expect(q.lines).toBeNull();
  });

  test("rejects a quote with neither line refs nor from_caption", () => {
    expect(ClassifiedQuoteSchema.safeParse(base).success).toBe(false);
  });

  test("rejects half a line ref, and a reversed range", () => {
    expect(ClassifiedQuoteSchema.safeParse({ ...base, image: 1 }).success).toBe(false);
    expect(ClassifiedQuoteSchema.safeParse({ ...base, lines: [0, 1] }).success).toBe(false);
    expect(ClassifiedQuoteSchema.safeParse({ ...base, image: 1, lines: [3, 1] }).success).toBe(
      false,
    );
  });

  test("rejects quote text written by the agent", () => {
    const parsed = ClassifiedQuoteSchema.safeParse({ ...base, image: 1, lines: [0, 0], text: "x" });
    expect(parsed.success).toBe(false);
  });
});

describe("ClassificationFileSchema", () => {
  test("defaults quotes and no_quote", () => {
    expect(ClassificationFileSchema.parse({ results: [{ ig_media_id: "1" }] })).toEqual({
      results: [{ ig_media_id: "1", quotes: [], no_quote: false }],
    });
  });
});
