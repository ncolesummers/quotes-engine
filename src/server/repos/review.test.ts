import { describe, expect, test } from "bun:test";
import { createTestDb } from "../../../test/helpers/db";
import { seed } from "../../../test/helpers/seed";
import { classifyMatch, normalizedSimilarity } from "../text/similarity";
import { mergeQuotes } from "./quotes";
import { dismissDuplicatePair, findDuplicatePairs } from "./review";

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

describe("dismissDuplicatePair", () => {
  function nearDuplicates() {
    const db = createTestDb();
    const s = seed(db);
    const a = s.quote({ text: "the only way out is through the forest of doubt and fear" });
    const b = s.quote({ text: "the only way out is through the forest of doubts and fear" });
    const c = s.quote({ text: "the only way out is through the forests of doubts and fears" });
    return { db, s, a, b, c };
  }
  const pairIds = (db: Parameters<typeof findDuplicatePairs>[0]) =>
    findDuplicatePairs(db).map((p) => [p.a.id, p.b.id]);

  test("hides the pair from findDuplicatePairs, leaving other pairs", () => {
    const { db, a, b, c } = nearDuplicates();
    expect(pairIds(db)).toContainEqual([a.id, b.id]);
    expect(dismissDuplicatePair(db, a.id, b.id)).toBe(true);
    const after = pairIds(db);
    expect(after).not.toContainEqual([a.id, b.id]);
    expect(after).toContainEqual([b.id, c.id]);
  });

  test("is order-independent and idempotent", () => {
    const { db, a, b } = nearDuplicates();
    expect(dismissDuplicatePair(db, b.id, a.id)).toBe(true);
    expect(dismissDuplicatePair(db, a.id, b.id)).toBe(true);
    expect(pairIds(db)).not.toContainEqual([a.id, b.id]);
    const rows = db.query("SELECT a_id AS aId, b_id AS bId FROM quote_not_duplicates").all();
    expect(rows).toEqual([{ aId: a.id, bId: b.id }]);
  });

  test("returns false for an unknown quote or the same quote twice", () => {
    const { db, a } = nearDuplicates();
    expect(dismissDuplicatePair(db, a.id, 9999)).toBe(false);
    expect(() => dismissDuplicatePair(db, a.id, a.id)).toThrow();
  });

  test("a dismissal goes away with a merged-away quote", () => {
    const { db, a, b } = nearDuplicates();
    dismissDuplicatePair(db, a.id, b.id);
    mergeQuotes(db, a.id, b.id);
    expect(db.query("SELECT COUNT(*) AS n FROM quote_not_duplicates").get()).toEqual({ n: 0 });
  });

  test("a merged-away quote's other dismissals carry over to the kept quote", () => {
    const { db, a, b, c } = nearDuplicates();
    dismissDuplicatePair(db, b.id, c.id);
    mergeQuotes(db, a.id, b.id);
    const rows = db.query("SELECT a_id AS aId, b_id AS bId FROM quote_not_duplicates").all();
    expect(rows).toEqual([{ aId: a.id, bId: c.id }]);
  });

  test("carried-over dismissals keep the lower id first", () => {
    const { db, a, b, c } = nearDuplicates();
    dismissDuplicatePair(db, a.id, b.id);
    mergeQuotes(db, c.id, b.id);
    const rows = db.query("SELECT a_id AS aId, b_id AS bId FROM quote_not_duplicates").all();
    expect(rows).toEqual([{ aId: a.id, bId: c.id }]);
  });
});
