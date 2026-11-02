import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
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

const sleep = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

describe("SearchPage", () => {
  test("typing debounces into a single request with q", async () => {
    fetchMock = mockFetch(() => json({ items: [], total: 0 }));
    renderWithProviders(<SearchPage />);
    const input = screen.getByRole("searchbox", { name: /search quotes/i });

    for (const value of ["l", "lo", "lov", "love"]) {
      fireEvent.change(input, { target: { value } });
      await sleep(30);
    }

    await waitFor(() => {
      expect(
        fetchMock?.callsTo("/api/quotes").some((u) => u.searchParams.get("q") === "love"),
      ).toBe(true);
    });
    await sleep(350);

    const withQ = (fetchMock?.callsTo("/api/quotes") ?? []).filter((u) => u.searchParams.has("q"));
    expect(withQ.map((u) => u.searchParams.get("q"))).toEqual(["love"]);
  });

  test("syncs the query to the URL ?q= and reads it on load", async () => {
    fetchMock = mockFetch(() => json({ items: [], total: 0 }));
    const { location } = renderWithProviders(<SearchPage />, { path: "/?q=grief" });
    const input = screen.getByRole("searchbox", { name: /search quotes/i }) as HTMLInputElement;
    expect(input.value).toBe("grief");
    await waitFor(() => {
      expect(fetchMock?.callsTo("/api/quotes")[0]?.searchParams.get("q")).toBe("grief");
    });

    fireEvent.change(input, { target: { value: "hope" } });
    await waitFor(() => {
      expect(location.history.at(-1)).toBe("/?q=hope");
    });
  });

  test('a result with 2 postings shows "Posted 2×", highlighted', async () => {
    fetchMock = mockFetch(() =>
      json({
        items: [
          quoteItem({ id: 7, text: "Twice told.", postingCount: 2, totalLikes: 120, maxLikes: 90 }),
          quoteItem({ id: 8, text: "Once told.", postingCount: 1 }),
        ],
        total: 2,
      }),
    );
    renderWithProviders(<SearchPage />);

    const twice = await screen.findByText("Posted 2×");
    expect(twice.getAttribute("data-reposted")).toBe("true");
    const once = screen.getByText("Posted 1×");
    expect(once.getAttribute("data-reposted")).toBe("false");
  });

  test("a result card shows text, attribution, metrics and links", async () => {
    fetchMock = mockFetch(() =>
      json({
        items: [
          quoteItem({
            id: 7,
            text: "Twice told.",
            author: "Ursula K. Le Guin",
            sourceTitle: "The Dispossessed",
            postingCount: 2,
            totalLikes: 1200,
            maxLikes: 900,
            totalComments: 34,
            lastPostedAt: "2026-03-05T12:00:00.000Z",
          }),
        ],
        total: 1,
      }),
    );
    renderWithProviders(<SearchPage />);

    const card = (await screen.findByText("Twice told.")).closest("article");
    if (!card) throw new Error("card not found");
    const c = within(card as HTMLElement);
    expect(c.getByText(/Ursula K\. Le Guin/)).toBeDefined();
    expect(c.getByRole("link", { name: "The Dispossessed" }).getAttribute("href")).toBe(
      "/books?q=The%20Dispossessed",
    );
    expect(c.getByRole("link", { name: /twice told/i }).getAttribute("href")).toBe("/quotes/7");
    expect(c.getByText("1,200")).toBeDefined();
    expect(c.getByText("900")).toBeDefined();
    expect(c.getByText("34")).toBeDefined();
    expect(c.getByText(/Mar 5, 2026/)).toBeDefined();
  });

  test("the empty state shows when there are no results", async () => {
    fetchMock = mockFetch(() => json({ items: [], total: 0 }));
    renderWithProviders(<SearchPage />, { path: "/?q=zzz" });
    expect(await screen.findByText(/no quotes match/i)).toBeDefined();
  });

  test("the error state shows on a 500", async () => {
    fetchMock = mockFetch(() => json({ error: "Internal server error" }, 500));
    renderWithProviders(<SearchPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/internal server error/i);
  });

  test("Load more fetches the next page", async () => {
    fetchMock = mockFetch((url) => {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return offset === 0
        ? json({ items: [quoteItem({ id: 1, text: "First page." })], total: 2 })
        : json({ items: [quoteItem({ id: 2, text: "Second page." })], total: 2 });
    });
    renderWithProviders(<SearchPage />);

    await screen.findByText("First page.");
    fireEvent.click(screen.getByRole("button", { name: /load more/i }));
    await screen.findByText("Second page.");
    expect(screen.getByText("First page.")).toBeDefined();
    expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
    const offsets = fetchMock.callsTo("/api/quotes").map((u) => u.searchParams.get("offset"));
    expect(offsets).toEqual(["0", "1"]);
  });
});
