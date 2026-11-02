import type { Database } from "bun:sqlite";
import { type Post, recordMetrics, upsertPost } from "../../src/server/repos/posts";
import {
  getQuote,
  type LinkMethod,
  type LinkStatus,
  linkPostQuote,
  type Quote,
} from "../../src/server/repos/quotes";
import { normalizeQuote } from "../../src/server/text/normalize";

export interface SeedQuote {
  text: string;
  author?: string | null;
  sourceTitle?: string | null;
  notes?: string | null;
}

export interface SeedPost {
  igMediaId?: string;
  permalink?: string | null;
  caption?: string | null;
  mediaPath?: string | null;
  postedAt?: string | null;
  likes?: number | null;
  comments?: number | null;
}

export interface SeedLink {
  method?: LinkMethod;
  confidence?: number | null;
  status?: LinkStatus;
}

export interface SeedBook {
  assetId?: string;
  title?: string | null;
  author?: string | null;
}

export interface SeedHighlight {
  bookId: number;
  text?: string | null;
  note?: string | null;
  location?: string | null;
  createdAt?: string | null;
  quoteId?: number | null;
  annotationUuid?: string;
}

export interface Book {
  id: number;
  assetId: string;
  title: string | null;
  author: string | null;
}

export interface Highlight {
  id: number;
  annotationUuid: string;
  bookId: number;
  text: string | null;
  note: string | null;
  location: string | null;
  createdAt: string | null;
  quoteId: number | null;
}

export interface Seeder {
  /** Insert a quote verbatim (no fuzzy dedup), so tests can create near-duplicates. */
  quote(input: SeedQuote): Quote;
  /** Insert a post; `likes`/`comments` are recorded as a metrics snapshot at `postedAt`. */
  post(input?: SeedPost): Post;
  /** Link a post to a quote. Defaults: method "caption", confidence 1, status "confirmed". */
  link(postId: number, quoteId: number, options?: SeedLink): void;
  /** Shorthand: create a post (as `post`) and link it to `quoteId`. */
  posting(quoteId: number, post?: SeedPost, link?: SeedLink): Post;
  book(input?: SeedBook): Book;
  highlight(input: SeedHighlight): Highlight;
}

/**
 * Fixture builder over a test DB (see `createTestDb`). Generated ids (`igMediaId`, `assetId`,
 * `annotationUuid`) are sequential and unique per seeder.
 */
export function seed(db: Database): Seeder {
  let seq = 0;
  const next = () => ++seq;

  const self: Seeder = {
    quote({ text, author = null, sourceTitle = null, notes = null }) {
      const row = db
        .query<{ id: number }, Record<string, string | null>>(
          `INSERT INTO quotes (text, normalized_text, author, source_title, notes)
           VALUES ($text, $normalized, $author, $sourceTitle, $notes) RETURNING id`,
        )
        .get({ text, normalized: normalizeQuote(text), author, sourceTitle, notes });
      const quote = row && getQuote(db, row.id);
      if (!quote) throw new Error("seed.quote: insert failed");
      return quote;
    },

    post(input = {}) {
      const postedAt = input.postedAt === undefined ? "2026-01-01T00:00:00.000Z" : input.postedAt;
      const post = upsertPost(db, {
        igMediaId: input.igMediaId ?? `ig-${next()}`,
        permalink: input.permalink ?? null,
        caption: input.caption ?? null,
        mediaPath: input.mediaPath ?? null,
        postedAt,
      });
      if (input.likes !== undefined || input.comments !== undefined) {
        recordMetrics(
          db,
          post.id,
          input.likes ?? null,
          input.comments ?? null,
          postedAt ?? "2026-01-01T00:00:00.000Z",
        );
        return { ...post, likeCount: input.likes ?? null, commentsCount: input.comments ?? null };
      }
      return post;
    },

    link(postId, quoteId, { method = "caption", confidence = 1, status = "confirmed" } = {}) {
      linkPostQuote(db, postId, quoteId, { method, confidence, status });
    },

    posting(quoteId, post, link) {
      const p = self.post(post);
      self.link(p.id, quoteId, link);
      return p;
    },

    book({ assetId, title = null, author = null } = {}) {
      const book = db
        .query<Book, Record<string, string | null>>(
          `INSERT INTO books (asset_id, title, author) VALUES ($assetId, $title, $author)
           RETURNING id, asset_id AS assetId, title, author`,
        )
        .get({ assetId: assetId ?? `asset-${next()}`, title, author });
      if (!book) throw new Error("seed.book: insert failed");
      return book;
    },

    highlight({
      bookId,
      text = null,
      note = null,
      location = null,
      createdAt = null,
      quoteId = null,
      annotationUuid,
    }) {
      const highlight = db
        .query<Highlight, Record<string, string | number | null>>(
          `INSERT INTO highlights (annotation_uuid, book_id, text, note, location, created_at, quote_id)
           VALUES ($uuid, $bookId, $text, $note, $location, $createdAt, $quoteId)
           RETURNING id, annotation_uuid AS annotationUuid, book_id AS bookId, text, note,
             location, created_at AS createdAt, quote_id AS quoteId`,
        )
        .get({
          uuid: annotationUuid ?? `uuid-${next()}`,
          bookId,
          text,
          note,
          location,
          createdAt,
          quoteId,
        });
      if (!highlight) throw new Error("seed.highlight: insert failed");
      return highlight;
    },
  };
  return self;
}
