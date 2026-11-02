import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { createTestDb } from "../../../test/helpers/db";
import { type Seeder, seed } from "../../../test/helpers/seed";
import { listAuthors } from "./authors";

let db: Database;
let s: Seeder;

beforeEach(() => {
  db = createTestDb();
  s = seed(db);
});

describe("listAuthors", () => {
  test("distinct authors with quote counts, sorted by name ignoring case", () => {
    s.quote({ text: "one", author: "Robin Hobb" });
    s.quote({ text: "two", author: "Robin Hobb" });
    s.quote({ text: "three", author: "ken Liu" });
    s.quote({ text: "four", author: "Anne Carson" });
    expect(listAuthors(db)).toEqual([
      { name: "Anne Carson", quoteCount: 1 },
      { name: "ken Liu", quoteCount: 1 },
      { name: "Robin Hobb", quoteCount: 2 },
    ]);
  });

  test("skips quotes without an author", () => {
    s.quote({ text: "anon", author: null });
    s.quote({ text: "blank", author: "  " });
    s.quote({ text: "named", author: "Seneca" });
    expect(listAuthors(db)).toEqual([{ name: "Seneca", quoteCount: 1 }]);
  });

  test("names are trimmed, so padded duplicates count as one (they match authorExact)", () => {
    s.quote({ text: "a", author: "Seneca" });
    s.quote({ text: "b", author: "Seneca " });
    expect(listAuthors(db)).toEqual([{ name: "Seneca", quoteCount: 2 }]);
  });

  test("empty archive -> []", () => {
    expect(listAuthors(db)).toEqual([]);
  });
});
