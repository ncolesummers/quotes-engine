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

  test("runs migrations with foreign keys off so a parent-table rebuild doesn't cascade", () => {
    db.run("PRAGMA foreign_keys = ON");
    writeFileSync(
      join(dir, "0001_a.sql"),
      `CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
       CREATE TABLE child (id INTEGER PRIMARY KEY,
         parent_id INTEGER NOT NULL REFERENCES parent (id) ON DELETE CASCADE);`,
    );
    migrate(db, dir);
    db.run("INSERT INTO parent (id, name) VALUES (1, 'p')");
    db.run("INSERT INTO child (id, parent_id) VALUES (1, 1)");
    writeFileSync(
      join(dir, "0002_rebuild.sql"),
      `CREATE TABLE parent_new (id INTEGER PRIMARY KEY, name TEXT);
       INSERT INTO parent_new (id, name) SELECT id, name FROM parent;
       DROP TABLE parent;
       ALTER TABLE parent_new RENAME TO parent;`,
    );

    expect(migrate(db, dir)).toEqual(["0002_rebuild"]);

    expect(db.query("SELECT id, parent_id FROM child").all()).toEqual([{ id: 1, parent_id: 1 }]);
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(
      1,
    );
  });

  test("rolls back a migration that leaves foreign key violations", () => {
    db.run("PRAGMA foreign_keys = ON");
    writeFileSync(
      join(dir, "0001_a.sql"),
      `CREATE TABLE parent (id INTEGER PRIMARY KEY);
       CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent (id));
       INSERT INTO child (id, parent_id) VALUES (1, 42);`,
    );

    expect(() => migrate(db, dir)).toThrow(/0001_a.*foreign key/i);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'child'").all()).toEqual([]);
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(
      1,
    );
  });

  test("a foreign key violation already in the database doesn't block later migrations", () => {
    writeFileSync(
      join(dir, "0001_a.sql"),
      `CREATE TABLE parent (id INTEGER PRIMARY KEY);
       CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent (id));`,
    );
    migrate(db, dir);
    db.run("PRAGMA foreign_keys = OFF");
    db.run("INSERT INTO child (id, parent_id) VALUES (1, 42)");
    db.run("PRAGMA foreign_keys = ON");

    writeFileSync(join(dir, "0002_b.sql"), "CREATE TABLE other (id INTEGER PRIMARY KEY);");
    expect(migrate(db, dir)).toEqual(["0002_b"]);

    writeFileSync(join(dir, "0003_c.sql"), "INSERT INTO child (id, parent_id) VALUES (2, 43);");
    expect(() => migrate(db, dir)).toThrow(/0003_c.*foreign key/i);
    expect(db.query("SELECT id FROM child ORDER BY id").all()).toEqual([{ id: 1 }]);
  });
});
