import { describe, expect, test } from "bun:test";
import {
  createInstagramClient,
  type FetchLike,
  InstagramApiError,
  type InstagramMedia,
} from "./client";

const TOKEN = "test-token-SECRET";
const USER_ID = "17841407547014534";
const MEDIA_FIELDS =
  "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,children{media_url,media_type}";

async function fixture(name: string): Promise<unknown> {
  return Bun.file(new URL(`../../../test/fixtures/instagram/${name}.json`, import.meta.url)).json();
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

type Responder = (url: URL) => Response | Promise<Response>;

/** A fetch fake that serves queued responses in order and records every requested URL. */
function fakeFetch(responders: Responder[]): { fetch: FetchLike; calls: URL[] } {
  const calls: URL[] = [];
  const fetch: FetchLike = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    const responder = responders[calls.length - 1];
    if (!responder) throw new Error(`unexpected fetch #${calls.length}: ${url.pathname}`);
    return responder(url);
  };
  return { fetch, calls };
}

function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms) => {
      delays.push(ms);
    },
  };
}

function client(fetch: FetchLike, overrides: Record<string, unknown> = {}) {
  return createInstagramClient({
    token: TOKEN,
    userId: USER_ID,
    fetch,
    sleep: async () => {},
    ...overrides,
  });
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

async function catchError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected promise to reject");
}

describe("listMedia", () => {
  test("requests the user's media from graph.facebook.com v24.0 with all fields", async () => {
    const page2 = await fixture("media-page-2");
    const { fetch, calls } = fakeFetch([() => json(page2)]);

    await collect(client(fetch).listMedia());

    expect(calls).toHaveLength(1);
    const url = calls[0] as URL;
    expect(url.origin).toBe("https://graph.facebook.com");
    expect(url.pathname).toBe(`/v24.0/${USER_ID}/media`);
    expect(url.searchParams.get("fields")).toBe(MEDIA_FIELDS);
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("access_token")).toBe(TOKEN);
  });

  test("follows paging.next until there is no next page", async () => {
    const page1 = (await fixture("media-page-1")) as { paging: { next: string } };
    const page2 = await fixture("media-page-2");
    const { fetch, calls } = fakeFetch([() => json(page1), () => json(page2)]);

    const media = await collect(client(fetch).listMedia());

    expect(media.map((m) => m.id)).toEqual([
      "18000000000000001",
      "18000000000000002",
      "18000000000000003",
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.toString()).toBe(page1.paging.next);
  });

  test("normalizes media into camelCase with ISO-8601 UTC timestamps", async () => {
    const page1 = await fixture("media-page-1");
    const page2 = await fixture("media-page-2");
    const { fetch } = fakeFetch([() => json(page1), () => json(page2)]);

    const [image, carousel, video] = await collect(client(fetch).listMedia());

    expect(image).toEqual({
      id: "18000000000000001",
      caption: "“The impediment to action advances action.” — Marcus Aurelius",
      mediaType: "IMAGE",
      mediaUrl: "https://scontent.cdninstagram.com/v/t51/1.jpg",
      thumbnailUrl: null,
      permalink: "https://www.instagram.com/p/AAA111/",
      timestamp: "2026-11-01T21:27:16.000Z",
      likeCount: 42,
      commentsCount: 3,
      children: [],
    } satisfies InstagramMedia);
    expect(carousel?.mediaType).toBe("CAROUSEL_ALBUM");
    expect(carousel?.children).toEqual([
      {
        id: "18000000000000021",
        mediaType: "IMAGE",
        mediaUrl: "https://scontent.cdninstagram.com/v/t51/2a.jpg",
      },
      {
        id: "18000000000000022",
        mediaType: "VIDEO",
        mediaUrl: "https://scontent.cdninstagram.com/v/t51/2b.mp4",
      },
    ]);
    expect(video?.caption).toBeNull();
    expect(video?.thumbnailUrl).toBe("https://scontent.cdninstagram.com/v/t51/3-thumb.jpg");
    expect(video?.timestamp).toBe("2026-10-01T00:00:00.000Z");
  });

  test("respects a custom host (trailing slash tolerated) and api version", async () => {
    const page2 = await fixture("media-page-2");
    const { fetch, calls } = fakeFetch([() => json(page2)]);

    await collect(
      client(fetch, { host: "http://localhost:9999/", apiVersion: "v99.0" }).listMedia(),
    );

    expect(calls[0]?.origin).toBe("http://localhost:9999");
    expect(calls[0]?.pathname).toBe(`/v99.0/${USER_ID}/media`);
  });
});

describe("getMedia", () => {
  test("fetches a single media object by id", async () => {
    const single = await fixture("media-single");
    const { fetch, calls } = fakeFetch([() => json(single)]);

    const media = await client(fetch).getMedia("18000000000000001");

    expect(calls[0]?.pathname).toBe("/v24.0/18000000000000001");
    expect(calls[0]?.searchParams.get("fields")).toBe(MEDIA_FIELDS);
    expect(calls[0]?.searchParams.get("access_token")).toBe(TOKEN);
    expect(media.id).toBe("18000000000000001");
    expect(media.likeCount).toBe(42);
    expect(media.timestamp).toBe("2026-11-01T21:27:16.000Z");
  });

  test("encodes the media id into the path", async () => {
    const single = await fixture("media-single");
    const { fetch, calls } = fakeFetch([() => json(single)]);

    await client(fetch).getMedia("a/b?c");

    expect(calls[0]?.pathname).toBe("/v24.0/a%2Fb%3Fc");
  });
});

describe("getAccount", () => {
  test("returns the username and media count", async () => {
    const account = await fixture("account");
    const { fetch, calls } = fakeFetch([() => json(account)]);

    const result = await client(fetch).getAccount();

    expect(calls[0]?.pathname).toBe(`/v24.0/${USER_ID}`);
    expect(calls[0]?.searchParams.get("fields")).toBe("id,username,media_count");
    expect(result).toEqual({ id: USER_ID, username: "quotes.engine.test", mediaCount: 597 });
  });
});

describe("errors", () => {
  test("an invalid token (OAuthException 190) is a clear InstagramApiError and is not retried", async () => {
    const body = await fixture("error-invalid-token");
    const { fetch, calls } = fakeFetch([() => json(body, 400)]);
    const { sleep, delays } = recordingSleep();

    const err = await catchError(() => client(fetch, { sleep }).getAccount());

    expect(err).toBeInstanceOf(InstagramApiError);
    const apiErr = err as InstagramApiError;
    expect(apiErr.status).toBe(400);
    expect(apiErr.code).toBe(190);
    expect(apiErr.type).toBe("OAuthException");
    expect(apiErr.fbtraceId).toBe("AbCdEfGhIjK");
    expect(apiErr.isInvalidToken).toBe(true);
    expect(apiErr.message).toContain("access token is invalid");
    expect(apiErr.message).toContain("docs/instagram-setup.md");
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  test("other 4xx Graph errors are thrown without retrying", async () => {
    const body = {
      error: { message: "Unsupported get request.", type: "GraphMethodException", code: 100 },
    };
    const { fetch, calls } = fakeFetch([() => json(body, 400)]);

    const err = (await catchError(() => client(fetch).getMedia("nope"))) as InstagramApiError;

    expect(err).toBeInstanceOf(InstagramApiError);
    expect(err.code).toBe(100);
    expect(err.isInvalidToken).toBe(false);
    expect(err.message).toContain("Unsupported get request.");
    expect(calls).toHaveLength(1);
  });

  test("error messages never contain the access token", async () => {
    const body = { error: { message: `bad token ${TOKEN}`, type: "OAuthException", code: 190 } };
    const { fetch } = fakeFetch([() => json(body, 400)]);

    const err = (await catchError(() => client(fetch).getAccount())) as InstagramApiError;

    expect(err.message).not.toContain(TOKEN);
    expect(String(err.stack)).not.toContain(TOKEN);
  });

  test("a response that does not match the expected shape is an InstagramApiError", async () => {
    const { fetch } = fakeFetch([
      () =>
        json({ data: [{ id: "1", media_type: "STORY", timestamp: "2026-11-01T21:27:16+0000" }] }),
    ]);

    const err = await catchError(() => collect(client(fetch).listMedia()));

    expect(err).toBeInstanceOf(InstagramApiError);
    expect((err as Error).message).toContain("Unexpected response");
  });

  test("an unparseable timestamp is rejected", async () => {
    const single = { ...((await fixture("media-single")) as object), timestamp: "yesterday" };
    const { fetch } = fakeFetch([() => json(single)]);

    const err = await catchError(() => client(fetch).getMedia("18000000000000001"));

    expect(err).toBeInstanceOf(InstagramApiError);
  });
});

describe("retries", () => {
  test("retries 429 with exponential backoff, then succeeds", async () => {
    const account = await fixture("account");
    const { fetch, calls } = fakeFetch([
      () => json({ error: { message: "slow down", code: 4 } }, 429),
      () => json({ error: { message: "slow down", code: 4 } }, 429),
      () => json(account),
    ]);
    const { sleep, delays } = recordingSleep();

    const result = await client(fetch, { sleep }).getAccount();

    expect(result.username).toBe("quotes.engine.test");
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([1000, 2000]);
  });

  test("retries 5xx, including non-JSON bodies", async () => {
    const account = await fixture("account");
    const { fetch, calls } = fakeFetch([
      () => new Response("<html>Bad Gateway</html>", { status: 502 }),
      () => json({ error: { message: "Service temporarily unavailable", code: 2 } }, 503),
      () => json(account),
    ]);

    const result = await client(fetch).getAccount();

    expect(result.mediaCount).toBe(597);
    expect(calls).toHaveLength(3);
  });

  test("honours a Retry-After header (seconds)", async () => {
    const account = await fixture("account");
    const { fetch } = fakeFetch([
      () => json({ error: { message: "slow down" } }, 429, { "retry-after": "7" }),
      () => json(account),
    ]);
    const { sleep, delays } = recordingSleep();

    await client(fetch, { sleep }).getAccount();

    expect(delays).toEqual([7000]);
  });

  test("gives up after maxRetries and throws the last error", async () => {
    const { fetch, calls } = fakeFetch(
      Array.from({ length: 4 }, () => () => json({ error: { message: "boom", code: 1 } }, 500)),
    );
    const { sleep, delays } = recordingSleep();

    const err = (await catchError(() =>
      client(fetch, { sleep }).getAccount(),
    )) as InstagramApiError;

    expect(err).toBeInstanceOf(InstagramApiError);
    expect(err.status).toBe(500);
    expect(err.message).toContain("boom");
    expect(calls).toHaveLength(4);
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  test("retries a rejected fetch (network error)", async () => {
    const account = await fixture("account");
    const { fetch, calls } = fakeFetch([
      () => {
        throw new TypeError("fetch failed");
      },
      () => json(account),
    ]);

    const result = await client(fetch).getAccount();

    expect(result.id).toBe(USER_ID);
    expect(calls).toHaveLength(2);
  });

  test("retries a failed page in the middle of pagination", async () => {
    const page1 = await fixture("media-page-1");
    const page2 = await fixture("media-page-2");
    const { fetch, calls } = fakeFetch([
      () => json(page1),
      () => json({ error: { message: "oops" } }, 500),
      () => json(page2),
    ]);

    const media = await collect(client(fetch).listMedia());

    expect(media).toHaveLength(3);
    expect(calls).toHaveLength(3);
  });
});
