import { serve } from "bun";
import index from "./web/index.html";

export interface ServerOptions {
  port?: number;
  development?: boolean;
}

export function createServer({
  port = Number(process.env.PORT ?? 3000),
  development = process.env.NODE_ENV !== "production",
}: ServerOptions = {}) {
  return serve({
    port,
    routes: {
      "/api/health": {
        GET() {
          return Response.json({ ok: true });
        },
      },
      "/api/*": () => Response.json({ error: "Not found" }, { status: 404 }),
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
