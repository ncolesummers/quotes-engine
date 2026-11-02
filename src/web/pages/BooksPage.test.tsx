import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { AppRoutes } from "@/routes";
import {
  bookSummary,
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

const books = [
  bookSummary(),
  bookSummary({
    id: 2,
    title: "Dune",
    author: "Frank Herbert",
    quoteCount: 1,
    postedCount: 0,
    unpostedHighlightCount: 0,
    lastPostedAt: null,
  }),
  bookSummary({
    id: 3,
    title: "Meditations",
    author: null,
    quoteCount: 1,
    postedCount: 1,
    unpostedHighlightCount: 4,
    lastPostedAt: "2026-03-05T12:00:00.000Z",
  }),
];

function card(title: string): ReturnType<typeof within> {
  const link = screen.getByRole("link", { name: new RegExp(title) });
  const el = link.closest("li");
  if (!el) throw new Error(`no card for ${title}`);
  return within(el as HTMLElement);
}

describe("BooksPage", () => {
  test("lists each book with quote and posted counts, last posted date and progress", async () => {
    fetchMock = mockFetch(() => json({ items: books }));
    renderWithProviders(<AppRoutes />, { path: "/books" });

    await screen.findByRole("heading", { name: "Books" });
    await screen.findByText("Fool's Errand");

    const hobb = card("Fool's Errand");
    expect(screen.getByRole("link", { name: /Fool's Errand/ }).getAttribute("href")).toBe(
      "/books/1",
    );
    expect(hobb.getByText("Robin Hobb")).toBeDefined();
    expect(hobb.getByText("3 quotes · 2 posted · last posted Oct 25, 2026")).toBeDefined();
    const bar = hobb.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("2");
    expect(bar.getAttribute("aria-valuemax")).toBe("4");
    expect(bar.getAttribute("aria-label")).toBe("2 of 4 posted");

    expect(card("Dune").getByText("1 quote · 0 posted")).toBeDefined();
    expect(
      card("Meditations").getByText("1 quote · 1 posted · last posted Mar 5, 2026"),
    ).toBeDefined();
    expect(card("Meditations").getByText("4 unposted highlights")).toBeDefined();
  });

  test("searching sends q to the API and the URL", async () => {
    fetchMock = mockFetch((url) =>
      json({ items: url.searchParams.get("q") === "hobb" ? [books[0]] : books }),
    );
    const { location } = renderWithProviders(<AppRoutes />, { path: "/books" });
    await screen.findByText("Dune");

    fireEvent.change(screen.getByLabelText("Search books"), { target: { value: "hobb" } });

    await waitFor(() => {
      expect(fetchMock?.callsTo("/api/books").some((u) => u.searchParams.get("q") === "hobb")).toBe(
        true,
      );
    });
    await waitFor(() => expect(screen.queryByText("Dune")).toBeNull());
    expect(location.history?.at(-1)).toBe("/books?q=hobb");
  });

  test("reads the initial search from ?q=", async () => {
    fetchMock = mockFetch(() => json({ items: [books[1]] }));
    renderWithProviders(<AppRoutes />, { path: "/books?q=Dune" });
    await screen.findByText("Dune");
    expect((screen.getByLabelText("Search books") as HTMLInputElement).value).toBe("Dune");
    expect(fetchMock.callsTo("/api/books")[0]?.searchParams.get("q")).toBe("Dune");
  });

  test("shows an empty state", async () => {
    fetchMock = mockFetch(() => json({ items: [] }));
    renderWithProviders(<AppRoutes />, { path: "/books" });
    expect(await screen.findByText(/No books yet/)).toBeDefined();
  });

  test("“Needs attention” filters to books with issues and labels each issue", async () => {
    const flagged = [
      bookSummary({ id: 4, title: "IQ84", issues: ["possible_duplicate"] }),
      bookSummary({ id: 5, title: "The Jesus of Suburbia", author: null, issues: ["no_author"] }),
      bookSummary({ id: 6, title: "The Wheel of Time", issues: ["series_title"] }),
    ];
    fetchMock = mockFetch((url) =>
      json({ items: url.searchParams.get("attention") === "1" ? flagged : books }),
    );
    const { location } = renderWithProviders(<AppRoutes />, { path: "/books" });
    await screen.findByText("Dune");

    const toggle = screen.getByRole("button", { name: /needs attention/i });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);

    await screen.findByText("IQ84");
    expect(screen.queryByText("Dune")).toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(location.history?.at(-1)).toBe("/books?attention=1");
    expect(card("IQ84").getByText("Possible duplicate")).toBeDefined();
    expect(card("The Jesus of Suburbia").getByText("No author")).toBeDefined();
    expect(card("The Wheel of Time").getByText("Series name?")).toBeDefined();
  });

  test("reads the attention filter from the URL", async () => {
    fetchMock = mockFetch(() => json({ items: [] }));
    renderWithProviders(<AppRoutes />, { path: "/books?attention=1" });
    expect(await screen.findByText(/Nothing needs attention/)).toBeDefined();
    expect(fetchMock.callsTo("/api/books")[0]?.searchParams.get("attention")).toBe("1");
  });
});
