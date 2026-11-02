import { describe, expect, test } from "bun:test";
import {
  DUPLICATE_HINT_THRESHOLD,
  findDuplicateHints,
  looksLikeSeries,
  titleSimilarity,
} from "./book-title";

describe("titleSimilarity", () => {
  test("identical titles (after normalization) score 1", () => {
    expect(titleSimilarity("Senlin Ascends", "senlin ascends")).toBe(1);
    expect(titleSimilarity("Daisy Jones & The Six", "Daisy Jones and the Six")).toBe(1);
  });

  test("folds OCR look-alikes such as 1/I and 0/O", () => {
    expect(titleSimilarity("1Q84", "IQ84")).toBe(1);
    expect(titleSimilarity("D0ne", "Done")).toBe(1);
  });

  test("a title that starts another (a subtitle or 'and Other Stories') is a likely match", () => {
    const sapiens = titleSimilarity("Sapiens", "Sapiens: A Brief History of Humankind");
    expect(sapiens).toBeGreaterThanOrEqual(DUPLICATE_HINT_THRESHOLD);
    expect(sapiens).toBeLessThan(1);
    expect(
      titleSimilarity("The Paper Menagerie and Other Stories", "The Paper Menagerie"),
    ).toBeGreaterThanOrEqual(DUPLICATE_HINT_THRESHOLD);
  });

  test("a leading article alone doesn't make a prefix match", () => {
    expect(titleSimilarity("The", "The Name of the Wind")).toBeLessThan(DUPLICATE_HINT_THRESHOLD);
    expect(titleSimilarity("A", "A Game of Thrones")).toBeLessThan(DUPLICATE_HINT_THRESHOLD);
  });

  test("small typos score high, unrelated titles low", () => {
    expect(titleSimilarity("The Name of the Wind", "The Name of the Wnd")).toBeGreaterThanOrEqual(
      DUPLICATE_HINT_THRESHOLD,
    );
    expect(titleSimilarity("Dune", "Meditations")).toBeLessThan(DUPLICATE_HINT_THRESHOLD);
    expect(titleSimilarity("The Way of Kings", "The Way of Shadows")).toBeLessThan(
      DUPLICATE_HINT_THRESHOLD,
    );
  });

  test("empty titles never match", () => {
    expect(titleSimilarity(null, "Dune")).toBe(0);
    expect(titleSimilarity("", "")).toBe(0);
  });
});

describe("findDuplicateHints", () => {
  test("pairs each book with similar-titled others, best first", () => {
    const hints = findDuplicateHints([
      { id: 1, title: "1Q84" },
      { id: 2, title: "IQ84" },
      { id: 3, title: "Sapiens" },
      { id: 4, title: "Sapiens: A Brief History of Humankind" },
      { id: 5, title: "Dune" },
      { id: 6, title: null },
    ]);
    expect(hints.get(1)).toEqual([{ id: 2, score: 1 }]);
    expect(hints.get(2)).toEqual([{ id: 1, score: 1 }]);
    expect(hints.get(3)?.map((h) => h.id)).toEqual([4]);
    expect(hints.get(4)?.map((h) => h.id)).toEqual([3]);
    expect(hints.has(5)).toBe(false);
    expect(hints.has(6)).toBe(false);
  });
});

describe("looksLikeSeries", () => {
  test("flags series-style titles", () => {
    for (const t of [
      "The Books of Babel",
      "The Dandelion Dynasty",
      "The Expanse",
      "The Wheel of Time",
      "The Red Queen's War",
      "The Stormlight Archive",
      "The Chronicles of Narnia",
      "Mistborn Trilogy",
      "The Wayfarers Series",
    ]) {
      expect({ t, series: looksLikeSeries(t) }).toEqual({ t, series: true });
    }
  });

  test("leaves ordinary titles alone", () => {
    for (const t of [
      "Senlin Ascends",
      "The Name of the Wind",
      "War and Peace",
      "The Art of War",
      "Caliban's War",
      "The Wind-Up Bird Chronicle",
      "Dune",
      null,
    ]) {
      expect({ t, series: looksLikeSeries(t) }).toEqual({ t, series: false });
    }
  });
});
