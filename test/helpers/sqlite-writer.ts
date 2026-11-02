/**
 * Test helper run as a separate process: holds a write lock on a SQLite file for a while.
 *
 *   bun test/helpers/sqlite-writer.ts <db path> <immediate|exclusive> <hold ms>
 *
 * Prints "locked" once the lock is held, then commits after <hold ms>.
 * `exclusive` uses a rollback journal and `BEGIN EXCLUSIVE`, which blocks even readers and
 * journal-mode changes; `immediate` takes a WAL write lock.
 */
import { Database } from "bun:sqlite";

const [path, mode, holdMs] = process.argv.slice(2);
if (!path || (mode !== "immediate" && mode !== "exclusive")) {
  console.error("usage: sqlite-writer.ts <db path> <immediate|exclusive> <hold ms>");
  process.exit(2);
}

const db = new Database(path, { create: true });
if (mode === "exclusive") db.run("PRAGMA journal_mode = DELETE");
db.run("CREATE TABLE IF NOT EXISTS writer_probe (n INTEGER)");
db.run(mode === "exclusive" ? "BEGIN EXCLUSIVE" : "BEGIN IMMEDIATE");
db.run("INSERT INTO writer_probe (n) VALUES (1)");
console.log("locked");
await Bun.sleep(Number(holdMs ?? 500));
db.run("COMMIT");
db.close();
