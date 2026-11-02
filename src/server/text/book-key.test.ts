import { describe, expect, test } from "bun:test";
import { bookKey, bookTitleKey } from "./book-key";

describe("bookKey", () => {
  test("joins normalized title and author with a pipe", () => {
    expect(bookKey("Fool's Errand", "Robin Hobb")).toBe("fool's errand|robin hobb");
  });

  test("folds curly quotes, case, whitespace and punctuation", () => {
    expect(bookKey("  Fool’s   ERRAND ", "Robin  Hobb")).toBe("fool's errand|robin hobb");
    expect(bookKey("The Name of the Wind.", "Patrick Rothfuss")).toBe(
      bookKey("the name of the wind", "patrick rothfuss"),
    );
    expect(bookKey("Slaughterhouse–Five", "Kurt Vonnegut")).toBe(
      "slaughterhouse five|kurt vonnegut",
    );
    expect(bookKey("A Game of Thrones", "George R. R. Martin")).toBe(
      "a game of thrones|george r r martin",
    );
  });

  test("keys on the title alone when the author is unknown", () => {
    expect(bookKey("Fool’s Errand")).toBe("fool's errand");
    expect(bookKey("Fool's Errand", null)).toBe("fool's errand");
    expect(bookKey("Fool's Errand", "  ")).toBe("fool's errand");
  });

  test("returns null for an empty title", () => {
    expect(bookKey("", "Robin Hobb")).toBeNull();
    expect(bookKey(" — ", null)).toBeNull();
  });

  test("normalizes compatibility forms (NFKC) and strips emoji", () => {
    expect(bookKey("📖 Ｍeditations", "Marcus Aurelius")).toBe("meditations|marcus aurelius");
  });
});

describe("bookTitleKey", () => {
  test("is the title part of bookKey", () => {
    expect(bookTitleKey("Fool’s Errand")).toBe("fool's errand");
    expect(bookTitleKey("   ")).toBeNull();
  });
});
