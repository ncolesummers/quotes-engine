import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { AppRoutes } from "@/routes";
import {
  json,
  type MockedFetch,
  mockFetch,
  postingItem,
  quoteDetail,
  quoteItem,
  renderWithProviders,
} from "../../../test/helpers/web";
import { QuoteDetailPage } from "./QuoteDetailPage";

let fetchMock: MockedFetch | undefined;
afterEach(() => {
  cleanup();
  fetchMock?.restore();
  fetchMock = undefined;
});

function renderPage(id = "7") {
  return renderWithProviders(<QuoteDetailPage id={id} />, { path: `/quotes/${id}` });
}

const threePostings = [
  postingItem({ postId: 12, postedAt: "2026-02-10T12:00:00.000Z", likes: 80, comments: 10 }),
  postingItem({ postId: 10, postedAt: "2025-01-05T12:00:00.000Z", likes: 100, comments: 10 }),
  postingItem({
    postId: 11,
    postedAt: "2025-06-01T12:00:00.000Z",
    likes: 150,
    comments: 4,
    method: "image",
    status: "needs_review",
    confidence: 0.71,
  }),
];

function bodyOf(i: number): unknown {
  const raw = fetchMock?.inits[i]?.body;
  return typeof raw === "string" ? JSON.parse(raw) : undefined;
}

function indexOfCall(method: string, pathname: string): number {
  return (fetchMock?.calls ?? []).findIndex(
    (u, i) => u.pathname === pathname && fetchMock?.inits[i]?.method === method,
  );
}

describe("QuoteDetailPage", () => {
  test("shows the quote large, with author and a book link", async () => {
    fetchMock = mockFetch(() =>
      json(
        quoteDetail({
          quote: {
            id: 7,
            text: "So it goes.",
            author: "Kurt Vonnegut",
            sourceTitle: "Cat's Cradle",
          },
        }),
      ),
    );
    renderPage();

    const text = await screen.findByText("So it goes.");
    expect(text.closest("blockquote")).not.toBeNull();
    expect(screen.getByText("Kurt Vonnegut")).toBeDefined();
    expect(screen.getByRole("link", { name: "Cat's Cradle" }).getAttribute("href")).toBe(
      "/books?q=Cat's%20Cradle",
    );
    expect(fetchMock.calls[0]?.pathname).toBe("/api/quotes/7");
  });

  test("the book name links to its book page when the quote has a book", async () => {
    fetchMock = mockFetch(() =>
      json(
        quoteDetail({
          quote: { id: 7, sourceTitle: "Cat's Cradle", bookId: 4 },
          book: { id: 4, title: "Cat's Cradle", author: "Kurt Vonnegut" },
        }),
      ),
    );
    renderPage();
    const link = await screen.findByRole("link", { name: "Cat's Cradle" });
    expect(link.getAttribute("href")).toBe("/books/4");
  });

  test("shows a loading state, then the quote", async () => {
    fetchMock = mockFetch(() => json(quoteDetail({ quote: { id: 7 } })));
    renderPage();
    expect(screen.getByRole("status", { name: /loading quote/i })).toBeDefined();
    await screen.findByText("So it goes.");
    expect(screen.queryByRole("status", { name: /loading quote/i })).toBeNull();
  });

  test("a 404 shows a not-found state with a way back", async () => {
    fetchMock = mockFetch(() => json({ error: "Quote 7 not found" }, 404));
    renderPage();
    expect(await screen.findByRole("heading", { name: /quote not found/i })).toBeDefined();
    expect(screen.getByRole("link", { name: /back to search/i }).getAttribute("href")).toBe("/");
  });

  test("a non-numeric id is not found without calling the API", async () => {
    fetchMock = mockFetch(() => json({}));
    renderPage("abc");
    expect(await screen.findByRole("heading", { name: /quote not found/i })).toBeDefined();
    expect(fetchMock.calls).toHaveLength(0);
  });

  test("a server error shows an alert with a retry", async () => {
    let fail = true;
    fetchMock = mockFetch(() =>
      fail
        ? json({ error: "Internal server error" }, 500)
        : json(quoteDetail({ quote: { id: 7 } })),
    );
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/internal server error/i);
    fail = false;
    fireEvent.click(within(alert).getByRole("button", { name: /try again/i }));
    await screen.findByText("So it goes.");
  });

  test("a failed background refetch keeps the loaded quote on screen", async () => {
    let fail = false;
    fetchMock = mockFetch(() =>
      fail ? json({ error: "boom" }, 500) : json(quoteDetail({ quote: { id: 7 } })),
    );
    const { queryClient } = renderPage();
    await screen.findByText("So it goes.");

    fail = true;
    await act(() => queryClient.refetchQueries());
    await act(() => new Promise<void>((r) => setTimeout(r, 20)));
    expect(screen.getByText("So it goes.")).toBeDefined();
    expect(screen.queryByText(/couldn.t be loaded/i)).toBeNull();
  });

  test("navigating to another quote resets open edits", async () => {
    fetchMock = mockFetch((url) => {
      const id = Number(url.pathname.split("/").pop());
      return json(quoteDetail({ quote: { id, text: `Quote ${id} text.` } }));
    });
    const { location, queryClient } = renderWithProviders(<AppRoutes />, { path: "/quotes/1" });
    await screen.findByText("Quote 1 text.");
    fireEvent.click(screen.getByRole("button", { name: /edit text/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /quote text/i }), {
      target: { value: "Draft for quote 1." },
    });

    act(() => {
      // Quote 2 already cached (e.g. back/forward), so no loading state remounts the page.
      queryClient.setQueryData(
        ["quotes", "detail", 2],
        quoteDetail({ quote: { id: 2, text: "Quote 2 text." } }),
      );
      location.navigate("/quotes/2");
    });
    await screen.findByText("Quote 2 text.");
    // Quote 1's draft must not survive (Save would PATCH it onto quote 2).
    expect(screen.queryByRole("textbox", { name: /quote text/i })).toBeNull();
  });

  describe("postings timeline", () => {
    test("renders N postings in date order with metrics, thumbnail and permalink", async () => {
      fetchMock = mockFetch(() => json(quoteDetail({ quote: { id: 7 }, postings: threePostings })));
      renderPage();

      const list = await screen.findByRole("list", { name: /postings/i });
      const items = within(list).getAllByRole("listitem");
      expect(items).toHaveLength(3);
      expect(items.map((li) => li.querySelector("time")?.textContent)).toEqual([
        "Jan 5, 2025",
        "Jun 1, 2025",
        "Feb 10, 2026",
      ]);

      const first = within(items[0] as HTMLElement);
      expect(first.getByText("100")).toBeDefined();
      expect(first.getByRole("img").getAttribute("src")).toBe("/media/10.jpg");
      const ig = first.getByRole("link", { name: /open on instagram/i });
      expect(ig.getAttribute("href")).toBe("https://www.instagram.com/p/post10/");
      expect(ig.getAttribute("target")).toBe("_blank");
      expect(first.getByText(/caption/i)).toBeDefined();
    });

    test("marks needs_review postings visibly", async () => {
      fetchMock = mockFetch(() => json(quoteDetail({ quote: { id: 7 }, postings: threePostings })));
      renderPage();

      const list = await screen.findByRole("list", { name: /postings/i });
      const items = within(list).getAllByRole("listitem");
      const flagged = items.filter((li) => li.getAttribute("data-status") === "needs_review");
      expect(flagged).toHaveLength(1);
      expect(within(flagged[0] as HTMLElement).getByText(/needs review/i)).toBeDefined();
      expect(within(flagged[0] as HTMLElement).getByText(/image/i)).toBeDefined();
      expect(within(items[0] as HTMLElement).queryByText(/needs review/i)).toBeNull();
    });

    test("a thumbnail that fails to load falls back to the placeholder", async () => {
      fetchMock = mockFetch(() => json(quoteDetail({ quote: { id: 7 } })));
      renderPage();
      const list = await screen.findByRole("list", { name: /postings/i });
      const img = within(list).getByRole("img");
      fireEvent.error(img);
      expect(within(list).queryByRole("img")).toBeNull();
    });

    test("a posting without media or permalink still renders", async () => {
      fetchMock = mockFetch(() =>
        json(
          quoteDetail({
            quote: { id: 7 },
            postings: [postingItem({ mediaUrl: null, mediaPath: null, permalink: null })],
          }),
        ),
      );
      renderPage();
      const list = await screen.findByRole("list", { name: /postings/i });
      expect(within(list).queryByRole("img")).toBeNull();
      expect(within(list).queryByRole("link", { name: /open on instagram/i })).toBeNull();
    });

    test("a quote with no postings says so", async () => {
      fetchMock = mockFetch(() => json(quoteDetail({ quote: { id: 7 }, postings: [] })));
      renderPage();
      expect(await screen.findByText(/hasn’t been posted yet/i)).toBeDefined();
    });
  });

  describe("comparison chart", () => {
    test("a quote with 1 posting hides the comparison chart", async () => {
      fetchMock = mockFetch(() => json(quoteDetail({ quote: { id: 7 } })));
      renderPage();
      await screen.findByRole("list", { name: /postings/i });
      expect(screen.queryByRole("region", { name: /compar/i })).toBeNull();
    });

    test("several postings show likes, comments and change vs. the first, in date order", async () => {
      fetchMock = mockFetch(() => json(quoteDetail({ quote: { id: 7 }, postings: threePostings })));
      renderPage();

      const region = await screen.findByRole("region", { name: /compar/i });
      const table = within(region).getByRole("table");
      const rows = within(table)
        .getAllByRole("row")
        .slice(1)
        .map((tr) =>
          Array.from(tr.querySelectorAll("th, td")).map((c) => c.textContent?.trim() ?? ""),
        );
      expect(rows).toEqual([
        ["#1", "Jan 5, 2025", "100", "10", "—", "—"],
        ["#2", "Jun 1, 2025", "150", "4", "+50 (+50%)", "−6 (−60%)"],
        ["#3", "Feb 10, 2026", "80", "10", "−20 (−20%)", "±0"],
      ]);
    });
  });

  describe("highlights", () => {
    test("lists linked Apple Books highlights", async () => {
      fetchMock = mockFetch(() =>
        json(
          quoteDetail({
            quote: { id: 7 },
            highlights: [
              {
                id: 3,
                text: "So it goes, said the book.",
                note: "Read on the train",
                location: "epubcfi(/6/4)",
                createdAt: "2024-08-20T09:00:00.000Z",
                book: { id: 1, title: "Slaughterhouse-Five", author: "Kurt Vonnegut" },
              },
            ],
          }),
        ),
      );
      renderPage();

      const section = await screen.findByRole("region", { name: /highlights/i });
      const s = within(section);
      expect(s.getByText("So it goes, said the book.")).toBeDefined();
      expect(s.getByText("Read on the train")).toBeDefined();
      expect(s.getByText("Aug 20, 2024")).toBeDefined();
      expect(s.getByRole("link", { name: "Slaughterhouse-Five" }).getAttribute("href")).toBe(
        "/books/1",
      );
    });

    test("hides the highlights section when there are none", async () => {
      fetchMock = mockFetch(() => json(quoteDetail({ quote: { id: 7 } })));
      renderPage();
      await screen.findByText("So it goes.");
      expect(screen.queryByRole("region", { name: /highlights/i })).toBeNull();
    });
  });

  describe("inline editing", () => {
    test("editing the text sends a PATCH and shows the updated text", async () => {
      fetchMock = mockFetch((_url, init) => {
        if (init?.method === "PATCH") {
          return json({ quote: quoteDetail({ quote: { id: 7, text: "And so on." } }).quote });
        }
        return json(quoteDetail({ quote: { id: 7 } }));
      });
      renderPage();

      await screen.findByText("So it goes.");
      fireEvent.click(screen.getByRole("button", { name: /edit text/i }));
      const box = screen.getByRole("textbox", { name: /quote text/i });
      fireEvent.change(box, { target: { value: "And so on." } });
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

      expect(await screen.findByText("And so on.")).toBeDefined();
      const i = indexOfCall("PATCH", "/api/quotes/7");
      expect(i).toBeGreaterThanOrEqual(0);
      expect(bodyOf(i)).toEqual({ text: "And so on." });
      expect(screen.queryByRole("textbox", { name: /quote text/i })).toBeNull();
    });

    test("editing the author sends only the author", async () => {
      fetchMock = mockFetch((_url, init) => {
        if (init?.method === "PATCH") {
          return json({ quote: quoteDetail({ quote: { id: 7, author: "K. Vonnegut" } }).quote });
        }
        return json(quoteDetail({ quote: { id: 7 } }));
      });
      renderPage();

      await screen.findByText("Kurt Vonnegut");
      fireEvent.click(screen.getByRole("button", { name: /edit author/i }));
      fireEvent.change(screen.getByRole("textbox", { name: /author/i }), {
        target: { value: "K. Vonnegut" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

      expect(await screen.findByText("K. Vonnegut")).toBeDefined();
      expect(bodyOf(indexOfCall("PATCH", "/api/quotes/7"))).toEqual({ author: "K. Vonnegut" });
    });

    test("clearing the book sends null", async () => {
      fetchMock = mockFetch((_url, init) => {
        if (init?.method === "PATCH") {
          return json({ quote: quoteDetail({ quote: { id: 7, sourceTitle: null } }).quote });
        }
        return json(quoteDetail({ quote: { id: 7 } }));
      });
      renderPage();

      await screen.findByText("Slaughterhouse-Five");
      fireEvent.click(screen.getByRole("button", { name: /edit book/i }));
      fireEvent.change(screen.getByRole("textbox", { name: /book/i }), { target: { value: "  " } });
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

      await waitFor(() => expect(screen.queryByText("Slaughterhouse-Five")).toBeNull());
      expect(bodyOf(indexOfCall("PATCH", "/api/quotes/7"))).toEqual({ sourceTitle: null });
    });

    test("notes can be added inline", async () => {
      fetchMock = mockFetch((_url, init) => {
        if (init?.method === "PATCH") {
          return json({
            quote: quoteDetail({ quote: { id: 7, notes: "Posted for a friend" } }).quote,
          });
        }
        return json(quoteDetail({ quote: { id: 7 } }));
      });
      renderPage();

      await screen.findByText("So it goes.");
      fireEvent.click(screen.getByRole("button", { name: /add notes/i }));
      fireEvent.change(screen.getByRole("textbox", { name: /notes/i }), {
        target: { value: "Posted for a friend" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

      expect(await screen.findByText("Posted for a friend")).toBeDefined();
      expect(bodyOf(indexOfCall("PATCH", "/api/quotes/7"))).toEqual({
        notes: "Posted for a friend",
      });
    });

    test("Enter that confirms an IME composition does not save", async () => {
      fetchMock = mockFetch(() => json(quoteDetail({ quote: { id: 7 } })));
      renderPage();
      await screen.findByText("So it goes.");
      fireEvent.click(screen.getByRole("button", { name: /edit author/i }));
      const input = screen.getByRole("textbox", { name: /author/i });
      fireEvent.change(input, { target: { value: "村上" } });
      fireEvent.keyDown(input, { key: "Enter", isComposing: true });
      fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
      await act(() => new Promise<void>((r) => setTimeout(r, 20)));

      expect(screen.getByRole("textbox", { name: /author/i })).toBeDefined();
      expect(indexOfCall("PATCH", "/api/quotes/7")).toBe(-1);
    });

    test("cancel discards the draft without a request", async () => {
      fetchMock = mockFetch(() => json(quoteDetail({ quote: { id: 7 } })));
      renderPage();

      await screen.findByText("So it goes.");
      fireEvent.click(screen.getByRole("button", { name: /edit text/i }));
      fireEvent.change(screen.getByRole("textbox", { name: /quote text/i }), {
        target: { value: "Changed" },
      });
      fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

      expect(screen.getByText("So it goes.")).toBeDefined();
      expect(indexOfCall("PATCH", "/api/quotes/7")).toBe(-1);
    });

    test("a 409 on text offers to merge the conflicting quote", async () => {
      fetchMock = mockFetch((url, init) => {
        if (init?.method === "PATCH") {
          return json({ error: "Text duplicates quote 9", conflictId: 9 }, 409);
        }
        if (url.pathname === "/api/quotes/7/merge") return json(quoteDetail({ quote: { id: 7 } }));
        if (url.pathname === "/api/quotes/9") {
          return json(quoteDetail({ quote: { id: 9, text: "The duplicate one." } }));
        }
        if (url.pathname === "/api/quotes") return json({ items: [], total: 0 });
        return json(quoteDetail({ quote: { id: 7 } }));
      });
      renderPage();

      await screen.findByText("So it goes.");
      fireEvent.click(screen.getByRole("button", { name: /edit text/i }));
      fireEvent.change(screen.getByRole("textbox", { name: /quote text/i }), {
        target: { value: "Duplicate text." },
      });
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Another quote already has this text — merge instead?");
      // The draft is kept so nothing is lost.
      expect(
        (screen.getByRole("textbox", { name: /quote text/i }) as HTMLTextAreaElement).value,
      ).toBe("Duplicate text.");

      fireEvent.click(within(alert).getByRole("button", { name: /merge/i }));
      const d = within(await screen.findByRole("dialog"));
      // Straight to confirming the quote the server named, no searching needed.
      expect(await d.findByText("The duplicate one.")).toBeDefined();
      fireEvent.click(d.getByRole("button", { name: /merge into this quote/i }));
      await act(() => new Promise<void>((r) => setTimeout(r, 50)));
      expect(bodyOf(indexOfCall("POST", "/api/quotes/7/merge"))).toEqual({ dropId: 9 });
    });

    test("a 409 without a conflict id prefills the search, clipped to the server limit", async () => {
      const long = `${"word ".repeat(120)}end`;
      fetchMock = mockFetch((url, init) => {
        if (init?.method === "PATCH") return json({ error: "Text duplicates quote 9" }, 409);
        if (url.pathname === "/api/quotes") return json({ items: [], total: 0 });
        return json(quoteDetail({ quote: { id: 7 } }));
      });
      renderPage();

      await screen.findByText("So it goes.");
      fireEvent.click(screen.getByRole("button", { name: /edit text/i }));
      fireEvent.change(screen.getByRole("textbox", { name: /quote text/i }), {
        target: { value: long },
      });
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

      const alert = await screen.findByRole("alert");
      fireEvent.click(within(alert).getByRole("button", { name: /merge/i }));
      const dialog = await screen.findByRole("dialog");
      const value = (within(dialog).getByRole("searchbox", { name: /search/i }) as HTMLInputElement)
        .value;
      expect(value.length).toBeLessThanOrEqual(500);
      expect(long.startsWith(value)).toBe(true);
      await waitFor(() => expect(fetchMock?.callsTo("/api/quotes").length).toBeGreaterThan(0));
      for (const u of fetchMock?.callsTo("/api/quotes") ?? []) {
        expect((u.searchParams.get("q") ?? "").length).toBeLessThanOrEqual(500);
      }
    });
  });

  describe("merge dialog", () => {
    test("searching and confirming sends dropId and shows the merged result", async () => {
      fetchMock = mockFetch((url) => {
        if (url.pathname === "/api/quotes/7/merge") {
          return json(
            quoteDetail({
              quote: { id: 7 },
              postings: [
                postingItem({ postId: 1, postedAt: "2025-01-01T00:00:00.000Z" }),
                postingItem({ postId: 2, postedAt: "2025-03-01T00:00:00.000Z" }),
              ],
            }),
          );
        }
        if (url.pathname === "/api/quotes") {
          return json({
            items: [
              quoteItem({ id: 7, text: "So it goes." }),
              quoteItem({ id: 9, text: "So it goes!", postingCount: 1 }),
            ],
            total: 2,
          });
        }
        return json(quoteDetail({ quote: { id: 7 } }));
      });
      renderPage();

      await screen.findByText("So it goes.");
      fireEvent.click(screen.getByRole("button", { name: /merge with/i }));
      const dialog = await screen.findByRole("dialog");
      const d = within(dialog);
      fireEvent.change(d.getByRole("searchbox", { name: /search/i }), {
        target: { value: "so it goes" },
      });

      const candidate = await d.findByRole("button", { name: /so it goes!/i });
      // The current quote is never offered as a merge target.
      expect(d.queryByRole("button", { name: /^so it goes\.$/i })).toBeNull();
      await waitFor(() =>
        expect(
          fetchMock?.callsTo("/api/quotes").some((u) => u.searchParams.get("q") === "so it goes"),
        ).toBe(true),
      );

      fireEvent.click(candidate);
      fireEvent.click(d.getByRole("button", { name: /merge into this quote/i }));

      // Flush inside act: RTL waitFor (which runs outside act) stalls for seconds while the
      // Radix dialog unmounts in happy-dom.
      await act(() => new Promise<void>((r) => setTimeout(r, 50)));
      expect(document.querySelector("[role=dialog]")).toBeNull();
      const i = indexOfCall("POST", "/api/quotes/7/merge");
      expect(i).toBeGreaterThanOrEqual(0);
      expect(bodyOf(i)).toEqual({ dropId: 9 });
      const list = await screen.findByRole("list", { name: /postings/i });
      expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    });

    test("a failed merge shows the error and keeps the dialog open", async () => {
      fetchMock = mockFetch((url) => {
        if (url.pathname === "/api/quotes/7/merge")
          return json({ error: "Quote 9 not found" }, 404);
        if (url.pathname === "/api/quotes") {
          return json({ items: [quoteItem({ id: 9, text: "Other one." })], total: 1 });
        }
        return json(quoteDetail({ quote: { id: 7 } }));
      });
      renderPage();

      await screen.findByText("So it goes.");
      fireEvent.click(screen.getByRole("button", { name: /merge with/i }));
      const d = within(await screen.findByRole("dialog"));
      fireEvent.change(d.getByRole("searchbox", { name: /search/i }), {
        target: { value: "other" },
      });
      fireEvent.click(await d.findByRole("button", { name: /other one/i }));
      fireEvent.click(d.getByRole("button", { name: /merge into this quote/i }));

      expect((await d.findByRole("alert")).textContent).toMatch(/quote 9 not found/i);
      expect(screen.getByRole("dialog")).toBeDefined();
    });
  });
});
