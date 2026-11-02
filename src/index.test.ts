import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { createServer } from "./index";

describe("server", () => {
  let server: Server<undefined>;

  beforeAll(() => {
    server = createServer({ port: 0 });
  });

  afterAll(async () => {
    await server.stop(true);
  });

  test("GET /api/health returns { ok: true }", async () => {
    const res = await fetch(new URL("/api/health", server.url));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
