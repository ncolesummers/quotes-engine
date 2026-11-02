import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMigrations, migrate } from "./migrate";

describe("loadMigrations", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qe-migrations-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns NNNN_*.sql files sorted by version, ignoring other files", () => {
    writeFileSync(join(dir, "0002_second.sql"), "SELECT 2;");
    writeFileSync(join(dir, "0001_first.sql"), "SELECT 1;");
    writeFileSync(join(dir, "README.md"), "not a migration");
    writeFileSync(join(dir, "notes.sql"), "SELECT 0;");

    const migrations = loadMigrations(dir);

    expect(migrations.map((m) => m.name)).toEqual(["0001_first", "0002_second"]);
    expect(migrations.map((m) => m.version)).toEqual([1, 2]);
    expect(migrations[0]?.sql).toBe("SELECT 1;");
  });

  test("throws on duplicate version numbers", () => {
    writeFileSync(join(dir, "0001_a.sql"), "SELECT 1;");
    writeFileSync(join(dir, "0001_b.sql"), "SELECT 1;");

    expect(() => loadMigrations(dir)).toThrow(/duplicate migration version 1/i);
  });

  test("defaults to the bundled migrations directory", () => {
    const names = loadMigrations().map((m) => m.name);
    expect(names[0]).toBe("0001_init");
  });
});

describe("migrate", () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qe-migrations-"));
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("applies pending migrations in order and records them", () => {
    writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE a (id INTEGER PRIMARY KEY);");
    writeFileSync(join(dir, "0002_b.sql"), "CREATE TABLE b (a_id INTEGER REFERENCES a(id));");

    const applied = migrate(db, dir);

    expect(applied).toEqual(["0001_a", "0002_b"]);
    const rows = db
      .query<{ version: number; name: string }, []>(
        "SELECT version, name FROM schema_migrations ORDER BY version",
      )
      .all();
    expect(rows).toEqual([
      { version: 1, name: "0001_a" },
      { version: 2, name: "0002_b" },
    ]);
  });

  test("running twice is a no-op", () => {
    writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE a (id INTEGER PRIMARY KEY);");

    migrate(db, dir);
    const second = migrate(db, dir);

    expect(second).toEqual([]);
    const count = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM schema_migrations").get();
    expect(count?.n).toBe(1);
  });

  test("applies only migrations added since the last run", () => {
    writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE a (id INTEGER PRIMARY KEY);");
    migrate(db, dir);
    writeFileSync(join(dir, "0002_b.sql"), "CREATE TABLE b (id INTEGER PRIMARY KEY);");

    expect(migrate(db, dir)).toEqual(["0002_b"]);
  });

  test("rolls back a failing migration and leaves earlier ones applied", () => {
    writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE a (id INTEGER PRIMARY KEY);");
    writeFileSync(
      join(dir, "0002_bad.sql"),
      "CREATE TABLE b (id INTEGER PRIMARY KEY);\nTHIS IS NOT SQL;",
    );

    expect(() => migrate(db, dir)).toThrow(/0002_bad/);

    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);
    expect(tables).toContain("a");
    expect(tables).not.toContain("b");
    const versions = db
      .query<{ version: number }, []>("SELECT version FROM schema_migrations")
      .all()
      .map((r) => r.version);
    expect(versions).toEqual([1]);
  });
});
