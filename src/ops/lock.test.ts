import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, isPidAlive, LockHeldError, withLock } from "./lock";

describe("lockfile", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qe-lock-"));
    path = join(dir, "nested", "sync.lock");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("acquire writes our PID; release removes the file", () => {
    const release = acquireLock(path, { pid: 4242 });
    expect(readFileSync(path, "utf8").trim()).toBe("4242");
    release();
    expect(existsSync(path)).toBe(false);
  });

  test("a lock held by a live PID is refused", () => {
    acquireLock(path, { pid: 111 });
    let err: unknown;
    try {
      acquireLock(path, { pid: 222, isAlive: (pid) => pid === 111 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LockHeldError);
    expect((err as LockHeldError).pid).toBe(111);
    expect(readFileSync(path, "utf8").trim()).toBe("111");
  });

  test("a stale lock (dead PID) is replaced", () => {
    acquireLock(path, { pid: 111 });
    acquireLock(path, { pid: 222, isAlive: () => false });
    expect(readFileSync(path, "utf8").trim()).toBe("222");
  });

  test("a lock with garbage contents is treated as stale", () => {
    acquireLock(path, { pid: 1 })();
    writeFileSync(path, "not a pid");
    acquireLock(path, { pid: 333, isAlive: () => true });
    expect(readFileSync(path, "utf8").trim()).toBe("333");
  });

  test("release does not remove a lock someone else now holds", () => {
    const release = acquireLock(path, { pid: 111 });
    writeFileSync(path, "999\n");
    release();
    expect(readFileSync(path, "utf8").trim()).toBe("999");
  });

  test("withLock removes the lock in a finally, even when the body throws", async () => {
    await expect(
      withLock(path, async () => {
        expect(existsSync(path)).toBe(true);
        throw new Error("body failed");
      }),
    ).rejects.toThrow("body failed");
    expect(existsSync(path)).toBe(false);

    expect(await withLock(path, async () => 7)).toBe(7);
    expect(existsSync(path)).toBe(false);
  });

  test("a lock older than maxAgeMs is stale even if its PID is alive (PID reused)", () => {
    acquireLock(path, { pid: 111 });
    const old = new Date(Date.now() - 5 * 60 * 60_000);
    utimesSync(path, old, old);
    acquireLock(path, { pid: 222, isAlive: () => true, maxAgeMs: 4 * 60 * 60_000 });
    expect(readFileSync(path, "utf8").trim()).toBe("222");
  });

  test("a fresh lock with a live PID is still refused when maxAgeMs is set", () => {
    acquireLock(path, { pid: 111 });
    expect(() =>
      acquireLock(path, { pid: 222, isAlive: () => true, maxAgeMs: 4 * 60 * 60_000 }),
    ).toThrow(LockHeldError);
  });

  test("the lock file never exists without a PID, and leaves no temp files", () => {
    const release = acquireLock(path, { pid: 4242 });
    expect(readdirSync(join(dir, "nested"))).toEqual(["sync.lock"]);
    release();
    expect(readdirSync(join(dir, "nested"))).toEqual([]);
  });

  test("a takeover in progress elsewhere makes us back off with LockHeldError", () => {
    acquireLock(path, { pid: 111 });
    // Another process is mid-takeover of the stale lock: it holds the takeover mutex.
    writeFileSync(`${path}.takeover`, "333\n");
    expect(() => acquireLock(path, { pid: 222, isAlive: () => false })).toThrow(LockHeldError);
    expect(readFileSync(path, "utf8").trim()).toBe("111");
  });

  test("a takeover mutex left by a crash is ignored once it is old", () => {
    acquireLock(path, { pid: 111 });
    writeFileSync(`${path}.takeover`, "333\n");
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(`${path}.takeover`, old, old);
    acquireLock(path, { pid: 222, isAlive: () => false });
    expect(readFileSync(path, "utf8").trim()).toBe("222");
    expect(existsSync(`${path}.takeover`)).toBe(false);
  });

  test("isPidAlive: our own PID is alive, an unused one is not", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2 ** 22 + 12345)).toBe(false);
  });
});
