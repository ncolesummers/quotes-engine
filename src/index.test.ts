import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { createTestDb } from "../test/helpers/db";
import { seed } from "../test/helpers/seed";
import { createServer } from "./index";

describe("server", () => {
  let server: Server<undefined>;

  beforeAll(() => {
    const db = createTestDb();
    seed(db).quote({ text: "wired through createServer" });
    server = createServer({ port: 0, db });
  });

  afterAll(async () => {
    await server.stop(true);
  });

  test("binds to localhost only by default", () => {
    expect(server.hostname).toBe("127.0.0.1");
  });

  test("GET /api/health returns { ok: true }", async () => {
    const res = await fetch(new URL("/api/health", server.url));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("serves the API routes against the injected db", async () => {
    const res = await fetch(new URL("/api/quotes", server.url));
    expect(res.status).toBe(200);
    expect((await res.json()).total).toBe(1);
  });

  test("unknown /api paths return JSON 404, not the SPA", async () => {
    const res = await fetch(new URL("/api/nope", server.url));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});
