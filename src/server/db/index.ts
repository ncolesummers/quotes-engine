import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "./migrate";

export { loadMigrations, type Migration, migrate } from "./migrate";

export const DEFAULT_DB_PATH = "data/quotes.db";
/** How long a connection waits for another connection's lock before failing with SQLITE_BUSY. */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * Opens (creating if needed) the SQLite database at `path`, enables WAL and foreign keys,
 * and applies pending migrations. Pass `":memory:"` for an ephemeral DB.
 *
 * `busy_timeout` comes first: switching to WAL needs a lock, so while another process (the dev
 * server, the nightly sync) is writing or recovering, the WAL pragma itself would otherwise
 * fail at once with SQLITE_BUSY.
 */
export function openDb(path: string = process.env.QUOTES_DB_PATH ?? DEFAULT_DB_PATH): Database {
  const inMemory = path === ":memory:" || path === "";
  if (!inMemory) mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, { create: true, strict: true });
  try {
    db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
