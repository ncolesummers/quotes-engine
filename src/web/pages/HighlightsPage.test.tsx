import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { GROUP_PAGE_SIZE } from "@/pages/HighlightsPage";
import { AppRoutes } from "@/routes";
import {
  highlightGroup,
  highlightItem,
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
  else Reflect.deleteProperty(navigator, "clipboard");
});

const meditations = { id: 1, title: "Meditations", author: "Marcus Aurelius" };
const walden = { id: 2, title: "Walden", author: "Henry David Thoreau" };

const byBook: Record<number, ReturnType<typeof highlightItem>[]> = {
  1: [
    highlightItem({
      id: 11,
      text: "You have power over your mind, not outside events.",
      note: "for the anxious days",
      createdAt: "2026-03-05T12:00:00.000Z",
      book: meditations,
    }),
    highlightItem({
      id: 12,
      text: "The impediment to action advances action.",
      quoteId: 40,
      posted: true,
      createdAt: "2026-02-01T12:00:00.000Z",
      book: meditations,
    }),
  ],
  2: [
    highlightItem({
      id: 21,
      text: "I went to the woods because I wished to live deliberately.",
      createdAt: "2026-01-10T12:00:00.000Z",
      book: walden,
    }),
  ],
};

const groups = [
  highlightGroup({ book: meditations, count: 2, lastHighlightedAt: "2026-03-05T12:00:00.000Z" }),
  highlightGroup({ book: walden, count: 1, lastHighlightedAt: "2026-01-10T12:00:00.000Z" }),
];

/** Serves `/api/highlights/books` from `groupList` and `/api/highlights` from `items`. */
function serve(
  groupList: ReturnType<typeof highlightGroup>[] = groups,
  items: Record<number, ReturnType<typeof highlightItem>[]> = byBook,
) {
  fetchMock = mockFetch((url) => {
    if (url.pathname === "/api/highlights/books") {
      return json({ items: groupList, total: groupList.reduce((n, g) => n + g.count, 0) });
    }
    if (url.pathname === "/api/highlights") {
      const bookId = url.searchParams.get("bookId");
      const all = bookId ? (items[Number(bookId)] ?? []) : Object.values(items).flat();
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return json({ items: all.slice(offset, offset + limit), total: all.length });
    }
    return json({ error: "not found" }, 404);
  });
  return fetchMock;
}

function group(title: string) {
  const heading = screen.getByRole("heading", { name: new RegExp(title) });
  const section = heading.closest("section");
  if (!section) throw new Error(`no group for ${title}`);
  return within(section as HTMLElement);
}

function toggleFor(title: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^${title}`) });
}

const itemCalls = (bookId: number) =>
  fetchMock
    ?.callsTo("/api/highlights")
    .filter((u) => u.searchParams.get("bookId") === String(bookId)) ?? [];

describe("HighlightsPage", () => {
  test("groups highlights by book with counts; the newest group opens, others on demand", async () => {
    serve();
    renderWithProviders(<AppRoutes />, { path: "/highlights" });

    await screen.findByRole("heading", { name: "Highlights" });
    await screen.findByText("You have power over your mind, not outside events.");

    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings[0]).toContain("Meditations");
    expect(headings[1]).toContain("Walden");

    const med = group("Meditations");
    expect(med.getByText("Marcus Aurelius")).toBeDefined();
    expect(med.getByText("2 highlights")).toBeDefined();
    expect(med.getByRole("link", { name: /Open book/ }).getAttribute("href")).toBe("/books/1");
    expect(toggleFor("Meditations").getAttribute("aria-expanded")).toBe("true");

    const wal = group("Walden");
    expect(wal.getByText("1 highlight")).toBeDefined();
    expect(wal.getByRole("link", { name: /Open book/ }).getAttribute("href")).toBe("/books/2");
    expect(toggleFor("Walden").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/I went to the woods/)).toBeNull();
    expect(itemCalls(2)).toHaveLength(0);

    fireEvent.click(toggleFor("Walden"));
    expect(await screen.findByText(/I went to the woods/)).toBeDefined();
    expect(itemCalls(2)[0]?.searchParams.get("unposted")).toBe("1");

    fireEvent.click(toggleFor("Meditations"));
    expect(toggleFor("Meditations").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("You have power over your mind, not outside events.")).toBeNull();
  });

  test("each highlight shows its text, note and date; posted ones link to their quote", async () => {
    serve();
    renderWithProviders(<AppRoutes />, { path: "/highlights?show=all" });
    const text = await screen.findByText("You have power over your mind, not outside events.");
    expect(text.closest("blockquote")?.className).toContain("font-serif");

    const first = within(text.closest("li") as HTMLElement);
    expect(first.getByText("for the anxious days")).toBeDefined();
    expect(first.getByText(/Highlighted/).textContent).toBe("Highlighted Mar 5, 2026");
    expect(first.queryByRole("link", { name: /quote/i })).toBeNull();

    const posted = within(
      screen.getByText("The impediment to action advances action.").closest("li") as HTMLElement,
    );
    expect(posted.getByText("Posted")).toBeDefined();
    expect(posted.getByRole("link", { name: /View quote/ }).getAttribute("href")).toBe(
      "/quotes/40",
    );
  });

  test("defaults to unposted; the All toggle changes the request and the URL", async () => {
    serve();
    const { location } = renderWithProviders(<AppRoutes />, { path: "/highlights" });
    await screen.findByText("You have power over your mind, not outside events.");

    expect(screen.getByRole("radio", { name: /Unposted/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(fetchMock?.callsTo("/api/highlights/books")[0]?.searchParams.get("unposted")).toBe("1");
    expect(itemCalls(1)[0]?.searchParams.get("unposted")).toBe("1");

    fireEvent.click(screen.getByRole("radio", { name: /All/ }));

    await waitFor(() => {
      const last = fetchMock?.callsTo("/api/highlights/books").at(-1);
      expect(last?.searchParams.has("unposted")).toBe(false);
    });
    await waitFor(() => expect(itemCalls(1).at(-1)?.searchParams.has("unposted")).toBe(false));
    expect(location.history?.at(-1)).toBe("/highlights?show=all");
  });

  test("search sends q to the groups and items requests and the URL", async () => {
    serve();
    const { location } = renderWithProviders(<AppRoutes />, { path: "/highlights" });
    await screen.findByText("You have power over your mind, not outside events.");

    fireEvent.change(screen.getByLabelText("Search highlights"), { target: { value: "mind" } });

    await waitFor(() =>
      expect(fetchMock?.callsTo("/api/highlights/books").at(-1)?.searchParams.get("q")).toBe(
        "mind",
      ),
    );
    await waitFor(() => expect(itemCalls(1).at(-1)?.searchParams.get("q")).toBe("mind"));
    expect(location.history?.at(-1)).toBe("/highlights?q=mind");
  });

  test("Copy writes the quote with an attribution line to the clipboard", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t: string) => void writes.push(t) },
    });
    serve();
    renderWithProviders(<AppRoutes />, { path: "/highlights" });
    const text = await screen.findByText("You have power over your mind, not outside events.");
    const item = within(text.closest("li") as HTMLElement);

    fireEvent.click(item.getByRole("button", { name: /Copy/ }));

    await waitFor(() =>
      expect(writes).toEqual([
        "“You have power over your mind, not outside events.” — Marcus Aurelius, Meditations",
      ]),
    );
    expect(await item.findByText("Copied")).toBeDefined();
  });

  test("large groups load more on demand", async () => {
    const many = Array.from({ length: GROUP_PAGE_SIZE + 5 }, (_, i) =>
      highlightItem({ id: 100 + i, text: `Highlight number ${i}`, book: meditations }),
    );
    serve([highlightGroup({ book: meditations, count: many.length })], { 1: many });
    renderWithProviders(<AppRoutes />, { path: "/highlights" });

    await screen.findByText("Highlight number 0");
    expect(screen.queryByText(`Highlight number ${GROUP_PAGE_SIZE}`)).toBeNull();
    expect(itemCalls(1)[0]?.searchParams.get("limit")).toBe(String(GROUP_PAGE_SIZE));

    fireEvent.click(screen.getByRole("button", { name: /Show 5 more/ }));

    expect(await screen.findByText(`Highlight number ${GROUP_PAGE_SIZE + 4}`)).toBeDefined();
    expect(itemCalls(1)[1]?.searchParams.get("offset")).toBe(String(GROUP_PAGE_SIZE));
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull();
  });

  test("Shuffle shows a random unposted highlight", async () => {
    serve();
    const random = spyOn(Math, "random").mockReturnValue(0.99);
    try {
      renderWithProviders(<AppRoutes />, { path: "/highlights" });
      await screen.findByText("You have power over your mind, not outside events.");

      fireEvent.click(screen.getByRole("button", { name: /Shuffle/ }));

      const pick = await screen.findByRole("region", { name: "Random pick" });
      expect(
        within(pick).getByText("I went to the woods because I wished to live deliberately."),
      ).toBeDefined();
      expect(within(pick).getByText(/Walden/)).toBeDefined();
      const call = fetchMock
        ?.callsTo("/api/highlights")
        .find((u) => !u.searchParams.has("bookId") && u.searchParams.get("offset") === "2");
      expect(call?.searchParams.get("unposted")).toBe("1");
      expect(call?.searchParams.get("limit")).toBe("1");
    } finally {
      random.mockRestore();
    }
  });

  test("shows an empty state", async () => {
    serve([], {});
    renderWithProviders(<AppRoutes />, { path: "/highlights" });
    expect(await screen.findByText(/Every highlight has been posted/)).toBeDefined();
  });
});
