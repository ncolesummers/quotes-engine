import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "./migrate";

export { loadMigrations, type Migration, migrate } from "./migrate";

export const DEFAULT_DB_PATH = "data/quotes.db";

/**
 * Opens (creating if needed) the SQLite database at `path`, enables WAL and foreign keys,
 * and applies pending migrations. Pass `":memory:"` for an ephemeral DB.
 */
export function openDb(path: string = process.env.QUOTES_DB_PATH ?? DEFAULT_DB_PATH): Database {
  const inMemory = path === ":memory:" || path === "";
  if (!inMemory) mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, { create: true, strict: true });
  try {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
