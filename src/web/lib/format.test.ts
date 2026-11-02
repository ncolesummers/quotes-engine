import { describe, expect, test } from "bun:test";
import { bookHref } from "./format";

describe("bookHref", () => {
  test("links to the book page when the id is known", () => {
    expect(bookHref("Fool's Errand", 12)).toBe("/books/12");
  });

  test("falls back to a books search by title", () => {
    expect(bookHref("Fool's Errand")).toBe("/books?q=Fool's%20Errand");
    expect(bookHref("Dune", null)).toBe("/books?q=Dune");
  });
});
