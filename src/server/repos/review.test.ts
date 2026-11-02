import { describe, expect, test } from "bun:test";
import { createTestDb } from "../../../test/helpers/db";
import { seed } from "../../../test/helpers/seed";
import { classifyMatch, normalizedSimilarity } from "../text/similarity";
import { findDuplicatePairs } from "./review";

describe("findDuplicatePairs", () => {
  test("matches a brute-force normalizedSimilarity scan", () => {
    const db = createTestDb();
    const s = seed(db);
    const words = "life love wisdom courage time mind heart soul fear hope".split(" ");
    const quotes = [];
    for (let i = 0; i < 120; i++) {
      const n = 4 + (i % 9);
      const text = Array.from({ length: n }, (_, k) => words[(i * 3 + k * 7 + i * k) % 10]).join(
        " ",
      );
      quotes.push(s.quote({ text: `${text} ${i % 40}` }));
    }

    const expected: string[] = [];
    for (let i = 0; i < quotes.length; i++) {
      for (let j = i + 1; j < quotes.length; j++) {
        const a = quotes[i];
        const b = quotes[j];
        if (!a || !b) continue;
        const score = normalizedSimilarity(a.normalizedText, b.normalizedText);
        if (classifyMatch(score) !== "different") expected.push(`${a.id}-${b.id}:${score}`);
      }
    }
    expect(expected.length).toBeGreaterThan(0);

    const actual = findDuplicatePairs(db).map((p) => `${p.a.id}-${p.b.id}:${p.score}`);
    expect(actual.sort()).toEqual(expected.sort());
  });

  test("orders by score descending with the lower id as `a`", () => {
    const db = createTestDb();
    const s = seed(db);
    const far = s.quote({ text: "the only way out is through the forest of doubt and fear" });
    const near = s.quote({ text: "the only way out is through the forest of doubts and fear" });
    s.quote({ text: "the only way out is through the forests of doubts and fears" });
    s.quote({ text: "nothing alike" });
    const pairs = findDuplicatePairs(db);
    expect(pairs.length).toBeGreaterThan(1);
    expect(pairs[0]).toMatchObject({ a: { id: far.id }, b: { id: near.id } });
    for (let i = 1; i < pairs.length; i++) {
      expect((pairs[i - 1]?.score ?? 0) >= (pairs[i]?.score ?? 0)).toBe(true);
    }
    for (const p of pairs) expect(p.a.id).toBeLessThan(p.b.id);
  });
});
