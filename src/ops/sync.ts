import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

/** Appends `entry` to the JSON array in `path`; a corrupt file is moved to `<path>.corrupt`. */
function appendLogEntry(path: string, entry: SyncRunSummary, log: (m: string) => void): void {
  let entries: unknown[] = [];
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("not a JSON array");
      entries = parsed;
    } catch (err) {
      renameSync(path, `${path}.corrupt`);
      log(`${path} was unreadable (${errorMessage(err)}); moved it to ${path}.corrupt`);
    }
  }
  entries.push(entry);
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`);
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

  mkdirSync(logDir, { recursive: true });
  const path = syncLogPath(logDir, started);
  appendLogEntry(path, summary, log);
  log(`[sync] ${summary.ok ? "done" : "finished with failures"}; summary in ${path}`);

  if (!summary.ok && notify) {
    const failed = results.filter((r) => !r.ok).map((r) => r.name);
    try {
      await notify("quotes-engine sync failed", `Failed: ${failed.join(", ")}. See ${path}`);
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
  /** Kills the child after this long (default 60 minutes). */
  timeoutMs?: number;
}

export const DEFAULT_STEP_TIMEOUT_MS = 60 * 60_000;

/**
 * A step that runs `cmd` as a child process, forwarding its output and keeping the last lines.
 * A separate process isolates the step completely: the step scripts call `process.exit`, and a
 * crash or leak in one cannot take down the steps after it. Non-zero exit throws.
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
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
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
      }
    },
  };
}
