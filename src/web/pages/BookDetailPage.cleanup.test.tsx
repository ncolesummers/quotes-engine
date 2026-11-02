import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { AppRoutes } from "@/routes";
import {
  bookEntry,
  bookSummary,
  type FetchHandler,
  json,
  type MockedFetch,
  mockFetch,
  renderWithProviders,
} from "../../../test/helpers/web";

let fetchMock: MockedFetch | undefined;
afterEach(() => {
  cleanup();
  fetchMock?.restore();
  fetchMock = undefined;
});

const flush = (ms = 50) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

const MURAKAMI = "Haruki Murakami";

function detail(overrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    book: bookSummary({ id: 1, title: "1Q84", author: MURAKAMI, ...overrides }),
    entries: [bookEntry({ quoteId: 10, text: "A quote from 1Q84." })],
    possibleDuplicates: [],
    ...extra,
  };
}

const IQ84 = { id: 2, title: "IQ84", author: MURAKAMI, quoteCount: 1, score: 1 };

function calls(method: string, pathname: string) {
  const out: unknown[] = [];
  fetchMock?.calls.forEach((u, i) => {
    const init = fetchMock?.inits[i];
    if (u.pathname === pathname && (init?.method ?? "GET") === method) {
      out.push(init?.body ? JSON.parse(String(init.body)) : undefined);
    }
  });
  return out;
}

function render(handler: FetchHandler, path = "/books/1") {
  fetchMock = mockFetch(handler);
  return renderWithProviders(<AppRoutes />, { path });
}

describe("BookDetailPage: editing", () => {
  test("edits the title inline and saves it with PATCH", async () => {
    let current = detail();
    render((url, init) => {
      if (url.pathname === "/api/books/1" && init?.method === "PATCH") {
        current = detail({ title: "1Q84 (Book 1)" });
        return json({ book: { ...current.book, normalizedKey: "x" } });
      }
      return json(current);
    });
    await screen.findByRole("heading", { name: /1Q84/ });
    fireEvent.click(screen.getByRole("button", { name: "Edit title" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
      target: { value: "1Q84 (Book 1)" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByRole("heading", { name: /1Q84 \(Book 1\)/ })).toBeDefined();
    expect(calls("PATCH", "/api/books/1")).toEqual([{ title: "1Q84 (Book 1)" }]);
  });

  test("edits the author, and clearing it sends null", async () => {
    render((_url, init) =>
      init?.method === "PATCH" ? json({ book: detail({ author: null }).book }) : json(detail()),
    );
    await screen.findByText(MURAKAMI);
    fireEvent.click(screen.getByRole("button", { name: "Edit author" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Author" }), { target: { value: " " } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await flush();
    expect(calls("PATCH", "/api/books/1")).toEqual([{ author: null }]);
  });

  test("a 409 offers to merge with the book that already has that title and author", async () => {
    render((url, init) => {
      if (url.pathname === "/api/books/1" && init?.method === "PATCH") {
        return json({ error: "Another book has this title and author", conflictId: 2 }, 409);
      }
      if (url.pathname === "/api/books/2") {
        return json({ ...detail({ id: 2, title: "IQ84" }), possibleDuplicates: [] });
      }
      if (url.pathname === "/api/books/1/merge") return json(detail({ quoteCount: 4 }));
      return json(detail());
    });
    await screen.findByText(MURAKAMI);
    fireEvent.click(screen.getByRole("button", { name: "Edit title" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "IQ84" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Another book already has this title and author");
    fireEvent.click(within(alert).getByRole("button", { name: /merge/i }));

    const d = within(await screen.findByRole("dialog"));
    expect(await d.findByText("IQ84")).toBeDefined();
    fireEvent.click(d.getByRole("button", { name: /^merge books$/i }));
    await flush();
    expect(calls("POST", "/api/books/1/merge")).toEqual([{ dropId: 2 }]);
  });
});

describe("BookDetailPage: merging", () => {
  test("Merge with… searches books (never this one) and merges the pick into this book", async () => {
    render((url) => {
      if (url.pathname === "/api/books") {
        return json({
          items: [
            bookSummary({ id: 1, title: "1Q84", author: MURAKAMI }),
            bookSummary({ id: 2, title: "IQ84", author: MURAKAMI, quoteCount: 1 }),
          ],
        });
      }
      if (url.pathname === "/api/books/1/merge") return json(detail({ quoteCount: 4 }));
      return json(detail());
    });
    await screen.findByText(MURAKAMI);
    fireEvent.click(screen.getByRole("button", { name: /merge with/i }));
    const d = within(await screen.findByRole("dialog"));
    fireEvent.change(d.getByRole("searchbox", { name: /search books/i }), {
      target: { value: "q84" },
    });
    const pick = await d.findByRole("button", { name: /IQ84/ });
    expect(d.queryByRole("button", { name: /^1Q84/ })).toBeNull();
    await waitFor(() =>
      expect(fetchMock?.callsTo("/api/books").some((u) => u.searchParams.get("q") === "q84")).toBe(
        true,
      ),
    );
    fireEvent.click(pick);

    // Keeps this book by default.
    expect((d.getByRole("radio", { name: /keep “1Q84”/i }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(d.getByRole("button", { name: /^merge books$/i }));
    await flush();
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(calls("POST", "/api/books/1/merge")).toEqual([{ dropId: 2 }]);
  });

  test("choosing to keep the other book merges this one into it and goes there", async () => {
    const { location } = render((url) => {
      if (url.pathname === "/api/books/2/merge") {
        return json(detail({ id: 2, title: "IQ84", quoteCount: 6 }));
      }
      if (url.pathname === "/api/books/2") return json(detail({ id: 2, title: "IQ84" }));
      return json(detail({}, { possibleDuplicates: [IQ84] }));
    });
    await screen.findByText(MURAKAMI);
    const hints = within(screen.getByRole("region", { name: /possible duplicates/i }));
    fireEvent.click(hints.getByRole("button", { name: /merge/i }));
    const d = within(await screen.findByRole("dialog"));
    fireEvent.click(await d.findByRole("radio", { name: /keep “IQ84”/i }));
    fireEvent.click(d.getByRole("button", { name: /^merge books$/i }));
    await flush();
    expect(calls("POST", "/api/books/2/merge")).toEqual([{ dropId: 1 }]);
    expect(location.history.at(-1)).toBe("/books/2");
  });

  test("a failed merge shows the error and keeps the dialog open", async () => {
    render((url) => {
      if (url.pathname === "/api/books/1/merge") return json({ error: "Book 2 not found" }, 404);
      return json(detail({}, { possibleDuplicates: [IQ84] }));
    });
    await screen.findByText(MURAKAMI);
    fireEvent.click(
      within(screen.getByRole("region", { name: /possible duplicates/i })).getByRole("button", {
        name: /merge/i,
      }),
    );
    const d = within(await screen.findByRole("dialog"));
    fireEvent.click(d.getByRole("button", { name: /^merge books$/i }));
    expect((await d.findByRole("alert")).textContent).toContain("Book 2 not found");
  });
});

describe("BookDetailPage: possible duplicates", () => {
  test("lists similar books with their quote counts and links", async () => {
    render(() =>
      json(
        detail({}, { possibleDuplicates: [IQ84, { ...IQ84, id: 3, author: null, quoteCount: 0 }] }),
      ),
    );
    const region = within(await screen.findByRole("region", { name: /possible duplicates/i }));
    const links = region.getAllByRole("link", { name: /IQ84/ });
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/books/2", "/books/3"]);
    expect(region.getByText(/1 quote\b/)).toBeDefined();
    expect(region.getByText(/no author/i)).toBeDefined();
  });

  test("no hint section when nothing looks similar", async () => {
    render(() => json(detail()));
    await screen.findByText(MURAKAMI);
    expect(screen.queryByRole("region", { name: /possible duplicates/i })).toBeNull();
  });
});

describe("BookDetailPage: deleting", () => {
  test("an empty book can be deleted after confirming, then goes back to /books", async () => {
    const { location } = render((url, init) => {
      if (init?.method === "DELETE") return json({ id: 1 });
      if (url.pathname === "/api/books") return json({ items: [] });
      return json(detail({ quoteCount: 0, postedCount: 0 }, { entries: [] }));
    });
    await screen.findByText(MURAKAMI);
    fireEvent.click(screen.getByRole("button", { name: /delete book/i }));
    fireEvent.click(screen.getByRole("button", { name: /yes, delete/i }));
    await flush();
    expect(calls("DELETE", "/api/books/1")).toHaveLength(1);
    expect(location.history.at(-1)).toBe("/books");
  });

  test("a book with quotes offers no delete", async () => {
    render(() => json(detail()));
    await screen.findByText(MURAKAMI);
    expect(screen.queryByRole("button", { name: /delete book/i })).toBeNull();
  });
});
