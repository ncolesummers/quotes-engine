import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_LOCK_FILE = "sync.lock";

export class LockHeldError extends Error {
  override name = "LockHeldError";
  constructor(
    readonly path: string,
    readonly pid: number,
  ) {
    super(`Another sync is already running (pid ${pid}; lock ${path}).`);
  }
}

export interface LockOptions {
  /** PID written to the lock (default `process.pid`). */
  pid?: number;
  /** Whether the PID in an existing lock still runs (default `isPidAlive`). */
  isAlive?: (pid: number) => boolean;
}

/** `kill(pid, 0)` probe: ESRCH means gone; EPERM means it exists but belongs to someone else. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readPid(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Takes the lock at `path` by creating it exclusively (`O_EXCL`) with our PID. A lock left by a
 * process that no longer runs, or holding no valid PID, is removed and taken over. Throws
 * `LockHeldError` when a live process holds it. Returns a release function that removes the
 * lock only if it still holds our PID.
 */
export function acquireLock(
  path: string,
  { pid = process.pid, isAlive = isPidAlive }: LockOptions = {},
): () => void {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(path, `${pid}\n`, { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = readPid(path);
      // On the retry, another process took over the stale lock between our rm and create.
      if (holder !== null && (attempt > 0 || isAlive(holder))) {
        throw new LockHeldError(path, holder);
      }
      if (attempt > 0) throw err;
      rmSync(path, { force: true });
    }
  }
  return () => {
    if (readPid(path) === pid) rmSync(path, { force: true });
  };
}

/** Runs `fn` holding the lock at `path`, releasing it in a `finally`. */
export async function withLock<T>(
  path: string,
  fn: () => Promise<T>,
  options?: LockOptions,
): Promise<T> {
  const release = acquireLock(path, options);
  try {
    return await fn();
  } finally {
    release();
  }
}
