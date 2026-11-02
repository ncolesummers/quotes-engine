import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import {
  emptyStats,
  json,
  type MockedFetch,
  mockFetch,
  renderWithProviders,
} from "../../test/helpers/web";
import { App, AppContent } from "./App";

let fetchMock: MockedFetch | undefined;
afterEach(() => {
  cleanup();
  fetchMock?.restore();
  fetchMock = undefined;
});

const stats = {
  quotes: 1234,
  posts: 1500,
  repostedQuotes: 87,
  highlights: 4000,
  highlightsBacklog: 3100,
  needsReview: 5,
};

function api(statsBody: unknown = stats) {
  return mockFetch((url) => {
    if (url.pathname === "/api/stats") return json(statsBody);
    if (url.pathname === "/api/quotes") return json({ items: [], total: 0 });
    return json({ error: "not found" }, 404);
  });
}

describe("App shell", () => {
  test("renders the brand and primary nav", () => {
    fetchMock = api();
    renderWithProviders(<AppContent />);
    const nav = screen.getByRole("navigation", { name: /primary/i });
    const n = within(nav);
    expect(n.getByRole("link", { name: /quotes/i }).getAttribute("href")).toBe("/");
    expect(n.getByRole("link", { name: /books/i }).getAttribute("href")).toBe("/books");
    expect(n.getByRole("link", { name: /highlights/i }).getAttribute("href")).toBe("/highlights");
    expect(n.getByRole("link", { name: /review/i }).getAttribute("href")).toBe("/review");
    expect(screen.getByRole("link", { name: /quotes engine/i })).toBeDefined();
  });

  test("the Review link carries the needsReview count badge", async () => {
    fetchMock = api();
    renderWithProviders(<AppContent />);
    const review = screen.getByRole("link", { name: /review/i });
    await waitFor(() => {
      expect(review.textContent).toContain("5");
    });
    expect(review.getAttribute("aria-label")).toMatch(/5 awaiting/i);
  });

  test("no badge when nothing needs review", async () => {
    fetchMock = api(emptyStats);
    renderWithProviders(<AppContent />);
    const strip = await screen.findByRole("region", { name: /archive stats/i });
    await waitFor(() => expect(strip.textContent).toContain("0 quotes"));
    const review = screen.getByRole("link", { name: /review/i });
    expect(review.querySelector("[data-slot=badge]")).toBeNull();
  });

  test("shows a stats strip from /api/stats", async () => {
    fetchMock = api();
    renderWithProviders(<AppContent />);
    const strip = await screen.findByRole("region", { name: /archive stats/i });
    await waitFor(() => expect(strip.textContent).toContain("1,234"));
    const items = within(strip)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(items).toEqual([
      "1,234 quotes",
      "1,500 posts",
      "87 reposted",
      "3,100 highlights unposted",
    ]);
  });

  test("the stats strip says so when /api/stats fails", async () => {
    fetchMock = mockFetch((url) =>
      url.pathname === "/api/stats" ? json({ error: "boom" }, 500) : json({ items: [], total: 0 }),
    );
    renderWithProviders(<AppContent />);
    const strip = screen.getByRole("region", { name: /archive stats/i });
    await waitFor(() => expect(strip.textContent).toMatch(/stats unavailable/i));
  });

  test("the quotes route renders the search page", () => {
    fetchMock = api();
    renderWithProviders(<AppContent />);
    expect(screen.getByRole("searchbox", { name: /search quotes/i })).toBeDefined();
  });

  test.each([
    ["/books", /books/i],
    ["/highlights", /highlights/i],
    ["/review", /review/i],
    ["/quotes/42", /quote #42/i],
  ])("%s renders a placeholder page", (path, heading) => {
    fetchMock = api();
    renderWithProviders(<AppContent />, { path });
    expect(screen.getByRole("heading", { level: 1, name: heading })).toBeDefined();
  });

  test("unknown routes render a not-found page", () => {
    fetchMock = api();
    renderWithProviders(<AppContent />, { path: "/nope" });
    expect(screen.getByRole("heading", { level: 1, name: /not found/i })).toBeDefined();
  });
});

test("App mounts with its own providers", () => {
  fetchMock = api();
  render(<App />);
  expect(screen.getByRole("navigation", { name: /primary/i })).toBeDefined();
});
