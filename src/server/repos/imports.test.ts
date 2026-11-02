import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// Scripts (e.g. the nightly sync) import repos directly, in whatever order they like. A circular
// import between repos turns into a TDZ ReferenceError for whichever module is loaded first, which
// the test runner's shared module cache hides — so load each one first in a fresh process.
const dir = import.meta.dir;
const repos = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

describe("repos load in any order", () => {
  test.each(repos)("%s loads on its own", (file) => {
    const proc = Bun.spawnSync([
      process.execPath,
      "-e",
      `await import(${JSON.stringify(join(dir, file))})`,
    ]);
    expect(proc.stderr.toString()).toBe("");
    expect(proc.exitCode).toBe(0);
  });
});
