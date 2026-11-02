import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("isPidAlive: our own PID is alive, an unused one is not", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2 ** 22 + 12345)).toBe(false);
  });
});
