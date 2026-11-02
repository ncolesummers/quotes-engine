import { describe, expect, test } from "bun:test";
import {
  classifyMatch,
  LIKELY_THRESHOLD,
  type MatchClass,
  SAME_THRESHOLD,
  trigramSimilarity,
} from "./similarity";

const QUOTE = "The impediment to action advances action. What stands in the way becomes the way.";

describe("trigramSimilarity", () => {
  const exact: Array<[label: string, a: string, b: string, expected: number]> = [
    ["identical strings", QUOTE, QUOTE, 1],
    [
      "same quote, different formatting and attribution",
      QUOTE,
      `\u201C${QUOTE.toUpperCase()}\u201D \u2014 Marcus Aurelius #stoicism`,
      1,
    ],
    ["both empty", "", "", 1],
    ["both normalize to empty", "\u{1F525}", "#motivation", 1],
    ["one empty", QUOTE, "", 0],
    ["other empty", "", QUOTE, 0],
    ["no shared trigrams", "abc", "xyz", 0],
  ];

  test.each(exact)("%s = %p", (_label, a, b, expected) => {
    expect(trigramSimilarity(a, b)).toBe(expected);
  });

  const similar: Array<[label: string, a: string, b: string]> = [
    [
      "one-word typo",
      QUOTE,
      "The impediment to action advances acton. What stands in the way becomes the way.",
    ],
    [
      "one-word substitution",
      QUOTE,
      "The impediment to action advances action. What stands in the path becomes the way.",
    ],
  ];

  test.each(similar)("%s scores >= LIKELY_THRESHOLD", (_label, a, b) => {
    const score = trigramSimilarity(a, b);
    expect(score).toBeGreaterThanOrEqual(LIKELY_THRESHOLD);
    expect(score).toBeLessThan(1);
  });

  const unrelated: Array<[label: string, a: string, b: string]> = [
    ["unrelated quotes", QUOTE, "We suffer more often in imagination than in reality."],
    ["short unrelated words", "cat", "dog"],
  ];

  test.each(unrelated)("%s scores < 0.3", (_label, a, b) => {
    expect(trigramSimilarity(a, b)).toBeLessThan(0.3);
  });

  test("is symmetric", () => {
    const a = QUOTE;
    const b = "What stands in the way becomes the way.";
    expect(trigramSimilarity(a, b)).toBe(trigramSimilarity(b, a));
  });

  test("stays within 0..1", () => {
    const score = trigramSimilarity("action advances", "advances action");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});

describe("classifyMatch", () => {
  test("thresholds match the spec", () => {
    expect(SAME_THRESHOLD).toBe(0.97);
    expect(LIKELY_THRESHOLD).toBe(0.85);
  });

  const cases: Array<[score: number, expected: MatchClass]> = [
    [1, "same"],
    [0.97, "same"],
    [0.9699, "likely"],
    [0.9, "likely"],
    [0.85, "likely"],
    [0.8499, "different"],
    [0.3, "different"],
    [0, "different"],
  ];

  test.each(cases)("%p -> %s", (score, expected) => {
    expect(classifyMatch(score)).toBe(expected);
  });
});
