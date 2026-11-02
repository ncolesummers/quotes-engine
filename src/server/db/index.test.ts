import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../../../test/helpers/db";
import { openDb } from "./index";

const EXPECTED_TABLES = [
  "books",
  "highlights",
  "metric_snapshots",
  "post_quotes",
  "posts",
  "quotes",
  "quotes_fts",
  "schema_migrations",
];

function tableNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table') ORDER BY name",
    )
    .all()
    .map((r) => r.name);
}

function insertQuote(db: Database, text: string, author = "Anon"): number {
  const row = db
    .query<{ id: number }, [string, string, string]>(
      `INSERT INTO quotes (text, normalized_text, author, created_at, updated_at)
       VALUES (?1, ?2, ?3, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
       RETURNING id`,
    )
    .get(text, text.toLowerCase(), author);
  if (!row) throw new Error("insert failed");
  return row.id;
}

function ftsMatch(db: Database, query: string): number[] {
  return db
    .query<{ rowid: number }, [string]>(
      "SELECT rowid FROM quotes_fts WHERE quotes_fts MATCH ?1 ORDER BY rowid",
    )
    .all(query)
    .map((r) => r.rowid);
}

describe("openDb", () => {
  let tmp: string | undefined;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  test("creates the parent directory, enables WAL + foreign keys, and migrates", () => {
    tmp = mkdtempSync(join(tmpdir(), "qe-db-"));
    const path = join(tmp, "nested", "dir", "quotes.db");

    const db = openDb(path);
    try {
      expect(existsSync(path)).toBe(true);
      expect(
        db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode,
      ).toBe("wal");
      expect(
        db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys,
      ).toBe(1);
      expect(tableNames(db)).toEqual(expect.arrayContaining(EXPECTED_TABLES));
    } finally {
      db.close();
    }
  });

  test("reopening an existing database does not re-apply migrations", () => {
    tmp = mkdtempSync(join(tmpdir(), "qe-db-"));
    const path = join(tmp, "quotes.db");

    openDb(path).close();
    const db = openDb(path);
    try {
      const n = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM schema_migrations").get()?.n;
      expect(n).toBe(1);
    } finally {
      db.close();
    }
  });

  test("uses QUOTES_DB_PATH when no path is given", () => {
    tmp = mkdtempSync(join(tmpdir(), "qe-db-"));
    const path = join(tmp, "env.db");
    const prev = process.env.QUOTES_DB_PATH;
    process.env.QUOTES_DB_PATH = path;
    try {
      openDb().close();
      expect(existsSync(path)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.QUOTES_DB_PATH;
      else process.env.QUOTES_DB_PATH = prev;
    }
  });
});

describe("initial schema", () => {
  let db: Database;

  afterEach(() => {
    db.close();
  });

  test("createTestDb returns an in-memory DB with all expected tables", () => {
    db = createTestDb();
    expect(db.filename).toBe(":memory:");
    expect(tableNames(db)).toEqual(expect.arrayContaining(EXPECTED_TABLES));
  });

  test("enforces foreign keys: post_quotes with a missing post throws", () => {
    db = createTestDb();
    const quoteId = insertQuote(db, "Be here now.");

    expect(() =>
      db
        .query(
          "INSERT INTO post_quotes (post_id, quote_id, method, status) VALUES (999, ?1, 'caption', 'confirmed')",
        )
        .run(quoteId),
    ).toThrow(/FOREIGN KEY/i);
  });

  test("post_quotes CHECK constraints reject unknown method/status", () => {
    db = createTestDb();
    const quoteId = insertQuote(db, "Check me.");
    db.query(
      "INSERT INTO posts (id, ig_media_id, posted_at) VALUES (1, 'ig1', '2026-01-01T00:00:00.000Z')",
    ).run();

    expect(() =>
      db
        .query(
          "INSERT INTO post_quotes (post_id, quote_id, method, status) VALUES (1, ?1, 'guess', 'confirmed')",
        )
        .run(quoteId),
    ).toThrow(/CHECK/i);
    expect(() =>
      db
        .query(
          "INSERT INTO post_quotes (post_id, quote_id, method, status) VALUES (1, ?1, 'caption', 'maybe')",
        )
        .run(quoteId),
    ).toThrow(/CHECK/i);
  });

  test("quotes.normalized_text is unique", () => {
    db = createTestDb();
    insertQuote(db, "Same");
    expect(() => insertQuote(db, "SAME")).toThrow(/UNIQUE/i);
  });

  test("FTS: inserted quotes are findable via MATCH", () => {
    db = createTestDb();
    const id = insertQuote(db, "The obstacle is the way.", "Marcus Aurelius");
    insertQuote(db, "Something unrelated.");

    expect(ftsMatch(db, "obstacle")).toEqual([id]);
    expect(ftsMatch(db, "author:aurelius")).toEqual([id]);
  });

  test("FTS: updated quotes are re-indexed", () => {
    db = createTestDb();
    const id = insertQuote(db, "Old wording here.");

    db.query("UPDATE quotes SET text = 'Fresh phrasing now.' WHERE id = ?1").run(id);

    expect(ftsMatch(db, "fresh")).toEqual([id]);
    expect(ftsMatch(db, "wording")).toEqual([]);
  });

  test("FTS: deleted quotes are removed from the index", () => {
    db = createTestDb();
    const id = insertQuote(db, "Ephemeral words.");

    db.query("DELETE FROM quotes WHERE id = ?1").run(id);

    expect(ftsMatch(db, "ephemeral")).toEqual([]);
  });

  test("indexes exist on foreign keys and posts.posted_at", () => {
    db = createTestDb();
    const indexed = (table: string) =>
      db
        .query<{ name: string }, []>(`PRAGMA index_list(${table})`)
        .all()
        .flatMap((idx) =>
          db
            .query<{ name: string }, []>(`PRAGMA index_info(${idx.name})`)
            .all()
            .map((c) => c.name),
        );

    expect(indexed("posts")).toContain("posted_at");
    expect(indexed("post_quotes")).toContain("quote_id");
    expect(indexed("metric_snapshots")).toContain("post_id");
    expect(indexed("highlights")).toEqual(expect.arrayContaining(["book_id", "quote_id"]));
  });
});
