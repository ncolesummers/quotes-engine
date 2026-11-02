import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Migration {
  version: number;
  /** File name without `.sql`, e.g. `0001_init`. */
  name: string;
  sql: string;
}

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

const MIGRATION_FILE = /^(\d{4})_[\w-]+\.sql$/;

/** Reads `NNNN_*.sql` files from `dir`, sorted by version. Throws on duplicate versions. */
export function loadMigrations(dir: string | URL = DEFAULT_MIGRATIONS_DIR): Migration[] {
  const path = dir instanceof URL ? fileURLToPath(dir) : dir;
  const migrations: Migration[] = [];
  for (const file of readdirSync(path)) {
    const match = MIGRATION_FILE.exec(file);
    if (!match?.[1]) continue;
    migrations.push({
      version: Number(match[1]),
      name: file.slice(0, -".sql".length),
      sql: readFileSync(join(path, file), "utf8"),
    });
  }
  migrations.sort((a, b) => a.version - b.version);
  for (let i = 1; i < migrations.length; i++) {
    const prev = migrations[i - 1];
    const cur = migrations[i];
    if (prev && cur && prev.version === cur.version) {
      throw new Error(`Duplicate migration version ${cur.version}: ${prev.name}, ${cur.name}`);
    }
  }
  return migrations;
}

/**
 * Applies pending migrations from `dir` in version order, each in its own transaction,
 * recording them in `schema_migrations`. Idempotent. Returns the names applied this run.
 */
export function migrate(db: Database, dir: string | URL = DEFAULT_MIGRATIONS_DIR): string[] {
  db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const done = new Set(
    db
      .query<{ version: number }, []>("SELECT version FROM schema_migrations")
      .all()
      .map((r) => r.version),
  );
  const record = db.query<void, [number, string, string]>(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
  );

  const applied: string[] = [];
  for (const m of loadMigrations(dir)) {
    if (done.has(m.version)) continue;
    try {
      db.transaction(() => {
        db.run(m.sql);
        record.run(m.version, m.name, new Date().toISOString());
      })();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Migration ${m.name} failed: ${reason}`, { cause: err });
    }
    applied.push(m.name);
  }
  return applied;
}
