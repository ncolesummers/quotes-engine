import { expect, test } from "bun:test";

const html = await Bun.file(new URL("./index.html", import.meta.url)).text();

test("entry module script is not async, so it runs after #root is parsed", () => {
  const script = html.match(/<script[^>]*frontend\.tsx[^>]*>/)?.[0];
  expect(script).toBeDefined();
  expect(script).not.toMatch(/\basync\b/);
});
