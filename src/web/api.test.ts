import { afterEach, describe, expect, test } from "bun:test";
import { json, type MockedFetch, mockFetch, quoteDetail } from "../../test/helpers/web";
import {
  ApiError,
  apiGet,
  apiSend,
  fetchQuoteDetail,
  fetchQuotes,
  fetchStats,
  mergeQuote,
  toQueryString,
  updateQuote,
} from "./api";

let fetchMock: MockedFetch | undefined;
afterEach(() => {
  fetchMock?.restore();
  fetchMock = undefined;
});

describe("toQueryString", () => {
  test("drops undefined, null and empty values", () => {
    expect(toQueryString({ q: "love", author: "", book: undefined, limit: 20, offset: 0 })).toBe(
      "?q=love&limit=20&offset=0",
    );
  });

  test("returns an empty string when nothing is set", () => {
    expect(toQueryString({ q: "", author: null })).toBe("");
  });
});

describe("apiGet", () => {
  test("returns parsed JSON", async () => {
    fetchMock = mockFetch(() => json({ ok: true }));
    expect(await apiGet<{ ok: boolean }>("/api/health")).toEqual({ ok: true });
  });

  test("throws ApiError carrying the server's { error } message and status", async () => {
    fetchMock = mockFetch(() => json({ error: "q: too long" }, 400));
    const err = await apiGet("/api/quotes").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(400);
    expect((err as ApiError).message).toBe("q: too long");
  });

  test("keeps extra fields of the error body as details", async () => {
    fetchMock = mockFetch(() => json({ error: "Text duplicates quote 9", conflictId: 9 }, 409));
    const err = (await apiGet("/api/quotes/1").catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(409);
    expect(err.details).toEqual({ conflictId: 9 });
  });

  test("falls back to the status text when the body is not JSON", async () => {
    fetchMock = mockFetch(() => new Response("boom", { status: 502, statusText: "Bad Gateway" }));
    const err = (await apiGet("/api/stats").catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/502/);
  });
});

describe("apiSend", () => {
  test("sends JSON with content-type application/json", async () => {
    fetchMock = mockFetch(() => json({ id: 1 }));
    await apiSend("PATCH", "/api/quotes/1", { author: "X" });
    const init = fetchMock.inits[0];
    expect(init?.method).toBe("PATCH");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(init?.body).toBe(JSON.stringify({ author: "X" }));
  });
});

describe("endpoint helpers", () => {
  test("fetchQuotes builds the /api/quotes query", async () => {
    fetchMock = mockFetch(() => json({ items: [], total: 0 }));
    await fetchQuotes({ q: "love", sort: "postings", limit: 20, offset: 40 });
    const url = fetchMock.calls[0];
    expect(url?.pathname).toBe("/api/quotes");
    expect(url?.searchParams.get("q")).toBe("love");
    expect(url?.searchParams.get("sort")).toBe("postings");
    expect(url?.searchParams.get("limit")).toBe("20");
    expect(url?.searchParams.get("offset")).toBe("40");
  });

  test("fetchStats hits /api/stats", async () => {
    fetchMock = mockFetch(() => json({ quotes: 3 }));
    expect(await fetchStats()).toEqual({ quotes: 3 } as never);
    expect(fetchMock.calls[0]?.pathname).toBe("/api/stats");
  });

  test("fetchQuoteDetail hits /api/quotes/:id", async () => {
    const body = quoteDetail({ quote: { id: 7 } });
    fetchMock = mockFetch(() => json(body));
    expect(await fetchQuoteDetail(7)).toEqual(body as never);
    expect(fetchMock.calls[0]?.pathname).toBe("/api/quotes/7");
  });

  test("updateQuote PATCHes only the given fields and returns the quote", async () => {
    const { quote } = quoteDetail({ quote: { id: 7, author: "New" } });
    fetchMock = mockFetch(() => json({ quote }));
    expect(await updateQuote(7, { author: "New" })).toEqual(quote as never);
    expect(fetchMock.calls[0]?.pathname).toBe("/api/quotes/7");
    expect(fetchMock.inits[0]?.method).toBe("PATCH");
    expect(fetchMock.inits[0]?.body).toBe(JSON.stringify({ author: "New" }));
  });

  test("updateQuote surfaces a 409 as ApiError", async () => {
    fetchMock = mockFetch(() => json({ error: "Text duplicates quote 3" }, 409));
    const err = (await updateQuote(7, { text: "x" }).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
  });

  test("mergeQuote POSTs { dropId } to /api/quotes/:keepId/merge", async () => {
    const body = quoteDetail({ quote: { id: 7 } });
    fetchMock = mockFetch(() => json(body));
    expect(await mergeQuote(7, 9)).toEqual(body as never);
    expect(fetchMock.calls[0]?.pathname).toBe("/api/quotes/7/merge");
    expect(fetchMock.inits[0]?.method).toBe("POST");
    expect(fetchMock.inits[0]?.body).toBe(JSON.stringify({ dropId: 9 }));
  });
});
