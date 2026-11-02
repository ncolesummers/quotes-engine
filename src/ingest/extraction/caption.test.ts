import { describe, expect, test } from "bun:test";
import { captionSegments, stripCaption, stripOuterQuotes } from "./caption";

describe("stripCaption", () => {
  test("removes hashtags and 📖 attribution lines", () => {
    expect(
      stripCaption(
        "Be the change you wish to see.\n📖 The Blade Itself — Joe Abercrombie\n#joeabercrombie",
      ),
    ).toBe("Be the change you wish to see.");
    expect(stripCaption("A line #tag inside.\n\nSecond para #x #y")).toBe(
      "A line inside.\n\nSecond para",
    );
  });

  test("removes spacer lines of dots and returns '' for nothing left", () => {
    expect(stripCaption("Quote.\n.\n.\n#a #b")).toBe("Quote.");
    expect(stripCaption("#a #b")).toBe("");
    expect(stripCaption(null)).toBe("");
  });
});

describe("captionSegments", () => {
  test("splits a quoted span away from the account's commentary on the same line", () => {
    expect(
      captionSegments(
        "“An environment tells you how to live in it.” Jessyn says it like an observation.\n#tag",
      ),
    ).toEqual([
      "“An environment tells you how to live in it.”",
      "Jessyn says it like an observation.",
    ]);
  });

  test("gives each remaining line its own segment", () => {
    expect(
      captionSegments(
        "As Abercrombie writes in The Devils:\n“We’ve got to grasp at any joy we can.”\nMaybe so.",
      ),
    ).toEqual([
      "As Abercrombie writes in The Devils:",
      "“We’ve got to grasp at any joy we can.”",
      "Maybe so.",
    ]);
  });

  test("separates a trailing attribution and drops spacers, tags and 📖 lines", () => {
    expect(
      captionSegments(
        "“If you only read the books…” ― Haruki Murakami, Norwegian Wood\n.\n.\n📖 Norwegian Wood · Haruki Murakami\n#a #b",
      ),
    ).toEqual(["“If you only read the books…”", "― Haruki Murakami, Norwegian Wood"]);
  });

  test("keeps a quote that spans several lines as one segment", () => {
    expect(captionSegments("“First line\nsecond line.” Nice.")).toEqual([
      "“First line second line.”",
      "Nice.",
    ]);
  });

  test("is empty for an empty or tag-only caption", () => {
    expect(captionSegments(null)).toEqual([]);
    expect(captionSegments("#a #b")).toEqual([]);
  });
});

describe("stripOuterQuotes", () => {
  test("removes quote marks wrapping the whole text", () => {
    expect(stripOuterQuotes("“To be or not to be.”")).toBe("To be or not to be.");
    expect(stripOuterQuotes('"Plain quotes."')).toBe("Plain quotes.");
  });

  test("leaves text alone when the marks don't wrap all of it", () => {
    expect(stripOuterQuotes("“One,” he said, “two.”")).toBe("“One,” he said, “two.”");
    expect(stripOuterQuotes("No quotes.")).toBe("No quotes.");
    expect(stripOuterQuotes("“Unclosed")).toBe("“Unclosed");
  });
});

describe("captionSegments with straight quotes", () => {
  test("splits a straight-quoted span away from an attribution on the same line", () => {
    expect(captionSegments('"Fear is the mind-killer." - Frank Herbert, Dune')).toEqual([
      '"Fear is the mind-killer."',
      "- Frank Herbert, Dune",
    ]);
  });
});
