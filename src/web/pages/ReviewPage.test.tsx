import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { AppShell } from "@/components/AppShell";
import {
  duplicateQuote,
  emptyStats,
  json,
  type MockedFetch,
  mockFetch,
  quoteDetail,
  renderWithProviders,
  reviewLink,
} from "../../../test/helpers/web";
import { ReviewPage } from "./ReviewPage";

type Link = ReturnType<typeof reviewLink>;
type Pair = {
  a: ReturnType<typeof duplicateQuote>;
  b: ReturnType<typeof duplicateQuote>;
  score: number;
};

let fetchMock: MockedFetch | undefined;
afterEach(() => {
  cleanup();
  fetchMock?.restore();
  fetchMock = undefined;
});

/** An in-memory stand-in for the review API. */
function fakeServer(initial: { links?: Link[]; duplicates?: Pair[] } = {}) {
  const state = { links: initial.links ?? [], duplicates: initial.duplicates ?? [] };
  fetchMock = mockFetch(async (url, init) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const path = url.pathname;
    if (method === "GET" && path === "/api/review") return json(state);
    if (method === "GET" && path === "/api/stats") {
      return json({ ...emptyStats, needsReview: state.links.length });
    }
    if (method === "POST" && path === "/api/review/duplicates/dismiss") {
      state.duplicates = state.duplicates.filter(
        (p) => !(p.a.id === body.aId && p.b.id === body.bId),
      );
      return json({ aId: body.aId, bId: body.bId });
    }
    const resolve = /^\/api\/review\/(\d+)\/(\d+)$/.exec(path);
    if (method === "POST" && resolve) {
      const [postId, quoteId] = [Number(resolve[1]), Number(resolve[2])];
      state.links = state.links.filter((l) => !(l.postId === postId && l.quoteId === quoteId));
      return json({ postId, quoteId, action: body.action });
    }
    const merge = /^\/api\/quotes\/(\d+)\/merge$/.exec(path);
    if (method === "POST" && merge) {
      const keepId = Number(merge[1]);
      state.duplicates = state.duplicates.filter((p) => ![p.a.id, p.b.id].includes(body.dropId));
      return json(quoteDetail({ quote: { id: keepId } }));
    }
    const quote = /^\/api\/quotes\/(\d+)$/.exec(path);
    if (quote && method === "PATCH") {
      const id = Number(quote[1]);
      for (const l of state.links) if (l.quoteId === id) Object.assign(l.quote, body);
      const current = state.links.find((l) => l.quoteId === id)?.quote ?? {};
      return json(quoteDetail({ quote: { ...current, id, ...body } }));
    }
    if (quote && method === "GET") {
      const id = Number(quote[1]);
      const q = state.duplicates.flatMap((p) => [p.a, p.b]).find((x) => x.id === id);
      return json(quoteDetail({ quote: { ...q, id } }));
    }
    return json({ error: `Unhandled ${method} ${path}` }, 500);
  });
  return state;
}

function requestsTo(method: string, pathname: string): unknown[] {
  const mock = fetchMock as MockedFetch;
  return mock.calls.flatMap((u, i) => {
    const init = mock.inits[i];
    if (u.pathname !== pathname || (init?.method ?? "GET") !== method) return [];
    return [typeof init?.body === "string" ? JSON.parse(init.body) : undefined];
  });
}

const press = (key: string, target: Element = document.body) => fireEvent.keyDown(target, { key });

function renderReview(path = "/review") {
  return renderWithProviders(<ReviewPage />, { path });
}

const twoLinks = () => [
  reviewLink({
    postId: 10,
    quoteId: 1,
    confidence: 0.55,
    post: { caption: "Monday thoughts #quotes" },
    quote: { text: "THE ONLY WAY OUT IS THROUGH", author: "Robert Frost" },
  }),
  reviewLink({ postId: 11, quoteId: 2, quote: { text: "SO IT GOES" } }),
];

describe("ReviewPage — extractions", () => {
  test("shows the post image large beside the extracted quote and caption", async () => {
    fakeServer({ links: twoLinks() });
    renderReview();
    const card = await screen.findByRole("article", { name: /post 10/i });
    const img = within(card).getByRole("img");
    expect(img.getAttribute("src")).toBe("/media/10.jpg");
    expect(within(card).getByText("THE ONLY WAY OUT IS THROUGH")).toBeDefined();
    expect(within(card).getByText("Monday thoughts #quotes")).toBeDefined();
    expect(within(card).getByText("Robert Frost")).toBeDefined();
    expect(within(card).getByText(/55%/)).toBeDefined();
    expect(screen.getByText(/1 of 2/)).toBeDefined();
  });

  test("Confirm calls the API and removes the item from the list", async () => {
    fakeServer({ links: twoLinks() });
    renderReview();
    await screen.findByRole("article", { name: /post 10/i });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    expect(await screen.findByRole("article", { name: /post 11/i })).toBeDefined();
    expect(screen.queryByText("THE ONLY WAY OUT IS THROUGH")).toBeNull();
    expect(requestsTo("POST", "/api/review/10/1")).toEqual([{ action: "confirm" }]);
    expect(screen.getByText(/1 of 1/)).toBeDefined();
  });

  test("Reject calls the API and removes the item from the list", async () => {
    fakeServer({ links: twoLinks() });
    renderReview();
    await screen.findByRole("article", { name: /post 10/i });
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));

    expect(await screen.findByRole("article", { name: /post 11/i })).toBeDefined();
    expect(requestsTo("POST", "/api/review/10/1")).toEqual([{ action: "reject" }]);
  });

  test("an empty queue says so", async () => {
    fakeServer();
    renderReview();
    expect(await screen.findByText(/nothing to review/i)).toBeDefined();
  });

  test("a failed action puts the item back and shows the error", async () => {
    const state = fakeServer({ links: twoLinks() });
    const original = fetchMock as MockedFetch;
    original.restore();
    fetchMock = mockFetch((url, init) =>
      init?.method === "POST"
        ? json({ error: "Database is locked" }, 500)
        : json(
            url.pathname === "/api/stats"
              ? { ...emptyStats, needsReview: state.links.length }
              : state,
          ),
    );
    renderReview();
    await screen.findByRole("article", { name: /post 10/i });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/database is locked/i);
    expect(screen.getByRole("article", { name: /post 10/i })).toBeDefined();
  });

  test("keyboard: j/k move, c confirms, r rejects", async () => {
    fakeServer({
      links: [...twoLinks(), reviewLink({ postId: 12, quoteId: 3 })],
    });
    renderReview();
    await screen.findByRole("article", { name: /post 10/i });

    press("j");
    expect(screen.getByRole("article", { name: /post 11/i })).toBeDefined();
    press("j");
    expect(screen.getByRole("article", { name: /post 12/i })).toBeDefined();
    press("j"); // stays on the last item
    expect(screen.getByRole("article", { name: /post 12/i })).toBeDefined();
    press("k");
    expect(screen.getByRole("article", { name: /post 11/i })).toBeDefined();

    press("c");
    await waitFor(() => expect(requestsTo("POST", "/api/review/11/2")).toHaveLength(1));
    expect(requestsTo("POST", "/api/review/11/2")).toEqual([{ action: "confirm" }]);
    // The next item takes its place.
    expect(await screen.findByRole("article", { name: /post 12/i })).toBeDefined();

    press("r");
    await waitFor(() =>
      expect(requestsTo("POST", "/api/review/12/3")).toEqual([{ action: "reject" }]),
    );
    expect(await screen.findByRole("article", { name: /post 10/i })).toBeDefined();
  });

  test("keyboard: e edits the text; shortcuts don't fire while typing", async () => {
    fakeServer({ links: twoLinks() });
    renderReview();
    await screen.findByRole("article", { name: /post 10/i });

    press("e");
    const box = await screen.findByRole("textbox", { name: /quote text/i });
    press("c", box);
    press("j", box);
    press("r", box);
    fireEvent.change(box, { target: { value: "The only way out is through." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("The only way out is through.")).toBeDefined();
    expect(requestsTo("PATCH", "/api/quotes/1")).toEqual([
      { text: "The only way out is through." },
    ]);
    expect(requestsTo("POST", "/api/review/10/1")).toEqual([]);
    // Still on the same item, ready to confirm.
    expect(screen.getByRole("article", { name: /post 10/i })).toBeDefined();
  });

  test("a link whose action failed while another was in flight can be retried", async () => {
    const state = fakeServer({ links: twoLinks() });
    const fake = fetchMock as MockedFetch;
    fake.restore();
    let failFirst: (() => void) | undefined;
    fetchMock = mockFetch((url, init) => {
      if (init?.method === "POST" && url.pathname === "/api/review/10/1" && !failFirst) {
        return new Promise((resolve) => {
          failFirst = () => resolve(json({ error: "Database is locked" }, 500));
        });
      }
      if (init?.method === "POST" && url.pathname === "/api/review/11/2") {
        state.links = state.links.filter((l) => l.postId !== 11);
        return json({ postId: 11, quoteId: 2, action: "confirm" });
      }
      if (init?.method === "POST") return json({ postId: 10, quoteId: 1, action: "confirm" });
      return json(state);
    });
    renderReview();
    await screen.findByRole("article", { name: /post 10/i });
    press("c"); // held, then fails
    await screen.findByRole("article", { name: /post 11/i });
    press("c"); // succeeds while the first is still in flight
    await waitFor(() => expect(requestsTo("POST", "/api/review/11/2")).toHaveLength(1));
    await waitFor(() => expect(failFirst).toBeDefined());
    failFirst?.();
    // The failed link comes back; confirming it again sends a new request.
    await screen.findByRole("article", { name: /post 10/i });
    await screen.findByRole("alert");
    press("c");
    await waitFor(() => expect(requestsTo("POST", "/api/review/10/1")).toHaveLength(2));
  });

  test("saving an edit doesn't refetch the queue while a confirm is in flight", async () => {
    const state = fakeServer({ links: twoLinks() });
    const inner = fetchMock as MockedFetch;
    const handler = async (url: URL, init: RequestInit | undefined) => {
      if (init?.method === "POST" && url.pathname === "/api/review/10/1" && !release) {
        await new Promise<void>((r) => {
          release = r;
        });
        state.links = state.links.filter((l) => l.postId !== 10);
        return json({ postId: 10, quoteId: 1, action: "confirm" });
      }
      if (init?.method === "PATCH") {
        const body = JSON.parse(init.body as string);
        for (const l of state.links) if (l.quoteId === 2) Object.assign(l.quote, body);
        return json(quoteDetail({ quote: { id: 2, ...body } }));
      }
      return json(url.pathname === "/api/stats" ? emptyStats : state);
    };
    let release: (() => void) | undefined;
    inner.restore();
    fetchMock = mockFetch(handler);
    renderReview();
    await screen.findByRole("article", { name: /post 10/i });
    press("c");
    await screen.findByRole("article", { name: /post 11/i });
    await waitFor(() => expect(release).toBeDefined());
    const gets = requestsTo("GET", "/api/review").length;

    press("e");
    const box = await screen.findByRole("textbox", { name: /quote text/i });
    fireEvent.change(box, { target: { value: "So it goes." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("So it goes.")).toBeDefined();
    await new Promise((r) => setTimeout(r, 20));
    // A refetch now would read the server before it applied the confirm and bring post 10 back.
    expect(requestsTo("GET", "/api/review")).toHaveLength(gets);
    expect(screen.queryByRole("article", { name: /post 10/i })).toBeNull();

    release?.();
    await waitFor(() => expect(requestsTo("GET", "/api/review").length).toBeGreaterThan(gets));
    expect(screen.getByRole("article", { name: /post 11/i })).toBeDefined();
  });

  /**
   * A server whose PATCH of quote 1 collides with quote 12, and whose `GET /api/review`
   * hangs once `hold.on` is set, so the test sees the cache as the page left it.
   */
  function collidingServer(mergeResponse: () => Response) {
    const state = { links: twoLinks(), duplicates: [] as Pair[] };
    const hold = { on: false };
    fetchMock = mockFetch((url, init) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && url.pathname === "/api/review") {
        return hold.on ? new Promise<Response>(() => {}) : json(state);
      }
      if (method === "PATCH") {
        return json({ error: "Another quote already has this text", conflictId: 12 }, 409);
      }
      if (method === "POST" && url.pathname === "/api/quotes/12/merge") {
        hold.on = true;
        return mergeResponse();
      }
      if (method === "POST") return json({ postId: 10, quoteId: 12, action: "confirm" });
      return json(url.pathname === "/api/stats" ? emptyStats : quoteDetail());
    });
    return hold;
  }

  async function mergeIntoConflict() {
    renderReview();
    await screen.findByRole("article", { name: /post 10/i });
    press("e");
    const box = await screen.findByRole("textbox", { name: /quote text/i });
    fireEvent.change(box, { target: { value: "So it goes." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: /merge into #12/i }));
  }

  test("a failed merge into the conflicting quote shows the error", async () => {
    collidingServer(() => json({ error: "Quote 12 not found" }, 404));
    await mergeIntoConflict();
    expect(await screen.findByText(/quote 12 not found/i)).toBeDefined();
  });

  test("merging into the conflicting quote moves the queued link to it", async () => {
    collidingServer(() =>
      json(quoteDetail({ quote: { id: 12, text: "So it goes.", author: "Kurt Vonnegut" } })),
    );
    await mergeIntoConflict();
    await waitFor(() => expect(screen.getByText("Quote #12")).toBeDefined());
    press("c");
    await waitFor(() =>
      expect(requestsTo("POST", "/api/review/10/12")).toEqual([{ action: "confirm" }]),
    );
    expect(requestsTo("POST", "/api/review/10/1")).toEqual([]);
  });

  test("an edit shows on the Duplicates tab too, before any refetch", async () => {
    const link = reviewLink({ postId: 10, quoteId: 4, quote: { text: "THE ONLY WAY" } });
    const state = {
      links: [link],
      duplicates: [
        {
          a: duplicateQuote({ id: 4, text: "THE ONLY WAY" }),
          b: duplicateQuote({ id: 9, text: "The only way." }),
          score: 0.9,
        },
      ],
    };
    let hold = false;
    fetchMock = mockFetch((url, init) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && url.pathname === "/api/review") {
        return hold ? new Promise<Response>(() => {}) : json(state);
      }
      if (method === "PATCH") {
        hold = true;
        return json(quoteDetail({ quote: { id: 4, text: "The only way out." } }));
      }
      return json(url.pathname === "/api/stats" ? emptyStats : quoteDetail());
    });
    renderReview();
    await screen.findByRole("article", { name: /post 10/i });
    press("e");
    const box = await screen.findByRole("textbox", { name: /quote text/i });
    fireEvent.change(box, { target: { value: "The only way out." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("The only way out.");
    fireEvent.mouseDown(screen.getByRole("tab", { name: /duplicates/i }));
    const card = await screen.findByRole("article", { name: /quotes #4 and #9/i });
    expect(within(card).getByText("The only way out.")).toBeDefined();
    expect(within(card).queryByText("THE ONLY WAY")).toBeNull();
  });

  test("the author and book can be fixed inline", async () => {
    fakeServer({ links: twoLinks() });
    renderReview();
    await screen.findByRole("article", { name: /post 10/i });
    fireEvent.click(screen.getByRole("button", { name: "Add book" }));
    const box = screen.getByRole("textbox", { name: "Book" });
    fireEvent.change(box, { target: { value: "A Servant to Servants" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText("A Servant to Servants")).toBeDefined();
    expect(requestsTo("PATCH", "/api/quotes/1")).toEqual([
      { sourceTitle: "A Servant to Servants" },
    ]);
  });

  test("the nav badge count drops after each action", async () => {
    fakeServer({ links: twoLinks() });
    renderWithProviders(
      <AppShell>
        <ReviewPage />
      </AppShell>,
      { path: "/review" },
    );
    expect(await screen.findByRole("link", { name: /2 awaiting review/i })).toBeDefined();
    await screen.findByRole("article", { name: /post 10/i });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(await screen.findByRole("link", { name: /1 awaiting review/i })).toBeDefined();
  });

  test("Mark as song calls the API and moves on (#42)", async () => {
    fakeServer({ links: twoLinks() });
    renderReview();
    await screen.findByRole("article", { name: /post 10/i });
    fireEvent.click(screen.getByRole("button", { name: /mark as song/i }));

    expect(await screen.findByRole("article", { name: /post 11/i })).toBeDefined();
    expect(requestsTo("POST", "/api/review/10/1")).toEqual([{ action: "song" }]);
  });

  test("keyboard: s marks the link a song", async () => {
    fakeServer({ links: twoLinks() });
    renderReview();
    await screen.findByRole("article", { name: /post 10/i });
    press("s");
    expect(await screen.findByRole("article", { name: /post 11/i })).toBeDefined();
    expect(requestsTo("POST", "/api/review/10/1")).toEqual([{ action: "song" }]);
  });

  test("the kind selector relabels the fields and saves the kind", async () => {
    fakeServer({ links: twoLinks() });
    renderReview();
    const card = await screen.findByRole("article", { name: /post 10/i });
    expect(within(card).getByRole("button", { name: "Add book" })).toBeDefined();
    fireEvent.click(within(card).getByRole("radio", { name: "Song" }));
    await waitFor(() =>
      expect(requestsTo("PATCH", "/api/quotes/1")).toEqual([{ sourceKind: "song" }]),
    );
    expect(await within(card).findByRole("button", { name: "Add song" })).toBeDefined();
    expect(within(card).getByRole("button", { name: "Edit artist" })).toBeDefined();
  });
});

describe("ReviewPage — duplicates", () => {
  const pair = (): Pair => ({
    a: duplicateQuote({ id: 4, text: "The only way out is through.", postingCount: 2 }),
    b: duplicateQuote({ id: 9, text: "THE ONLY WAY OUT IS THROUGH", postingCount: 1 }),
    score: 0.91,
  });

  async function openDuplicates() {
    renderReview("/review?tab=duplicates");
    return screen.findByRole("article", { name: /quotes #4 and #9/i });
  }

  test("shows the pair side by side with its similarity score", async () => {
    fakeServer({ duplicates: [pair()] });
    const card = await openDuplicates();
    expect(within(card).getByText("The only way out is through.")).toBeDefined();
    expect(within(card).getByText("THE ONLY WAY OUT IS THROUGH")).toBeDefined();
    expect(within(card).getByText(/91%/)).toBeDefined();
  });

  test("the tab can be switched from extractions", async () => {
    fakeServer({ links: twoLinks(), duplicates: [pair()] });
    renderReview();
    await screen.findByRole("article", { name: /post 10/i });
    fireEvent.mouseDown(screen.getByRole("tab", { name: /duplicates/i }));
    expect(await screen.findByRole("article", { name: /quotes #4 and #9/i })).toBeDefined();
  });

  test("Merge calls merge with the kept and dropped ids, and removes the pair", async () => {
    fakeServer({ duplicates: [pair()] });
    const card = await openDuplicates();
    fireEvent.click(within(card).getByRole("button", { name: /keep #9/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: /merge into this quote/i }));

    await waitFor(() => expect(requestsTo("POST", "/api/quotes/9/merge")).toEqual([{ dropId: 4 }]));
    expect(await screen.findByText(/no likely duplicates/i)).toBeDefined();
  });

  test("Not a duplicate dismisses the pair", async () => {
    fakeServer({ duplicates: [pair()] });
    const card = await openDuplicates();
    fireEvent.click(within(card).getByRole("button", { name: /not a duplicate/i }));
    expect(await screen.findByText(/no likely duplicates/i)).toBeDefined();
    expect(requestsTo("POST", "/api/review/duplicates/dismiss")).toEqual([{ aId: 4, bId: 9 }]);
  });
});
