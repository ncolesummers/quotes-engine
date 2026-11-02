import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  bookSummary,
  json,
  type MockedFetch,
  mockFetch,
  quoteItem,
  renderWithProviders,
} from "../../../test/helpers/web";
import { SearchPage } from "./SearchPage";

let fetchMock: MockedFetch | undefined;
afterEach(() => {
  cleanup();
  fetchMock?.restore();
  fetchMock = undefined;
});

const AUTHORS = [
  { name: "Ken Liu", quoteCount: 34 },
  { name: "Robin Hobb", quoteCount: 19 },
  { name: "Ursula K. Le Guin", quoteCount: 4 },
];
const BOOKS = [
  bookSummary({ id: 3, title: "Dune", author: "Frank Herbert" }),
  bookSummary({ id: 4, title: "Fool's Errand", author: "Robin Hobb" }),
];

function mockApi() {
  fetchMock = mockFetch((url) => {
    if (url.pathname === "/api/authors") return json({ items: AUTHORS });
    if (url.pathname === "/api/books") return json({ items: BOOKS });
    return json({ items: [quoteItem()], total: 1 });
  });
  return fetchMock;
}

/** Search params of the latest `/api/quotes` request. */
function lastQuoteRequest(): URLSearchParams {
  const call = fetchMock?.callsTo("/api/quotes").at(-1);
  if (!call) throw new Error("no /api/quotes request");
  return call.searchParams;
}

function lastUrl(location: { history?: string[] }): URL {
  return new URL(location.history?.at(-1) ?? "/", "http://localhost");
}

function activeFilters(): HTMLElement {
  return screen.getByRole("list", { name: /active filters/i });
}

/** Open a combobox (author or book) and pick `option` after typing `search`. */
async function pick(combobox: RegExp, search: string, option: RegExp) {
  fireEvent.click(screen.getByRole("combobox", { name: combobox }));
  const input = await screen.findByPlaceholderText(/search (authors|books)/i);
  fireEvent.change(input, { target: { value: search } });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

describe("SearchPage filters", () => {
  test("loading with query params pre-fills the controls and the request", async () => {
    mockApi();
    renderWithProviders(<SearchPage />, {
      path: "/?author=Ken%20Liu&book=3&posted=yes&reposted=1&sort=likes",
    });

    await waitFor(() => expect(fetchMock?.callsTo("/api/quotes").length).toBeGreaterThan(0));
    const req = lastQuoteRequest();
    expect(req.get("author")).toBe("Ken Liu");
    expect(req.get("bookId")).toBe("3");
    expect(req.get("posted")).toBe("yes");
    expect(req.get("minPostings")).toBe("2");
    expect(req.get("sort")).toBe("likes");

    expect(screen.getByRole("combobox", { name: /author/i }).textContent).toContain("Ken Liu");
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: /book/i }).textContent).toContain("Dune"),
    );
    expect(screen.getByRole("radio", { name: "Posted" }).getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByRole("button", { name: /reposted only/i }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("combobox", { name: /sort/i }).textContent).toContain("Most likes");

    const chips = within(activeFilters());
    expect(chips.getByText("Ken Liu")).toBeDefined();
    expect(await chips.findByText("Dune")).toBeDefined();
    expect(chips.getByText("Posted")).toBeDefined();
    expect(chips.getByText("Reposted")).toBeDefined();
  });

  test("no filters: no chips and no Clear button", async () => {
    mockApi();
    renderWithProviders(<SearchPage />);
    await screen.findByText("So it goes.");
    expect(screen.queryByRole("list", { name: /active filters/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /clear filters/i })).toBeNull();
    const req = lastQuoteRequest();
    for (const key of ["author", "bookId", "posted", "minPostings", "noBook"]) {
      expect(req.has(key)).toBe(false);
    }
  });

  test("picking an author from the searchable list updates the URL and the request", async () => {
    mockApi();
    const { location } = renderWithProviders(<SearchPage />);
    await screen.findByText("So it goes.");

    await pick(/author/i, "hobb", /Robin Hobb/);
    await waitFor(() => expect(lastUrl(location).searchParams.get("author")).toBe("Robin Hobb"));
    await waitFor(() => expect(lastQuoteRequest().get("author")).toBe("Robin Hobb"));
    expect(fetchMock?.callsTo("/api/authors").length).toBeGreaterThan(0);
  });

  test("the author list filters as you type", async () => {
    mockApi();
    renderWithProviders(<SearchPage />);
    fireEvent.click(screen.getByRole("combobox", { name: /author/i }));
    const input = await screen.findByPlaceholderText(/search authors/i);
    await screen.findByRole("option", { name: /Ken Liu/ });
    fireEvent.change(input, { target: { value: "guin" } });
    await waitFor(() => expect(screen.queryByRole("option", { name: /Ken Liu/ })).toBeNull());
    expect(screen.getByRole("option", { name: /Ursula K\. Le Guin/ })).toBeDefined();
  });

  test("picking a book filters by its id and turns off “No book”", async () => {
    mockApi();
    const { location } = renderWithProviders(<SearchPage />, { path: "/?nobook=1" });
    await screen.findByText("So it goes.");

    await pick(/book/i, "dune", /Dune/);
    await waitFor(() => expect(lastUrl(location).search).toBe("?book=3"));
    await waitFor(() => expect(lastQuoteRequest().get("bookId")).toBe("3"));
    expect(lastQuoteRequest().has("noBook")).toBe(false);
    expect(lastQuoteRequest().has("book")).toBe(false);
  });

  test("“No book” turns off a picked book", async () => {
    mockApi();
    const { location } = renderWithProviders(<SearchPage />, { path: "/?book=3" });
    await screen.findByText("So it goes.");
    fireEvent.click(screen.getByRole("button", { name: /^no book$/i }));
    await waitFor(() => expect(lastUrl(location).search).toBe("?nobook=1"));
    await waitFor(() => expect(lastQuoteRequest().get("noBook")).toBe("1"));
    expect(lastQuoteRequest().has("bookId")).toBe(false);
  });

  test("Posted: any / posted / never posted", async () => {
    mockApi();
    const { location } = renderWithProviders(<SearchPage />);
    await screen.findByText("So it goes.");

    fireEvent.click(screen.getByRole("radio", { name: "Never posted" }));
    await waitFor(() => expect(lastUrl(location).search).toBe("?posted=no"));
    await waitFor(() => expect(lastQuoteRequest().get("posted")).toBe("no"));

    fireEvent.click(screen.getByRole("radio", { name: "Posted" }));
    await waitFor(() => expect(lastUrl(location).search).toBe("?posted=yes"));
    await waitFor(() => expect(lastQuoteRequest().get("posted")).toBe("yes"));

    fireEvent.click(screen.getByRole("radio", { name: "Any" }));
    await waitFor(() => expect(lastUrl(location).search).toBe(""));
    await waitFor(() => expect(lastQuoteRequest().has("posted")).toBe(false));
  });

  test("“Reposted only” asks for minPostings=2 and replaces “Never posted”", async () => {
    mockApi();
    const { location } = renderWithProviders(<SearchPage />, { path: "/?posted=no" });
    await screen.findByText("So it goes.");

    const toggle = screen.getByRole("button", { name: /reposted only/i });
    fireEvent.click(toggle);
    await waitFor(() => expect(lastUrl(location).search).toBe("?reposted=1"));
    await waitFor(() => expect(lastQuoteRequest().get("minPostings")).toBe("2"));
    expect(lastQuoteRequest().has("posted")).toBe(false);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("radio", { name: "Never posted" }));
    await waitFor(() => expect(lastUrl(location).search).toBe("?posted=no"));
  });

  test("sorting updates the URL and the request", async () => {
    mockApi();
    const { location } = renderWithProviders(<SearchPage />);
    await screen.findByText("So it goes.");

    const trigger = screen.getByRole("combobox", { name: /sort/i });
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Most comments" }));
    await waitFor(() => expect(lastUrl(location).search).toBe("?sort=comments"));
    await waitFor(() => expect(lastQuoteRequest().get("sort")).toBe("comments"));
  });

  test("an unknown sort or posted value falls back to the default", async () => {
    mockApi();
    renderWithProviders(<SearchPage />, { path: "/?sort=bogus&posted=maybe&book=abc" });
    await screen.findByText("So it goes.");
    const req = lastQuoteRequest();
    expect(req.get("sort")).toBe("recent");
    expect(req.has("posted")).toBe(false);
    expect(req.has("bookId")).toBe(false);
  });

  test("removing a chip clears just that filter", async () => {
    mockApi();
    const { location } = renderWithProviders(<SearchPage />, {
      path: "/?q=hope&author=Ken%20Liu&posted=yes",
    });
    await screen.findByText("So it goes.");

    fireEvent.click(within(activeFilters()).getByRole("button", { name: /remove.*ken liu/i }));
    await waitFor(() => expect(lastUrl(location).search).toBe("?q=hope&posted=yes"));
    await waitFor(() => expect(lastQuoteRequest().has("author")).toBe(false));
    expect(lastQuoteRequest().get("posted")).toBe("yes");
  });

  test("Clear filters resets every filter but keeps the search text and sort", async () => {
    mockApi();
    const { location } = renderWithProviders(<SearchPage />, {
      path: "/?q=hope&sort=likes&author=Ken%20Liu&book=3&posted=yes&reposted=1",
    });
    await screen.findByText("So it goes.");

    fireEvent.click(screen.getByRole("button", { name: /clear filters/i }));
    await waitFor(() => expect(lastUrl(location).search).toBe("?q=hope&sort=likes"));
    await waitFor(() => {
      const req = lastQuoteRequest();
      for (const key of ["author", "bookId", "posted", "minPostings", "noBook"]) {
        expect(req.has(key)).toBe(false);
      }
    });
    expect(screen.queryByRole("list", { name: /active filters/i })).toBeNull();
    expect(screen.getByRole("radio", { name: "Any" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("combobox", { name: /author/i }).textContent).not.toContain("Ken Liu");
  });

  test("no results under filters offers to clear them", async () => {
    fetchMock = mockFetch((url) =>
      url.pathname === "/api/quotes"
        ? json({ items: [], total: 0 })
        : json({ items: url.pathname === "/api/authors" ? AUTHORS : BOOKS }),
    );
    const { location } = renderWithProviders(<SearchPage />, { path: "/?reposted=1" });
    expect(await screen.findByText(/no quotes match these filters/i)).toBeDefined();
    const buttons = screen.getAllByRole("button", { name: /clear filters/i });
    fireEvent.click(buttons.at(-1) as HTMLElement);
    await waitFor(() => expect(lastUrl(location).search).toBe(""));
  });

  test("on small screens a Filters button opens the filters in a popover", async () => {
    mockApi();
    renderWithProviders(<SearchPage />, { path: "/?posted=yes&reposted=1" });
    await screen.findByText("So it goes.");
    const trigger = screen.getByRole("button", { name: /^filters/i });
    expect(trigger.textContent).toContain("2");
    fireEvent.click(trigger);
    const panel = await screen.findByRole("dialog", { name: /filters/i });
    expect(within(panel).getByRole("button", { name: /reposted only/i })).toBeDefined();
    expect(within(panel).getByRole("combobox", { name: /author/i })).toBeDefined();
  });
});
