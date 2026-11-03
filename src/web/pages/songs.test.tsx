// Songs as a quote source in the UI (#42). Lyrics, artists and songs here are invented.
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  json,
  type MockedFetch,
  mockFetch,
  quoteDetail,
  quoteItem,
  renderWithProviders,
} from "../../../test/helpers/web";
import { QuoteDetailPage } from "./QuoteDetailPage";
import { SearchPage } from "./SearchPage";

let fetchMock: MockedFetch | undefined;
afterEach(() => {
  cleanup();
  fetchMock?.restore();
  fetchMock = undefined;
});

const SONG = {
  id: 7,
  text: "Static on the radio, lanterns in the rain",
  author: "The Paper Lanterns",
  sourceTitle: "Northbound Static",
  sourceKind: "song",
  bookId: null,
};

function patches(): unknown[] {
  const mock = fetchMock as MockedFetch;
  return mock.calls.flatMap((u, i) => {
    const init = mock.inits[i];
    if (init?.method !== "PATCH" || u.pathname !== "/api/quotes/7") return [];
    return [JSON.parse(String(init.body))];
  });
}

describe("QuoteDetailPage source kind", () => {
  test("a song shows Artist and Song labels and no book link", async () => {
    fetchMock = mockFetch(() => json(quoteDetail({ quote: SONG })));
    renderWithProviders(<QuoteDetailPage id="7" />, { path: "/quotes/7" });

    await screen.findByText(SONG.text);
    expect(screen.getByRole("radio", { name: "Song" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: "Edit artist" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Edit song" })).toBeDefined();
    expect(screen.queryByRole("link", { name: SONG.sourceTitle })).toBeNull();
    expect(screen.getByText(SONG.sourceTitle)).toBeDefined();
  });

  test("picking Song relabels the fields and PATCHes the kind", async () => {
    const state = { ...SONG, sourceKind: "book" };
    fetchMock = mockFetch((_url, init) => {
      if (init?.method === "PATCH") {
        Object.assign(state, JSON.parse(String(init.body)));
        return json({ quote: quoteDetail({ quote: state }).quote });
      }
      return json(quoteDetail({ quote: state }));
    });
    renderWithProviders(<QuoteDetailPage id="7" />, { path: "/quotes/7" });

    await screen.findByText(SONG.text);
    expect(screen.getByRole("button", { name: "Edit author" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Edit book" })).toBeDefined();

    fireEvent.click(screen.getByRole("radio", { name: "Song" }));
    await waitFor(() => expect(patches()).toEqual([{ sourceKind: "song" }]));
    expect(await screen.findByRole("button", { name: "Edit artist" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Edit song" })).toBeDefined();
  });
});

describe("SearchPage kind filter", () => {
  test("?kind=song filters the request, and song rows get a Song badge", async () => {
    fetchMock = mockFetch((url) => {
      if (url.pathname === "/api/quotes") {
        return json({ items: [quoteItem({ ...SONG, book: null })], total: 1 });
      }
      return json({ items: [] });
    });
    renderWithProviders(<SearchPage />, { path: "/?kind=song" });

    await waitFor(() =>
      expect(fetchMock?.callsTo("/api/quotes").at(-1)?.searchParams.get("kind")).toBe("song"),
    );
    const card = (await screen.findByText(SONG.text)).closest("article") as HTMLElement;
    expect(within(card).getByText("Song")).toBeDefined();
    expect(within(card).queryByRole("link", { name: SONG.sourceTitle })).toBeNull();
    const chips = screen.getByRole("list", { name: /active filters/i });
    expect(within(chips).getByText("Songs")).toBeDefined();
  });

  test("the Kind control updates the URL and drops No book", async () => {
    fetchMock = mockFetch((url) =>
      url.pathname === "/api/quotes" ? json({ items: [], total: 0 }) : json({ items: [] }),
    );
    const { location } = renderWithProviders(<SearchPage />, { path: "/?nobook=1" });
    const kind = await screen.findByRole("radiogroup", { name: "Kind" });
    fireEvent.click(within(kind).getByRole("radio", { name: "Songs" }));
    await waitFor(() => {
      const url = new URL(location.history?.at(-1) ?? "/", "http://localhost");
      expect(url.searchParams.get("kind")).toBe("song");
      expect(url.searchParams.has("nobook")).toBe(false);
    });
    await waitFor(() =>
      expect(fetchMock?.callsTo("/api/quotes").at(-1)?.searchParams.get("kind")).toBe("song"),
    );
  });
});
