import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { AppRoutes } from "@/routes";
import {
  bookEntry,
  bookPosting,
  bookSummary,
  json,
  type MockedFetch,
  mockFetch,
  renderWithProviders,
} from "../../../test/helpers/web";

let fetchMock: MockedFetch | undefined;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  cleanup();
  fetchMock?.restore();
  fetchMock = undefined;
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
});

const detail = {
  book: bookSummary(),
  entries: [
    bookEntry({
      quoteId: 10,
      text: "Hope is a dangerous thing.",
      postings: [
        bookPosting({ postId: 1, postedAt: "2026-01-01T12:00:00.000Z" }),
        bookPosting({ postId: 2, postedAt: "2026-10-25T12:00:00.000Z" }),
      ],
    }),
    bookEntry({
      quoteId: 11,
      text: "Posted only once.",
      postings: [bookPosting({ postId: 3, postedAt: "2026-05-01T12:00:00.000Z", mediaUrl: null })],
    }),
    bookEntry({
      quoteId: 12,
      text: "A quote not yet made into a pic.",
      posted: false,
      postings: [],
    }),
    bookEntry({
      kind: "highlight",
      quoteId: null,
      highlightId: 50,
      text: "An unposted highlight.",
      note: "reread",
      posted: false,
      highlightedAt: "2025-09-09T12:00:00.000Z",
      postings: [],
    }),
  ],
};

function renderPage() {
  fetchMock = mockFetch(() => json(detail));
  return renderWithProviders(<AppRoutes />, { path: "/books/1" });
}

function entry(text: string): ReturnType<typeof within> {
  const el = screen.getByText(text).closest("li[data-entry]");
  if (!el) throw new Error(`no entry for ${text}`);
  return within(el as HTMLElement);
}

describe("BookDetailPage", () => {
  test("shows the book header with counts", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "Fool's Errand" })).toBeDefined();
    expect(screen.getByText("Robin Hobb")).toBeDefined();
    expect(screen.getByText("3 quotes · 2 posted · last posted Oct 25, 2026")).toBeDefined();
    expect(fetchMock?.callsTo("/api/books/1")).toHaveLength(1);
  });

  test("posted entries show thumbnails, every posting date and a Posted N× badge", async () => {
    renderPage();
    await screen.findByText("Hope is a dangerous thing.");

    const reposted = entry("Hope is a dangerous thing.");
    expect(reposted.getByText("Posted 2×").getAttribute("data-reposted")).toBe("true");
    const imgs = reposted.getAllByRole("img") as HTMLImageElement[];
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual(["/media/2.jpg", "/media/1.jpg"]);
    expect(reposted.getByText("Oct 25, 2026")).toBeDefined();
    expect(reposted.getByText("Jan 1, 2026")).toBeDefined();
    expect(
      reposted.getByRole("link", { name: "Hope is a dangerous thing." }).getAttribute("href"),
    ).toBe("/quotes/10");
    const ig = reposted
      .getAllByRole("link", { name: /Instagram/ })
      .map((a: HTMLElement) => a.getAttribute("href"));
    expect(ig).toEqual([
      "https://www.instagram.com/p/post2/",
      "https://www.instagram.com/p/post1/",
    ]);

    const once = entry("Posted only once.");
    expect(once.getByText("Posted 1×")).toBeDefined();
    // No media file: a placeholder instead of an image.
    expect(once.queryByRole("img")).toBeNull();
  });

  test("a thumbnail whose file is missing falls back to a placeholder", async () => {
    renderPage();
    await screen.findByText("Hope is a dangerous thing.");
    const reposted = entry("Hope is a dangerous thing.");
    const [first] = reposted.getAllByRole("img");
    if (!first) throw new Error("no image");
    act(() => {
      fireEvent.error(first);
    });
    expect(reposted.getAllByRole("img")).toHaveLength(1);
  });

  test("unposted highlights show when they were highlighted and can be copied", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t: string) => void writes.push(t) },
    });
    renderPage();
    await screen.findByText("An unposted highlight.");

    const h = entry("An unposted highlight.");
    expect(h.getByText(/Highlighted/).textContent).toBe("Highlighted Sep 9, 2025");
    expect(h.getByText("reread")).toBeDefined();
    expect(h.getByText("Not yet posted")).toBeDefined();
    fireEvent.click(h.getByRole("button", { name: /Copy/ }));
    await waitFor(() => expect(writes).toEqual(["An unposted highlight."]));
    expect(await h.findByText("Copied")).toBeDefined();

    const unpostedQuote = entry("A quote not yet made into a pic.");
    expect(unpostedQuote.getByText("Not yet posted")).toBeDefined();
    expect(
      unpostedQuote
        .getByRole("link", { name: "A quote not yet made into a pic." })
        .getAttribute("href"),
    ).toBe("/quotes/12");
  });

  test("the filter toggles between all, posted and not-posted entries", async () => {
    const { location } = renderPage();
    await screen.findByText("Hope is a dangerous thing.");
    const texts = () =>
      Array.from(document.querySelectorAll("li[data-entry] [data-entry-text]")).map(
        (el) => el.textContent,
      );
    expect(texts()).toHaveLength(4);
    expect(screen.getByRole("radio", { name: /All/ }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("radio", { name: /^Posted/ }));
    expect(texts()).toEqual(["Hope is a dangerous thing.", "Posted only once."]);
    expect(location.history.at(-1)).toBe("/books/1?show=posted");

    fireEvent.click(screen.getByRole("radio", { name: /Not posted/ }));
    expect(texts()).toEqual(["A quote not yet made into a pic.", "An unposted highlight."]);
    expect(location.history.at(-1)).toBe("/books/1?show=unposted");

    fireEvent.click(screen.getByRole("radio", { name: /All/ }));
    expect(texts()).toHaveLength(4);
  });

  test("shows a not-found message for an unknown book", async () => {
    fetchMock = mockFetch(() => json({ error: "Book 9 not found" }, 404));
    renderWithProviders(<AppRoutes />, { path: "/books/9" });
    expect(await screen.findByText(/couldn’t find that book/i)).toBeDefined();
  });
});
