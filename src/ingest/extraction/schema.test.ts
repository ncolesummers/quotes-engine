import { describe, expect, test } from "bun:test";
import { ExtractionFileSchema } from "./schema";

const valid = {
  results: [
    {
      ig_media_id: "ig1",
      quotes: [
        {
          text: "Be yourself.",
          author: "Oscar Wilde",
          source: null,
          found_in: "image",
          confidence: 0.9,
        },
      ],
      no_quote: false,
    },
  ],
};

describe("ExtractionFileSchema", () => {
  test("accepts a well-formed result file", () => {
    const parsed = ExtractionFileSchema.parse(valid);
    expect(parsed.results[0]?.quotes[0]?.found_in).toBe("image");
  });

  test("defaults missing author/source to null, quotes to [] and no_quote to false", () => {
    const parsed = ExtractionFileSchema.parse({
      results: [
        { ig_media_id: "ig1", quotes: [{ text: "x", found_in: "caption", confidence: 1 }] },
        { ig_media_id: "ig2", no_quote: true },
      ],
    });
    expect(parsed.results[0]?.quotes[0]).toMatchObject({ author: null, source: null });
    expect(parsed.results[0]?.no_quote).toBe(false);
    expect(parsed.results[1]?.quotes).toEqual([]);
  });

  test.each([
    ["missing results", {}],
    ["empty ig_media_id", { results: [{ ig_media_id: "", quotes: [] }] }],
    [
      "unknown found_in",
      {
        results: [{ ig_media_id: "a", quotes: [{ text: "x", found_in: "video", confidence: 1 }] }],
      },
    ],
    [
      "confidence above 1",
      {
        results: [
          { ig_media_id: "a", quotes: [{ text: "x", found_in: "image", confidence: 1.5 }] },
        ],
      },
    ],
    [
      "blank text",
      {
        results: [{ ig_media_id: "a", quotes: [{ text: "  ", found_in: "image", confidence: 1 }] }],
      },
    ],
  ])("rejects %s", (_name, input) => {
    expect(ExtractionFileSchema.safeParse(input).success).toBe(false);
  });
});
