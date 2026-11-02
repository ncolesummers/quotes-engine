import { describe, expect, test } from "bun:test";
import { bookHref, formatHighlightCopy } from "./format";

describe("formatHighlightCopy", () => {
  test("quotes the text and attributes author and title", () => {
    expect(
      formatHighlightCopy({
        text: "  You have power over your mind.\n",
        book: { title: "Meditations", author: "Marcus Aurelius" },
      }),
    ).toBe("“You have power over your mind.” — Marcus Aurelius, Meditations");
  });

  test("drops whichever of author and title is missing", () => {
    expect(formatHighlightCopy({ text: "a", book: { title: "Walden", author: null } })).toBe(
      "“a” — Walden",
    );
    expect(formatHighlightCopy({ text: "a", book: { title: null, author: "Thoreau" } })).toBe(
      "“a” — Thoreau",
    );
    expect(formatHighlightCopy({ text: "a", book: { title: " ", author: null } })).toBe("“a”");
  });
});

describe("bookHref", () => {
  test("links to the book page when the id is known", () => {
    expect(bookHref("Fool's Errand", 12)).toBe("/books/12");
  });

  test("falls back to a books search by title", () => {
    expect(bookHref("Fool's Errand")).toBe("/books?q=Fool's%20Errand");
    expect(bookHref("Dune", null)).toBe("/books?q=Dune");
  });
});
