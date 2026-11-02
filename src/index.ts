import type { Database } from "bun:sqlite";
import { serve } from "bun";
import { createRoutes } from "./server/api";
import { openDb } from "./server/db/index";
import index from "./web/index.html";

export interface ServerOptions {
  port?: number;
  /** Defaults to 127.0.0.1 so the local-only app isn't exposed on the network. */
  hostname?: string;
  development?: boolean;
  /** Defaults to `openDb()` (`QUOTES_DB_PATH` or `data/quotes.db`). */
  db?: Database;
  /** Directory served at `/media/*`. Defaults to `MEDIA_DIR` or `data/media`. */
  mediaDir?: string;
}

export function createServer({
  port = Number(process.env.PORT ?? 3000),
  hostname = process.env.HOST ?? "127.0.0.1",
  development = process.env.NODE_ENV !== "production",
  db = openDb(),
  mediaDir,
}: ServerOptions = {}) {
  return serve({
    port,
    hostname,
    routes: {
      ...createRoutes(db, { mediaDir }),
      // SPA: every other path serves the React app.
      "/*": index,
    },
    development: development && { hmr: true, console: true },
  });
}

if (import.meta.main) {
  const server = createServer();
  console.log(`quotes-engine listening on ${server.url}`);
}
