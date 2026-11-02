import { z } from "zod";
import { DEFAULT_GRAPH_HOST } from "./config";

export const DEFAULT_API_VERSION = "v24.0";

export const MEDIA_FIELDS =
  "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,children{media_url,media_type}";

const ACCOUNT_FIELDS = "id,username,media_count";
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type InstagramMediaType = "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";

export interface InstagramMediaChild {
  id: string;
  mediaType: InstagramMediaType;
  /** Can be missing, e.g. for media flagged for copyright. */
  mediaUrl: string | null;
}

export interface InstagramMedia {
  id: string;
  caption: string | null;
  mediaType: InstagramMediaType;
  mediaUrl: string | null;
  /** Only present for VIDEO media. */
  thumbnailUrl: string | null;
  permalink: string | null;
  /** ISO-8601 UTC, e.g. `2026-11-01T21:27:16.000Z`. */
  timestamp: string;
  /** Null when the API omits it (e.g. likes hidden). */
  likeCount: number | null;
  commentsCount: number | null;
  /** Carousel items; empty for non-carousel media. */
  children: InstagramMediaChild[];
}

export interface InstagramAccount {
  id: string;
  username: string;
  mediaCount: number;
}

export interface InstagramClient {
  /** Yields every media object for the account, newest first, following `paging.next`. */
  listMedia(options?: { pageSize?: number }): AsyncGenerator<InstagramMedia, void, undefined>;
  getMedia(id: string): Promise<InstagramMedia>;
  getAccount(): Promise<InstagramAccount>;
}

export interface InstagramClientOptions {
  token: string;
  userId: string;
  host?: string;
  apiVersion?: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Retries for 429, 5xx and network errors (default 3). */
  maxRetries?: number;
  /** First backoff delay; doubles on every retry (default 1000ms). */
  baseDelayMs?: number;
}

export interface InstagramApiErrorDetails {
  status?: number | null;
  code?: number | null;
  subcode?: number | null;
  type?: string | null;
  fbtraceId?: string | null;
}

export class InstagramApiError extends Error {
  override name = "InstagramApiError";
  readonly status: number | null;
  readonly code: number | null;
  readonly subcode: number | null;
  readonly type: string | null;
  readonly fbtraceId: string | null;

  constructor(message: string, details: InstagramApiErrorDetails = {}) {
    super(message);
    this.status = details.status ?? null;
    this.code = details.code ?? null;
    this.subcode = details.subcode ?? null;
    this.type = details.type ?? null;
    this.fbtraceId = details.fbtraceId ?? null;
  }

  /** OAuthException code 190: the token is invalid, expired or revoked. */
  get isInvalidToken(): boolean {
    return this.code === 190;
  }
}

// --- Response schemas -------------------------------------------------------

const GRAPH_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/** Converts Graph timestamps like `2026-11-01T21:27:16+0000` to ISO-8601 UTC. */
export function toIsoUtc(timestamp: string): string | null {
  if (!GRAPH_TIMESTAMP.test(timestamp)) return null;
  const date = new Date(timestamp.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const timestampSchema = z.string().transform((value, ctx) => {
  const iso = toIsoUtc(value);
  if (iso === null) {
    ctx.addIssue({ code: "custom", message: `invalid timestamp: ${value}` });
    return z.NEVER;
  }
  return iso;
});

const mediaTypeSchema = z.enum(["IMAGE", "VIDEO", "CAROUSEL_ALBUM"]);

const childSchema = z
  .object({ id: z.string(), media_type: mediaTypeSchema, media_url: z.string().nullish() })
  .transform(
    (raw): InstagramMediaChild => ({
      id: raw.id,
      mediaType: raw.media_type,
      mediaUrl: raw.media_url ?? null,
    }),
  );

const mediaSchema = z
  .object({
    id: z.string(),
    caption: z.string().nullish(),
    media_type: mediaTypeSchema,
    media_url: z.string().nullish(),
    thumbnail_url: z.string().nullish(),
    permalink: z.string().nullish(),
    timestamp: timestampSchema,
    like_count: z.number().int().nullish(),
    comments_count: z.number().int().nullish(),
    children: z.object({ data: z.array(childSchema) }).nullish(),
  })
  .transform(
    (raw): InstagramMedia => ({
      id: raw.id,
      caption: raw.caption ?? null,
      mediaType: raw.media_type,
      mediaUrl: raw.media_url ?? null,
      thumbnailUrl: raw.thumbnail_url ?? null,
      permalink: raw.permalink ?? null,
      timestamp: raw.timestamp,
      likeCount: raw.like_count ?? null,
      commentsCount: raw.comments_count ?? null,
      children: raw.children?.data ?? [],
    }),
  );

const mediaPageSchema = z.object({
  data: z.array(mediaSchema),
  paging: z.object({ next: z.string().nullish() }).nullish(),
});

const accountSchema = z
  .object({ id: z.string(), username: z.string(), media_count: z.number().int() })
  .transform(
    (raw): InstagramAccount => ({
      id: raw.id,
      username: raw.username,
      mediaCount: raw.media_count,
    }),
  );

const graphErrorSchema = z.object({
  error: z.object({
    message: z.string().nullish(),
    type: z.string().nullish(),
    code: z.number().nullish(),
    error_subcode: z.number().nullish(),
    fbtrace_id: z.string().nullish(),
  }),
});

// --- Client -----------------------------------------------------------------

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryAfterMs(res: Response): number | null {
  const header = res.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createInstagramClient(options: InstagramClientOptions): InstagramClient {
  const {
    token,
    userId,
    apiVersion = DEFAULT_API_VERSION,
    fetch = (input, init) => globalThis.fetch(input, init),
    sleep = (ms) => Bun.sleep(ms),
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
  } = options;
  const host = (options.host ?? DEFAULT_GRAPH_HOST).replace(/\/+$/, "");

  /** Keeps the token out of anything that might be logged. */
  const redact = (text: string): string => (token ? text.split(token).join("[redacted]") : text);

  function graphUrl(path: string, params: Record<string, string>): URL {
    const url = new URL(`${host}/${apiVersion}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("access_token", token);
    return url;
  }

  function errorFromResponse(res: Response, body: unknown, path: string): InstagramApiError {
    const parsed = graphErrorSchema.safeParse(body);
    const graph = parsed.success ? parsed.data.error : null;
    const details: InstagramApiErrorDetails = {
      status: res.status,
      code: graph?.code,
      subcode: graph?.error_subcode,
      type: graph?.type,
      fbtraceId: graph?.fbtrace_id,
    };
    const detail = graph?.message ?? `HTTP ${res.status}`;
    if (graph?.code === 190) {
      return new InstagramApiError(
        redact(
          `Instagram access token is invalid or expired (OAuthException code 190): ${detail}. ` +
            "Generate a new token and update 1Password; see docs/instagram-setup.md.",
        ),
        details,
      );
    }
    const codeText = graph?.code != null ? `, code ${graph.code}` : "";
    return new InstagramApiError(
      redact(`Instagram Graph API error on ${path} (HTTP ${res.status}${codeText}): ${detail}`),
      details,
    );
  }

  async function request<T>(url: URL, schema: z.ZodType<T>): Promise<T> {
    const path = url.pathname;
    for (let attempt = 0; ; attempt++) {
      const backoff = baseDelayMs * 2 ** attempt;
      const canRetry = attempt < maxRetries;

      let res: Response;
      try {
        res = await fetch(url.toString());
      } catch (err) {
        if (canRetry) {
          await sleep(backoff);
          continue;
        }
        const reason = err instanceof Error ? err.message : String(err);
        throw new InstagramApiError(redact(`Network error calling ${path}: ${reason}`));
      }

      const body = await readBody(res);
      if (!res.ok) {
        if (isRetryableStatus(res.status) && canRetry) {
          await sleep(retryAfterMs(res) ?? backoff);
          continue;
        }
        throw errorFromResponse(res, body, path);
      }

      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        throw new InstagramApiError(
          redact(`Unexpected response from ${path}: ${z.prettifyError(parsed.error)}`),
          { status: res.status },
        );
      }
      return parsed.data;
    }
  }

  return {
    async *listMedia({ pageSize = DEFAULT_PAGE_SIZE } = {}) {
      let url: URL | null = graphUrl(`${encodeURIComponent(userId)}/media`, {
        fields: MEDIA_FIELDS,
        limit: String(pageSize),
      });
      while (url) {
        const page: z.output<typeof mediaPageSchema> = await request(url, mediaPageSchema);
        yield* page.data;
        const next: string | null | undefined = page.paging?.next;
        url = next ? new URL(next) : null;
      }
    },

    getMedia(id) {
      return request(graphUrl(encodeURIComponent(id), { fields: MEDIA_FIELDS }), mediaSchema);
    },

    getAccount() {
      return request(
        graphUrl(encodeURIComponent(userId), { fields: ACCOUNT_FIELDS }),
        accountSchema,
      );
    },
  };
}
