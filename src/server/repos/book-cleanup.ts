/**
 * Fixing book records by hand (#34): merging duplicates, editing title/author, deleting empty
 * books, and re-keying every book after a change to `bookKey`.
 */
import type { Database } from "bun:sqlite";
import { bookKey } from "../text/book-key";
import { type Book, type BookRef, getBook, requireBook } from "./books";

function bookIdWithKey(db: Database, key: string, exceptId: number): number | null {
  return (
    db
      .query<{ id: number }, { key: string; id: number }>(
        "SELECT id FROM books WHERE normalized_key = $key AND id != $id",
      )
      .get({ key, id: exceptId })?.id ?? null
  );
}

function addAlias(db: Database, kind: "asset" | "key", value: string, bookId: number): void {
  db.query(
    `INSERT INTO book_aliases (kind, value, book_id) VALUES ($kind, $value, $bookId)
     ON CONFLICT (kind, value) DO UPDATE SET book_id = excluded.book_id`,
  ).run({ kind, value, bookId });
}

/** An alias equal to a book's own key or asset id is redundant (the real one wins). */
function dropShadowedAliases(db: Database, book: Book): void {
  db.query(
    `DELETE FROM book_aliases
     WHERE (kind = 'key' AND value = $key) OR (kind = 'asset' AND value = $assetId)`,
  ).run({ key: book.normalizedKey, assetId: book.assetId });
}

/**
 * Merges book `dropId` into `keepId` in one transaction: its quotes, highlights and aliases
 * move to keep; keep's missing title, author and asset id are filled from drop (re-keying
 * keep, unless the new key belongs to a third book, in which case keep's own title and author
 * stay); then drop is deleted. Returns the kept book. Throws when either is missing or they're
 * the same book.
 *
 * Drop's key is kept as an alias of keep, so a caption naming drop's title resolves to keep.
 * When both are Apple Books records, keep's asset id stays in `books.asset_id` (it holds one)
 * and drop's is kept as an alias. The next `import:books` maps drop's asset back to keep
 * through that alias, or failing that through its key when drop's title and author normalize
 * to keep's (e.g. "&" vs "and"), so the merge isn't undone by a new duplicate.
 */
export function mergeBooks(db: Database, keepId: number, dropId: number): Book {
  if (keepId === dropId) throw new Error("Cannot merge a book into itself");
  return db.transaction((): Book => {
    const keep = requireBook(db, keepId);
    const drop = requireBook(db, dropId);
    const binds = { keepId, dropId };

    db.query("UPDATE quotes SET book_id = $keepId WHERE book_id = $dropId").run(binds);
    db.query("UPDATE highlights SET book_id = $keepId WHERE book_id = $dropId").run(binds);
    db.query("UPDATE book_aliases SET book_id = $keepId WHERE book_id = $dropId").run(binds);
    if (drop.normalizedKey) addAlias(db, "key", drop.normalizedKey, keepId);
    if (drop.assetId && keep.assetId) addAlias(db, "asset", drop.assetId, keepId);

    // Deleting first frees drop's unique key and asset id for keep.
    db.query("DELETE FROM books WHERE id = $dropId").run({ dropId });

    let title = keep.title ?? drop.title;
    let author = keep.author ?? drop.author;
    let key = bookKey(title, author) ?? keep.normalizedKey;
    if (key && key !== keep.normalizedKey && bookIdWithKey(db, key, keepId) !== null) {
      ({ title, author } = keep);
      key = keep.normalizedKey;
    }
    db.query(
      `UPDATE books SET title = $title, author = $author, normalized_key = $key,
         asset_id = $assetId
       WHERE id = $keepId`,
    ).run({ keepId, title, author, key, assetId: keep.assetId ?? drop.assetId });

    const merged = requireBook(db, keepId);
    dropShadowedAliases(db, merged);
    return merged;
  })();
}

export interface BookPatch {
  title?: string;
  /** null or blank clears the author. */
  author?: string | null;
}

export type UpdateBookResult =
  | { status: "ok"; book: Book }
  | { status: "not_found" }
  | { status: "empty_title" }
  /** Another book already has the resulting title and author. */
  | { status: "conflict"; conflictId: number };

/** Edits a book's title and/or author and re-keys it. Quotes keep their own source titles. */
export function updateBook(db: Database, id: number, patch: BookPatch): UpdateBookResult {
  return db.transaction((): UpdateBookResult => {
    const current = getBook(db, id);
    if (!current) return { status: "not_found" };
    const title = patch.title === undefined ? current.title : patch.title.trim();
    const author = patch.author === undefined ? current.author : patch.author?.trim() || null;
    const key = bookKey(title, author);
    if (!key || !title) return { status: "empty_title" };
    const conflictId = bookIdWithKey(db, key, id);
    if (conflictId !== null) return { status: "conflict", conflictId };

    db.query(
      "UPDATE books SET title = $title, author = $author, normalized_key = $key WHERE id = $id",
    ).run({ id, title, author, key });
    const book = requireBook(db, id);
    // Even another book's alias: a real key wins, and an alias it shadows is dead weight.
    dropShadowedAliases(db, book);
    return { status: "ok", book };
  })();
}

export type DeleteBookResult = "deleted" | "not_found" | "not_empty";

/** Deletes a book, only if no quote or highlight refers to it. */
export function deleteBook(db: Database, id: number): DeleteBookResult {
  return db.transaction((): DeleteBookResult => {
    if (!getBook(db, id)) return "not_found";
    const used = db
      .query(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM quotes WHERE book_id = $id)
           OR EXISTS (SELECT 1 FROM highlights WHERE book_id = $id)`,
      )
      .get({ id });
    if (used) return "not_empty";
    db.query("DELETE FROM books WHERE id = $id").run({ id });
    return "deleted";
  })();
}

export interface RekeyCollision {
  /** The key the books would share. */
  key: string;
  /** Lowest id first. */
  books: BookRef[];
}

export interface RekeySummary {
  /** Books given a new key. */
  rekeyed: number;
  /** Books whose key was already current. */
  unchanged: number;
  /** Books whose recomputed keys clash; they keep their current keys for a manual merge. */
  collisions: RekeyCollision[];
}

/**
 * Recomputes every book's `normalized_key` with the current `bookKey` (e.g. after "&" began
 * folding into "and"). Books whose new keys clash are reported and left alone, never merged.
 * With `dryRun`, reports without writing. Idempotent. Unkeyed books are keyed too. Aliases
 * aren't re-keyed.
 */
export function rekeyBooks(db: Database, { dryRun = false } = {}): RekeySummary {
  return db.transaction((): RekeySummary => {
    const rows = db
      .query<{ id: number; title: string | null; author: string | null; key: string | null }, []>(
        "SELECT id, title, author, normalized_key AS key FROM books ORDER BY id",
      )
      .all();
    const byKey = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = bookKey(row.title, row.author);
      if (!key) continue;
      const group = byKey.get(key) ?? [];
      group.push(row);
      byKey.set(key, group);
    }

    const summary: RekeySummary = { rekeyed: 0, unchanged: 0, collisions: [] };
    const moves: { id: number; key: string }[] = [];
    for (const [key, group] of byKey) {
      if (group.length > 1) {
        summary.collisions.push({
          key,
          books: group.map(({ id, title, author }) => ({ id, title, author })),
        });
        continue;
      }
      const [row] = group;
      if (!row) continue;
      if (row.key === key) summary.unchanged++;
      else moves.push({ id: row.id, key });
    }
    // A colliding book may still hold the key another row wants; leave that row unchanged.
    const held = new Set(
      summary.collisions.flatMap((c) => c.books.map((b) => rows.find((r) => r.id === b.id)?.key)),
    );
    const applicable = moves.filter((m) => !held.has(m.key));
    summary.rekeyed = applicable.length;
    summary.unchanged += moves.length - applicable.length;

    if (!dryRun) {
      // Clear first so keys can swap between rows without tripping the UNIQUE constraint.
      const clear = db.query("UPDATE books SET normalized_key = NULL WHERE id = $id");
      const set = db.query("UPDATE books SET normalized_key = $key WHERE id = $id");
      for (const m of applicable) clear.run({ id: m.id });
      for (const m of applicable) set.run(m);
    }
    return summary;
  })();
}
