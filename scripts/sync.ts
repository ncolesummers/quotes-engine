/**
 * Nightly sync (#18): Instagram → extract new posts → Apple Books, each step isolated.
 *
 *   bun run sync
 *
 * Each step runs its own script as a child process (`sync:instagram`, `extract:new`,
 * `import:books`), so a failure or crash in one never stops the next. Appends a JSON summary
 * to <DATA_DIR>/logs/sync-YYYY-MM-DD.json (UTC date) and exits 1 if any step failed. Holds
 * <DATA_DIR>/sync.lock for the whole run, so a manual run and the launchd run cannot overlap.
 * SIGTERM/SIGINT kill the running step (its whole process group) and release the lock.
 *
 * Env: DATA_DIR (default data; lock and logs only). The steps read their own settings —
 * IG_USER_ID, QUOTES_DB_PATH, MEDIA_DIR, OCR_DIR, EXTRACTIONS_DIR, CLAUDE_BIN, APPLE_BOOKS_DIR —
 * from the environment and .env. SYNC_NOTIFY=0 turns off the macOS notification on failure.
 */
import { join, resolve } from "node:path";
import { DEFAULT_LOCK_FILE } from "../src/ops/lock";
import { commandStep, type Notifier, runSyncMain } from "../src/ops/sync";

const repoRoot = resolve(import.meta.dir, "..");
const dataDir = resolve(repoRoot, process.env.DATA_DIR ?? "data");

const step = (name: string, script: string) =>
  commandStep(name, [process.execPath, join(repoRoot, "scripts", script)], { cwd: repoRoot });

const notify: Notifier | undefined =
  process.platform === "darwin" && process.env.SYNC_NOTIFY !== "0"
    ? (title, message) => {
        // Text goes in as argv, never spliced into the AppleScript source.
        Bun.spawnSync(
          [
            "osascript",
            "-e",
            "on run argv",
            "-e",
            "display notification (item 2 of argv) with title (item 1 of argv)",
            "-e",
            "end run",
            title,
            message,
          ],
          { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
        );
      }
    : undefined;

process.exitCode = await runSyncMain({
  lockPath: join(dataDir, DEFAULT_LOCK_FILE),
  steps: [
    step("sync:instagram", "sync-instagram.ts"),
    step("extract:new", "extract-new.ts"),
    step("import:books", "import-books.ts"),
  ],
  logDir: join(dataDir, "logs"),
  notify,
});
