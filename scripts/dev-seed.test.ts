import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { isSafeSeedPath } from "./dev-seed";

const repo = resolve(import.meta.dir, "..");
const dataDir = resolve(repo, "data");

describe("isSafeSeedPath", () => {
  test.each([
    ["data/quotes.db"],
    ["./data/quotes.db"],
    ["data/../data/quotes.db"],
    [resolve(dataDir, "quotes.db")],
    [resolve(dataDir, "nested/other.db")],
  ])("refuses %s (inside data/)", (path) => {
    expect(isSafeSeedPath(path, { cwd: repo, dataDir })).toBe(false);
  });

  test("refuses a missing path", () => {
    expect(isSafeSeedPath(undefined, { cwd: repo, dataDir })).toBe(false);
    expect(isSafeSeedPath("", { cwd: repo, dataDir })).toBe(false);
  });

  test.each([["/tmp/quotes-dev.db"], ["scratch/dev.db"], ["data-dev.db"]])("allows %s", (path) => {
    expect(isSafeSeedPath(path, { cwd: repo, dataDir })).toBe(true);
  });
});
