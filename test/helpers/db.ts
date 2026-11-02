import type { Database } from "bun:sqlite";
import { openDb } from "../../src/server/db/index";

/** In-memory SQLite DB with foreign keys on and all migrations applied. Never touches `data/`. */
export function createTestDb(): Database {
  return openDb(":memory:");
}
