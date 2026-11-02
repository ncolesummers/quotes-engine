import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, LockHeldError } from "./lock";

/** One isolated step of the nightly sync. Throwing (or rejecting) marks it failed. */
export interface SyncStep {
  name: string;
  /** Whatever it resolves with is stored as the step's `detail`. */
  run: () => unknown;
}

export interface StepSummary {
  name: string;
  ok: boolean;
  startedAt: string;
  durationMs: number;
  detail?: unknown;
  error?: string;
  /** For command steps: the exit code and the last lines of output. */
  exitCode?: number | null;
  output?: string[];
}

export interface SyncRunSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  ok: boolean;
  steps: StepSummary[];
}

export type Notifier = (title: string, message: string) => void | Promise<void>;

export interface RunSyncOptions {
  steps: SyncStep[];
  /** Clock (default `new Date()`). */
  now?: () => Date;
  /** Progress lines (default `console.log`). */
  log?: (message: string) => void;
  /** Directory for `sync-YYYY-MM-DD.json` (default `data/logs`). */
  logDir?: string;
  /** Called once when any step failed. Its errors are logged, never thrown. */
  notify?: Notifier;
}

export const DEFAULT_LOG_DIR = "data/logs";

/** Thrown by command steps; its exit code and output tail end up in the summary. */
export class CommandStepError extends Error {
  override name = "CommandStepError";
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly output: string[],
  ) {
    super(message);
  }
}

/** `<logDir>/sync-YYYY-MM-DD.json`, dated in UTC like every other timestamp we store. */
export function syncLogPath(logDir: string, at: Date): string {
  return join(logDir, `sync-${at.toISOString().slice(0, 10)}.json`);
}

/**
 * Appends `entry` to the JSON array in `path`. Writes a temp file and renames it over, so a crash
 * mid-write never leaves half a file. A corrupt file is moved aside to `<path>.<time>.corrupt`.
 */
function appendLogEntry(path: string, entry: SyncRunSummary, log: (m: string) => void): void {
  let entries: unknown[] = [];
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("not a JSON array");
      entries = parsed;
    } catch (err) {
      const aside = `${path}.${Date.now()}.corrupt`;
      renameSync(path, aside);
      log(`${path} was unreadable (${errorMessage(err)}); moved it to ${aside}`);
    }
  }
  entries.push(entry);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`);
  renameSync(tmp, path);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs `steps` in order. Each is isolated: a failure is recorded and the next step still runs.
 * Appends the run's summary to `<logDir>/sync-YYYY-MM-DD.json` and notifies on failure.
 */
export async function runSync({
  steps,
  now = () => new Date(),
  log = console.log,
  logDir = DEFAULT_LOG_DIR,
  notify,
}: RunSyncOptions): Promise<SyncRunSummary> {
  const started = now();
  const results: StepSummary[] = [];

  for (const step of steps) {
    const stepStart = now();
    log(`[sync] ${step.name}: starting`);
    let result: StepSummary;
    try {
      const detail = await step.run();
      result = { name: step.name, ok: true, startedAt: stepStart.toISOString(), durationMs: 0 };
      if (detail !== undefined) result.detail = detail;
    } catch (err) {
      result = {
        name: step.name,
        ok: false,
        startedAt: stepStart.toISOString(),
        durationMs: 0,
        error: errorMessage(err),
      };
      if (err instanceof CommandStepError) {
        result.exitCode = err.exitCode;
        result.output = err.output;
      }
    }
    result.durationMs = now().getTime() - stepStart.getTime();
    log(
      `[sync] ${step.name}: ${result.ok ? "ok" : `FAILED — ${result.error}`} (${(result.durationMs / 1000).toFixed(1)}s)`,
    );
    results.push(result);
  }

  const finished = now();
  const summary: SyncRunSummary = {
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    ok: results.every((r) => r.ok),
    steps: results,
  };

  const path = syncLogPath(logDir, started);
  let where = `See ${path}`;
  try {
    mkdirSync(logDir, { recursive: true });
    appendLogEntry(path, summary, log);
    log(`[sync] ${summary.ok ? "done" : "finished with failures"}; summary in ${path}`);
  } catch (err) {
    // Never let a log problem swallow the failure notification.
    where = `Could not write ${path}: ${errorMessage(err)}`;
    log(`[sync] ${where}`);
    log(JSON.stringify(summary));
  }

  if (!summary.ok && notify) {
    const failed = results.filter((r) => !r.ok).map((r) => r.name);
    try {
      await notify("quotes-engine sync failed", `Failed: ${failed.join(", ")}. ${where}`);
    } catch (err) {
      log(`[sync] notification failed: ${errorMessage(err)}`);
    }
  }
  return summary;
}

export interface CommandStepOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Where the child's output is forwarded as it arrives (default: our stdout/stderr). */
  write?: { stdout: (chunk: string) => void; stderr: (chunk: string) => void };
  /** Output lines kept for the summary (default 15). */
  tailLines?: number;
  /** Kills the child's process group after this long (default 60 minutes). */
  timeoutMs?: number;
  /** After the timeout's SIGTERM, SIGKILL the group if it is still running this long (default 10 s). */
  killGraceMs?: number;
}

/** Process groups of the command steps running now; `killActiveSteps` signals them. */
const activeGroups = new Set<number>();

function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH: the whole group is already gone.
  }
}

/** Signals every running command step's whole process group (children and grandchildren). */
export function killActiveSteps(signal: NodeJS.Signals = "SIGKILL"): void {
  for (const pgid of activeGroups) killGroup(pgid, signal);
}

export const DEFAULT_STEP_TIMEOUT_MS = 60 * 60_000;

/**
 * A step that runs `cmd` as a child process, forwarding its output and keeping the last lines.
 * A separate process isolates the step completely: the step scripts call `process.exit`, and a
 * crash or leak in one cannot take down the steps after it. Non-zero exit throws. The child gets
 * its own process group, so a timeout kills what it spawned too (`claude -p`, OCR); otherwise a
 * grandchild holding the output pipe would keep the step waiting forever.
 */
export function commandStep(
  name: string,
  cmd: string[],
  {
    cwd,
    env,
    write = {
      stdout: (c) => process.stdout.write(c),
      stderr: (c) => process.stderr.write(c),
    },
    tailLines = 15,
    timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
    killGraceMs = 10_000,
  }: CommandStepOptions,
): SyncStep {
  return {
    name,
    run: async () => {
      const proc = Bun.spawn(cmd, {
        cwd,
        env: env ?? process.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      });
      activeGroups.add(proc.pid);
      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(proc.pid, "SIGTERM");
        killTimer = setTimeout(() => killGroup(proc.pid, "SIGKILL"), killGraceMs);
      }, timeoutMs);

      const tail: string[] = [];
      const pump = async (stream: ReadableStream<Uint8Array>, out: (c: string) => void) => {
        const decoder = new TextDecoder();
        let partial = "";
        for await (const chunk of stream) {
          const text = decoder.decode(chunk, { stream: true });
          out(text);
          const lines = (partial + text).split("\n");
          partial = lines.pop() ?? "";
          tail.push(...lines.filter((l) => l.trim() !== ""));
          if (tail.length > tailLines) tail.splice(0, tail.length - tailLines);
        }
        if (partial.trim() !== "") tail.push(partial);
        if (tail.length > tailLines) tail.splice(0, tail.length - tailLines);
      };

      try {
        await Promise.all([pump(proc.stdout, write.stdout), pump(proc.stderr, write.stderr)]);
        const exitCode = await proc.exited;
        if (timedOut) {
          throw new CommandStepError(
            `${name} timed out after ${timeoutMs / 1000}s`,
            exitCode,
            tail,
          );
        }
        if (exitCode !== 0) {
          throw new CommandStepError(`${name} exited with code ${exitCode}`, exitCode, tail);
        }
        return { exitCode, output: tail };
      } finally {
        clearTimeout(timer);
        clearTimeout(killTimer);
        activeGroups.delete(proc.pid);
      }
    },
  };
}

/** Longest a sync can legitimately hold its lock: three steps at the default timeout, plus slack. */
export const DEFAULT_LOCK_MAX_AGE_MS = 3 * DEFAULT_STEP_TIMEOUT_MS + 60 * 60_000;

const SIGNAL_EXIT: Partial<Record<NodeJS.Signals, number>> = { SIGINT: 130, SIGTERM: 143 };

/**
 * The `bun run sync` entry point: holds the lock at `lockPath` for the whole run and resolves
 * with the process exit code (0 ok, 1 a step failed or another sync is running).
 *
 * On SIGTERM (launchd's bootout / `kickstart -k`) or SIGINT, it kills the running step's process
 * group, releases the lock and exits 143 / 130 right away, so no later step starts and no stale
 * lock is left behind.
 */
export async function runSyncMain({
  lockPath,
  maxLockAgeMs = DEFAULT_LOCK_MAX_AGE_MS,
  ...options
}: RunSyncOptions & { lockPath: string; maxLockAgeMs?: number }): Promise<number> {
  const log = options.log ?? console.log;
  let release: () => void;
  try {
    release = acquireLock(lockPath, { maxAgeMs: maxLockAgeMs });
  } catch (err) {
    if (!(err instanceof LockHeldError)) throw err;
    console.error(err.message);
    return 1;
  }

  const handlers = Object.entries(SIGNAL_EXIT).map(([signal, code]) => {
    const handler = () => {
      log(`[sync] ${signal}: stopping the running step and releasing the lock`);
      killActiveSteps("SIGKILL");
      release();
      process.exit(code);
    };
    process.on(signal, handler);
    return () => process.off(signal, handler);
  });
  try {
    const summary = await runSync({ ...options, log });
    return summary.ok ? 0 : 1;
  } finally {
    for (const off of handlers) off();
    release();
  }
}
