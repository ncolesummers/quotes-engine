import { describe, expect, test } from "bun:test";
import {
  CLEAR_FILTERS,
  filterPatch,
  parseQuoteFilters,
  toQuoteSearchParams,
} from "./quote-filters";

const parse = (qs: string) => parseQuoteFilters(new URLSearchParams(qs));

describe("parseQuoteFilters", () => {
  test("defaults with no params", () => {
    expect(parse("")).toEqual({
      sort: "recent",
      author: null,
      bookId: null,
      posted: "any",
      reposted: false,
      noBook: false,
    });
  });

  test("reads every param", () => {
    expect(parse("sort=likes&author=Ken+Liu&book=3&posted=yes&reposted=1")).toEqual({
      sort: "likes",
      author: "Ken Liu",
      bookId: 3,
      posted: "yes",
      reposted: true,
      noBook: false,
    });
    expect(parse("posted=no&nobook=1")).toMatchObject({ posted: "no", noBook: true });
  });

  test.each([
    ["sort=bogus", { sort: "recent" }],
    ["posted=maybe", { posted: "any" }],
    ["book=abc", { bookId: null }],
    ["book=0", { bookId: null }],
    ["book=1.5", { bookId: null }],
    ["reposted=true", { reposted: false }],
    ["author=%20%20", { author: null }],
  ])("ignores bad value %s", (qs, expected) => {
    expect(parse(qs)).toMatchObject(expected);
  });

  test("a hand-edited URL with contradictory pairs keeps the stronger filter", () => {
    expect(parse("book=3&nobook=1")).toMatchObject({ bookId: 3, noBook: false });
    expect(parse("reposted=1&posted=no")).toMatchObject({ reposted: true, posted: "any" });
    expect(parse("reposted=1&posted=yes")).toMatchObject({ reposted: true, posted: "yes" });
  });
});

describe("toQuoteSearchParams", () => {
  test("maps filters to API params", () => {
    expect(
      toQuoteSearchParams({
        sort: "comments",
        author: "Seneca",
        bookId: 4,
        posted: "yes",
        reposted: true,
        noBook: false,
      }),
    ).toEqual({
      sort: "comments",
      authorExact: "Seneca",
      bookId: 4,
      posted: "yes",
      minPostings: 2,
      noBook: false,
    });
  });

  test("leaves inactive filters out", () => {
    expect(toQuoteSearchParams(parse(""))).toEqual({ sort: "recent", noBook: false });
  });
});

describe("filterPatch", () => {
  test("a book and “No book” exclude each other", () => {
    expect(filterPatch({ bookId: 3 })).toEqual({ book: "3", nobook: null });
    expect(filterPatch({ noBook: true })).toEqual({ nobook: "1", book: null });
    expect(filterPatch({ bookId: null })).toEqual({ book: null });
    expect(filterPatch({ noBook: false })).toEqual({ nobook: null });
  });

  test("“Reposted only” and “Never posted” exclude each other", () => {
    expect(filterPatch({ reposted: true })).toEqual({ reposted: "1", posted: null });
    expect(filterPatch({ posted: "no" })).toEqual({ posted: "no", reposted: null });
    expect(filterPatch({ posted: "yes" })).toEqual({ posted: "yes" });
    expect(filterPatch({ posted: "any" })).toEqual({ posted: null });
  });

  test("the default sort is left out of the URL", () => {
    expect(filterPatch({ sort: "recent" })).toEqual({ sort: null });
    expect(filterPatch({ sort: "likes" })).toEqual({ sort: "likes" });
  });

  test("author", () => {
    expect(filterPatch({ author: "Ken Liu" })).toEqual({ author: "Ken Liu" });
    expect(filterPatch({ author: null })).toEqual({ author: null });
  });
});

test("CLEAR_FILTERS removes every filter param but not q or sort", () => {
  expect(Object.keys(CLEAR_FILTERS).sort()).toEqual([
    "author",
    "book",
    "nobook",
    "posted",
    "reposted",
  ]);
});
