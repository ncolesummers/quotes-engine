import type { Database } from "bun:sqlite";
import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { BunRequest } from "bun";
import { z } from "zod";
import { getBookDetail, listBooks } from "./repos/books";
import { getQuoteHighlights, listHighlights } from "./repos/highlights";
import { getQuote, getQuoteDetail, mergeQuotes, searchQuotes, updateQuote } from "./repos/quotes";
import { findDuplicatePairs, listReviewLinks, resolveLink } from "./repos/review";
import { getStats } from "./repos/stats";

export const DEFAULT_MEDIA_DIR = "data/media";

export interface RoutesOptions {
  /** Directory served at `/media/*`; `posts.media_path` values are relative to it. */
  mediaDir?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Extra fields for the error body, e.g. `{ conflictId }` on a 409. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function errorResponse(status: number, error: string, details = {}): Response {
  return Response.json({ ...details, error }, { status });
}

/** Wrap a handler so thrown `HttpError`s (and unexpected errors) become JSON responses. */
function handle<R extends Request>(fn: (req: R) => Response | Promise<Response>) {
  return async (req: R): Promise<Response> => {
    try {
      return await fn(req);
    } catch (err) {
      if (err instanceof HttpError) return errorResponse(err.status, err.message, err.details);
      console.error(err);
      return errorResponse(500, "Internal server error");
    }
  };
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, formatZodError(result.error));
  return result.data;
}

/** Query params as an object, dropping empty values so `?q=` means "no filter". */
function parseQuery<T extends z.ZodType>(schema: T, req: Request): z.output<T> {
  const params = new URL(req.url).searchParams;
  const raw: Record<string, string> = {};
  for (const [key, value] of params) if (value !== "") raw[key] = value;
  return parse(schema, raw);
}

/**
 * CSRF guard for mutations. Requiring `application/json` forces a CORS preflight for
 * cross-origin browser requests (which this server never approves), and an `Origin` header,
 * when present, must match the request's own host.
 */
function assertSameOriginJson(req: Request): void {
  const origin = req.headers.get("origin");
  if (origin !== null) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {}
    if (originHost !== req.headers.get("host")) {
      throw new HttpError(403, "Cross-origin requests are not allowed");
    }
  }
  const type = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    throw new HttpError(415, "Content-Type must be application/json");
  }
}

async function parseBody<T extends z.ZodType>(schema: T, req: Request): Promise<z.output<T>> {
  assertSameOriginJson(req);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  return parse(schema, body);
}

const id = z
  .string()
  .regex(/^[1-9]\d*$/, "must be a positive integer")
  .transform(Number);
const positiveInt = z.number().int().positive();
const text = z.string().trim().max(500).optional();
const limit = z.coerce.number().int().min(1).max(200).default(50);
const offset = z.coerce.number().int().min(0).default(0);

const quotesQuery = z.object({
  q: text,
  author: text,
  book: text,
  posted: z.enum(["yes", "no"]).optional(),
  minPostings: z.coerce.number().int().min(0).optional(),
  sort: z.enum(["likes", "comments", "recent", "postings"]).default("recent"),
  limit,
  offset,
});

const nullableText = z
  .string()
  .trim()
  .nullable()
  .optional()
  .transform((v) => (v === "" ? null : v));

const quotePatch = z
  .strictObject({
    text: z.string().trim().min(1).optional(),
    author: nullableText,
    sourceTitle: nullableText,
    notes: nullableText,
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), "No fields to update");

const mergeBody = z.object({ dropId: positiveInt });

const highlightsQuery = z.object({
  unposted: z
    .enum(["1", "0", "true", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true"),
  book: text,
  q: text,
  limit,
  offset,
});

const booksQuery = z.object({
  q: text,
  sort: z.enum(["title", "quotes", "posted", "recent"]).default("title"),
});

const reviewBody = z.object({ action: z.enum(["confirm", "reject"]) });

/** URL for a media file stored relative to the media dir, or null. */
export function mediaUrl(mediaPath: string | null): string | null {
  if (!mediaPath) return null;
  return `/media/${mediaPath.split("/").map(encodeURIComponent).join("/")}`;
}

function quoteDetail(db: Database, quoteId: number) {
  const detail = getQuoteDetail(db, quoteId);
  if (!detail) throw new HttpError(404, `Quote ${quoteId} not found`);
  return {
    quote: detail.quote,
    book: detail.book,
    postings: detail.postings.map((p) => ({ ...p, mediaUrl: mediaUrl(p.mediaPath) })),
    highlights: getQuoteHighlights(db, quoteId),
  };
}

/** Resolve a `/media/*` request to a file inside `mediaDir`, or throw an `HttpError`. */
async function mediaFile(mediaDir: string, req: Request): Promise<Response> {
  const prefix = "/media/";
  const pathname = new URL(req.url).pathname;
  // Bun routes on the raw path but normalizes `req.url`, so "/media/../x" arrives as "/x".
  if (!pathname.startsWith(prefix)) throw new HttpError(403, "Forbidden");
  let rel: string;
  try {
    rel = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    throw new HttpError(400, "Invalid path");
  }
  const base = resolve(mediaDir);
  if (rel.includes("\0") || !resolve(base, rel).startsWith(base + sep)) {
    throw new HttpError(403, "Forbidden");
  }
  // Symlinks are followed when serving, so check containment on canonical paths too.
  const realBase = await realpath(base).catch(() => null);
  const real = await realpath(resolve(base, rel)).catch(() => null);
  if (!realBase || !real) throw new HttpError(404, "Not found");
  if (!real.startsWith(realBase + sep)) throw new HttpError(403, "Forbidden");
  const info = await stat(real).catch(() => null);
  if (!info?.isFile()) throw new HttpError(404, "Not found");
  return new Response(Bun.file(real));
}

/** JSON API routes for `Bun.serve({ routes })`, plus `/media/*`. */
export function createRoutes(
  db: Database,
  { mediaDir = process.env.MEDIA_DIR ?? DEFAULT_MEDIA_DIR }: RoutesOptions = {},
) {
  return {
    "/api/health": {
      GET: handle(() => Response.json({ ok: true })),
    },

    "/api/quotes": {
      GET: handle((req) => Response.json(searchQuotes(db, parseQuery(quotesQuery, req)))),
    },

    "/api/quotes/:id": {
      GET: handle((req: BunRequest<"/api/quotes/:id">) =>
        Response.json(quoteDetail(db, parse(id, req.params.id))),
      ),
      PATCH: handle(async (req: BunRequest<"/api/quotes/:id">) => {
        const quoteId = parse(id, req.params.id);
        const patch = await parseBody(quotePatch, req);
        const result = updateQuote(db, quoteId, patch);
        switch (result.status) {
          case "not_found":
            throw new HttpError(404, `Quote ${quoteId} not found`);
          case "empty_text":
            throw new HttpError(400, "text: must contain words");
          case "conflict":
            throw new HttpError(409, `Text duplicates quote ${result.conflictId}`, {
              conflictId: result.conflictId,
            });
        }
        return Response.json({ quote: result.quote });
      }),
    },

    "/api/quotes/:id/merge": {
      POST: handle(async (req: BunRequest<"/api/quotes/:id/merge">) => {
        const keepId = parse(id, req.params.id);
        const { dropId } = await parseBody(mergeBody, req);
        if (dropId === keepId) throw new HttpError(400, "Cannot merge a quote into itself");
        for (const qid of [keepId, dropId]) {
          if (!getQuote(db, qid)) throw new HttpError(404, `Quote ${qid} not found`);
        }
        mergeQuotes(db, keepId, dropId);
        return Response.json(quoteDetail(db, keepId));
      }),
    },

    "/api/highlights": {
      GET: handle((req) => Response.json(listHighlights(db, parseQuery(highlightsQuery, req)))),
    },

    "/api/books": {
      GET: handle((req) => Response.json({ items: listBooks(db, parseQuery(booksQuery, req)) })),
    },

    "/api/books/:id": {
      GET: handle((req: BunRequest<"/api/books/:id">) => {
        const bookId = parse(id, req.params.id);
        const detail = getBookDetail(db, bookId);
        if (!detail) throw new HttpError(404, `Book ${bookId} not found`);
        return Response.json({
          book: detail.book,
          entries: detail.entries.map((e) => ({
            ...e,
            postings: e.postings.map((p) => ({ ...p, mediaUrl: mediaUrl(p.mediaPath) })),
          })),
        });
      }),
    },

    "/api/review": {
      GET: handle(() =>
        Response.json({
          links: listReviewLinks(db).map(({ post: { mediaPath, ...post }, ...link }) => ({
            ...link,
            post: { ...post, mediaUrl: mediaUrl(mediaPath) },
          })),
          duplicates: findDuplicatePairs(db),
        }),
      ),
    },

    "/api/review/:postId/:quoteId": {
      POST: handle(async (req: BunRequest<"/api/review/:postId/:quoteId">) => {
        const postId = parse(id, req.params.postId);
        const quoteId = parse(id, req.params.quoteId);
        const { action } = await parseBody(reviewBody, req);
        if (!resolveLink(db, postId, quoteId, action)) {
          throw new HttpError(404, `No link between post ${postId} and quote ${quoteId}`);
        }
        return Response.json({ postId, quoteId, action });
      }),
    },

    "/api/stats": {
      GET: handle(() => Response.json(getStats(db))),
    },

    "/api/*": () => errorResponse(404, "Not found"),

    "/media/*": {
      GET: handle((req) => mediaFile(mediaDir, req)),
    },
  };
}
