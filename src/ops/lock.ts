import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  /**
   * A lock older than this is stale even if its PID is alive: after a crash and a reboot the
   * PID may belong to an unrelated process. Set it above the longest possible run.
   */
  maxAgeMs?: number;
}

/** A takeover mutex older than this was left by a crash mid-takeover (which takes microseconds). */
const TAKEOVER_STALE_MS = 60_000;

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

function ageMs(path: string): number | null {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

const isErrno = (err: unknown, code: string) => (err as NodeJS.ErrnoException).code === code;

/** Hard-links the PID-bearing `tmp` to `path`: atomic, and the lock is never seen empty. */
function tryLink(tmp: string, path: string): boolean {
  try {
    linkSync(tmp, path);
    return true;
  } catch (err) {
    if (isErrno(err, "EEXIST")) return false;
    throw err;
  }
}

/**
 * Takes the lock at `path` atomically with our PID. A lock whose process no longer runs, that
 * holds no valid PID, or that is older than `maxAgeMs`, is taken over. Takeovers are serialized
 * by a `<path>.takeover` mutex, so two processes that both find a stale lock cannot both win.
 * Throws `LockHeldError` when someone else holds (or is taking over) the lock. Returns a release
 * function that removes the lock only if it still holds our PID.
 */
export function acquireLock(
  path: string,
  { pid = process.pid, isAlive = isPidAlive, maxAgeMs }: LockOptions = {},
): () => void {
  mkdirSync(dirname(path), { recursive: true });
  const isStale = (holder: number | null) => {
    if (holder === null || !isAlive(holder)) return true;
    const age = ageMs(path);
    return maxAgeMs !== undefined && age !== null && age > maxAgeMs;
  };

  const tmp = `${path}.${pid}.${process.hrtime.bigint()}.tmp`;
  writeFileSync(tmp, `${pid}\n`, { flag: "wx" });
  try {
    if (tryLink(tmp, path)) return releaser(path, pid);
    let holder = readPid(path);
    if (!isStale(holder)) throw new LockHeldError(path, holder ?? 0);

    const mutex = `${path}.takeover`;
    try {
      writeFileSync(mutex, `${pid}\n`, { flag: "wx" });
    } catch (err) {
      if (!isErrno(err, "EEXIST")) throw err;
      const mutexAge = ageMs(mutex);
      if (mutexAge === null || mutexAge <= TAKEOVER_STALE_MS) {
        throw new LockHeldError(path, readPid(mutex) ?? holder ?? 0);
      }
      rmSync(mutex, { force: true });
      writeFileSync(mutex, `${pid}\n`, { flag: "wx" });
    }
    try {
      // Re-check under the mutex: someone may have taken the lock since we looked.
      holder = readPid(path);
      if (existsSync(path) && !isStale(holder)) throw new LockHeldError(path, holder ?? 0);
      rmSync(path, { force: true });
      if (!tryLink(tmp, path)) throw new LockHeldError(path, readPid(path) ?? 0);
      return releaser(path, pid);
    } finally {
      rmSync(mutex, { force: true });
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

function releaser(path: string, pid: number): () => void {
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
