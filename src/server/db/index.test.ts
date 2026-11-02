import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../../../test/helpers/db";
import { loadMigrations, migrate, openDb } from "./index";
import { DEFAULT_MIGRATIONS_DIR } from "./migrate";

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
      expect(n).toBe(loadMigrations().length);
    } finally {
      db.close();
    }
  });

  test("sets busy_timeout to 5000ms", () => {
    const db = openDb(":memory:");
    try {
      expect(db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
    } finally {
      db.close();
    }
  });

  /** Starts a writer process holding a lock on `path`; resolves once it has the lock. */
  async function startWriter(path: string, mode: "immediate" | "exclusive", holdMs: number) {
    const helper = join(import.meta.dir, "../../../test/helpers/sqlite-writer.ts");
    const proc = Bun.spawn([process.execPath, helper, path, mode, String(holdMs)], {
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = proc.stdout.getReader();
    let out = "";
    while (!out.includes("locked")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`writer exited early: ${out}`);
      out += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    return proc;
  }

  test("two connections plus a concurrent writer do not throw SQLITE_BUSY", async () => {
    tmp = mkdtempSync(join(tmpdir(), "qe-db-"));
    const path = join(tmp, "busy.db");
    const a = openDb(path);
    const b = openDb(path);
    const writer = await startWriter(path, "immediate", 400);
    try {
      // Both writes have to wait for the other process's lock to be released.
      expect(() =>
        a.run("INSERT INTO books (title, normalized_key, source) VALUES ('A', 'a', 'manual')"),
      ).not.toThrow();
      expect(() =>
        b.run("INSERT INTO books (title, normalized_key, source) VALUES ('B', 'b', 'manual')"),
      ).not.toThrow();
      expect(a.query("SELECT COUNT(*) AS n FROM books").get()).toEqual({ n: 2 });
    } finally {
      expect(await writer.exited).toBe(0);
      a.close();
      b.close();
    }
  });

  test("busy_timeout is set before the WAL pragma, so opening a locked DB waits", async () => {
    tmp = mkdtempSync(join(tmpdir(), "qe-db-"));
    const path = join(tmp, "locked.db");
    const writer = await startWriter(path, "exclusive", 400);
    let db: Database | undefined;
    try {
      expect(() => {
        db = openDb(path);
      }).not.toThrow();
      expect(
        db?.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode,
      ).toBe("wal");
    } finally {
      db?.close();
      await writer.exited;
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

describe("0002 books migration", () => {
  let db: Database;
  let tmp: string | undefined;

  afterEach(() => {
    db.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  test("books.asset_id is nullable and normalized_key is unique", () => {
    db = createTestDb();
    db.run(
      "INSERT INTO books (title, author, normalized_key, source) VALUES ('A', 'B', 'a|b', 'caption')",
    );
    expect(() =>
      db.run("INSERT INTO books (title, normalized_key, source) VALUES ('A', 'a|b', 'manual')"),
    ).toThrow(/UNIQUE/i);
    expect(() =>
      db.run("INSERT INTO books (title, normalized_key, source) VALUES ('C', 'c', 'guess')"),
    ).toThrow(/CHECK/i);
  });

  test("quotes.book_id references books and is cleared when the book is deleted", () => {
    db = createTestDb();
    const bookId = db
      .query<{ id: number }, []>(
        "INSERT INTO books (title, normalized_key, source) VALUES ('T', 't', 'caption') RETURNING id",
      )
      .get()?.id;
    const quoteId = insertQuote(db, "Linked.");
    expect(() => db.run(`UPDATE quotes SET book_id = 999 WHERE id = ${quoteId}`)).toThrow(
      /FOREIGN KEY/i,
    );
    db.run(`UPDATE quotes SET book_id = ${bookId} WHERE id = ${quoteId}`);
    db.run(`DELETE FROM books WHERE id = ${bookId}`);
    expect(db.query(`SELECT book_id FROM quotes WHERE id = ${quoteId}`).get()).toEqual({
      book_id: null,
    });
  });

  test("upgrading a 0001 database keeps existing books and their highlights", () => {
    tmp = mkdtempSync(join(tmpdir(), "qe-mig-"));
    copyFileSync(join(DEFAULT_MIGRATIONS_DIR, "0001_init.sql"), join(tmp, "0001_init.sql"));
    db = new Database(":memory:", { strict: true });
    db.run("PRAGMA foreign_keys = ON");
    migrate(db, tmp);
    db.run(
      "INSERT INTO books (id, asset_id, title, author) VALUES (7, 'A1', 'Dune', 'Frank Herbert')",
    );
    db.run(
      "INSERT INTO highlights (annotation_uuid, book_id, text) VALUES ('u1', 7, 'Fear is the mind-killer.')",
    );

    migrate(db);

    expect(db.query("SELECT id, asset_id, title, author, source FROM books").all()).toEqual([
      { id: 7, asset_id: "A1", title: "Dune", author: "Frank Herbert", source: "apple_books" },
    ]);
    expect(db.query("SELECT book_id, text FROM highlights").all()).toEqual([
      { book_id: 7, text: "Fear is the mind-killer." },
    ]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() =>
      db.run("INSERT INTO highlights (annotation_uuid, book_id) VALUES ('u2', 999)"),
    ).toThrow(/FOREIGN KEY/i);
    expect(() => db.run("INSERT INTO books (asset_id, title) VALUES ('A1', 'Dupe')")).toThrow(
      /UNIQUE/i,
    );
  });
});
