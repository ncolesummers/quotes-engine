import type { Classifier, ClassifyOutcome, ClassifyRequest } from "./incremental";

/** Classification only needs line refs and names; Haiku is enough and cheapest. */
export const CLASSIFIER_MODEL = "haiku";
/** Per batch. A 20-post batch takes well under a minute. */
export const DEFAULT_CLASSIFY_TIMEOUT_MS = 5 * 60_000;

/**
 * Arguments for one headless `claude -p` classification run: Haiku, only the Read and Write tools
 * (both pre-approved, so no prompt can block a run without a TTY), JSON output for cost and
 * errors, no MCP servers, no saved session.
 */
export function claudeClassifyArgs({ prompt, addDirs }: ClassifyRequest): string[] {
  return [
    "-p",
    prompt,
    "--model",
    CLASSIFIER_MODEL,
    "--tools",
    "Read,Write",
    "--allowedTools",
    "Read,Write",
    "--permission-mode",
    "acceptEdits",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--strict-mcp-config",
    ...addDirs.flatMap((dir) => ["--add-dir", dir]),
  ];
}

export interface ClaudeResult {
  isError: boolean;
  result?: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
}

/** The fields we use from `claude -p --output-format json`, or null if stdout isn't that. */
export function parseClaudeResult(stdout: string): ClaudeResult | null {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const o = json as Record<string, unknown>;
  if (o.type !== "result") return null;
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const out: ClaudeResult = { isError: o.is_error === true };
  if (typeof o.result === "string") out.result = o.result;
  if (num(o.total_cost_usd) !== undefined) out.costUsd = num(o.total_cost_usd);
  if (num(o.duration_ms) !== undefined) out.durationMs = num(o.duration_ms);
  if (num(o.num_turns) !== undefined) out.numTurns = num(o.num_turns);
  return out;
}

export interface ClaudeClassifierOptions {
  /** The Claude Code CLI (`claude` on PATH by default). */
  bin?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

/**
 * A `Classifier` that spawns `claude -p` once per batch in `req.cwd`, with stdin closed. A run
 * longer than `timeoutMs` is killed and reported as timed out. Never rejects.
 */
export function createClaudeClassifier({
  bin = "claude",
  timeoutMs = DEFAULT_CLASSIFY_TIMEOUT_MS,
  env = process.env,
}: ClaudeClassifierOptions = {}): Classifier {
  return async (req) => {
    let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
    try {
      proc = Bun.spawn([bin, ...claudeClassifyArgs(req)], {
        cwd: req.cwd,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      return {
        exitCode: null,
        timedOut: false,
        stdout: "",
        stderr: `could not start ${bin}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    // Resolve as soon as the timer fires: a stuck grandchild could hold the pipes open past kill.
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve("timeout");
      }, timeoutMs);
    });
    const stdoutP = new Response(proc.stdout).text();
    const stderrP = new Response(proc.stderr).text();
    try {
      const done = await Promise.race([Promise.all([stdoutP, stderrP, proc.exited]), timeout]);
      if (done === "timeout") {
        return {
          exitCode: null,
          timedOut: true,
          stdout: "",
          stderr: `${bin} timed out after ${timeoutMs}ms`,
        };
      }
      const [stdout, stderr, exitCode] = done;
      const parsed = parseClaudeResult(stdout.trim());
      const outcome: ClassifyOutcome = { exitCode, timedOut: false, stdout, stderr };
      if (parsed) {
        outcome.isError = parsed.isError;
        if (parsed.result !== undefined) outcome.result = parsed.result;
        if (parsed.costUsd !== undefined) outcome.costUsd = parsed.costUsd;
        if (parsed.durationMs !== undefined) outcome.durationMs = parsed.durationMs;
      }
      return outcome;
    } finally {
      clearTimeout(timer);
    }
  };
}
