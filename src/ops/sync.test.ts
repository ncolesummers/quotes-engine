import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CommandStepError,
  commandStep,
  runSync,
  type SyncRunSummary,
  type SyncStep,
  syncLogPath,
} from "./sync";

const NOW = new Date("2026-11-02T10:30:00.000Z");

/** A clock that advances 1s per call, so durations are deterministic. */
function steppingClock(start = NOW) {
  let t = start.getTime();
  return () => {
    const d = new Date(t);
    t += 1000;
    return d;
  };
}

describe("runSync", () => {
  let logDir: string;
  const lines: string[] = [];
  const log = (m: string) => lines.push(m);

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), "qe-sync-"));
    lines.length = 0;
  });
  afterEach(() => rmSync(logDir, { recursive: true, force: true }));

  const step = (name: string, calls: string[], fail?: string): SyncStep => ({
    name,
    run: async () => {
      calls.push(name);
      if (fail) throw new Error(fail);
      return { name };
    },
  });

  test("runs steps in order and records each step's status", async () => {
    const calls: string[] = [];
    const summary = await runSync({
      steps: [step("a", calls), step("b", calls), step("c", calls)],
      now: steppingClock(),
      log,
      logDir,
    });
    expect(calls).toEqual(["a", "b", "c"]);
    expect(summary.ok).toBe(true);
    expect(summary.steps.map((s) => [s.name, s.ok])).toEqual([
      ["a", true],
      ["b", true],
      ["c", true],
    ]);
    expect(summary.steps[0]?.detail).toEqual({ name: "a" });
    expect(summary.steps[0]?.durationMs).toBe(1000);
    expect(summary.startedAt).toBe(NOW.toISOString());
  });

  test("a failure in step 2 still runs steps 3 and 4, and marks the run failed", async () => {
    const calls: string[] = [];
    const summary = await runSync({
      steps: [step("1", calls), step("2", calls, "boom"), step("3", calls), step("4", calls)],
      now: steppingClock(),
      log,
      logDir,
    });
    expect(calls).toEqual(["1", "2", "3", "4"]);
    expect(summary.ok).toBe(false);
    expect(summary.steps.map((s) => s.ok)).toEqual([true, false, true, true]);
    expect(summary.steps[1]?.error).toBe("boom");
    expect(lines.some((l) => l.includes("2") && l.includes("boom"))).toBe(true);
  });

  test("a step that throws a non-Error is still isolated", async () => {
    const summary = await runSync({
      steps: [
        {
          name: "weird",
          run: () => {
            throw "nope";
          },
        },
        { name: "after", run: async () => undefined },
      ],
      now: steppingClock(),
      log,
      logDir,
    });
    expect(summary.steps.map((s) => [s.name, s.ok, s.error])).toEqual([
      ["weird", false, "nope"],
      ["after", true, undefined],
    ]);
  });

  test("CommandStepError output tail is kept in the summary", async () => {
    const summary = await runSync({
      steps: [
        {
          name: "cmd",
          run: () => {
            throw new CommandStepError("cmd exited with code 3", 3, ["last line"]);
          },
        },
      ],
      now: steppingClock(),
      log,
      logDir,
    });
    expect(summary.steps[0]).toMatchObject({ ok: false, exitCode: 3, output: ["last line"] });
  });

  test("appends one entry per run to sync-YYYY-MM-DD.json", async () => {
    const calls: string[] = [];
    await runSync({ steps: [step("a", calls)], now: steppingClock(), log, logDir });
    await runSync({ steps: [step("a", calls, "x")], now: steppingClock(), log, logDir });

    const path = join(logDir, "sync-2026-11-02.json");
    expect(syncLogPath(logDir, NOW)).toBe(path);
    const entries = JSON.parse(readFileSync(path, "utf8")) as SyncRunSummary[];
    expect(entries.map((e) => e.ok)).toEqual([true, false]);
  });

  test("creates the log dir and keeps a corrupt log file aside instead of losing it", async () => {
    const nested = join(logDir, "nested");
    await runSync({ steps: [], now: steppingClock(), log, logDir: nested });
    const path = join(nested, "sync-2026-11-02.json");
    expect(existsSync(path)).toBe(true);

    writeFileSync(path, "{not json");
    await runSync({ steps: [], now: steppingClock(), log, logDir: nested });
    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveLength(1);
    expect(readFileSync(`${path}.corrupt`, "utf8")).toBe("{not json");
  });

  test("notifies only when a step failed, and a failing notifier is harmless", async () => {
    const notes: string[] = [];
    const notify = (title: string, message: string) => {
      notes.push(`${title}: ${message}`);
    };
    await runSync({ steps: [step("a", [])], now: steppingClock(), log, logDir, notify });
    expect(notes).toEqual([]);

    await runSync({
      steps: [step("a", [], "bad"), step("b", [], "worse")],
      now: steppingClock(),
      log,
      logDir,
      notify,
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("a, b");

    const summary = await runSync({
      steps: [step("a", [], "bad")],
      now: steppingClock(),
      log,
      logDir,
      notify: () => {
        throw new Error("osascript missing");
      },
    });
    expect(summary.ok).toBe(false);
  });
});

describe("commandStep", () => {
  const bun = process.execPath;
  const quiet = { stdout: () => {}, stderr: () => {} };

  test("resolves with the exit code and output tail on success", async () => {
    const s = commandStep("ok", [bun, "-e", "console.log('one'); console.log('two')"], {
      cwd: tmpdir(),
      write: quiet,
    });
    expect(s.name).toBe("ok");
    expect(await s.run()).toEqual({ exitCode: 0, output: ["one", "two"] });
  });

  test("throws CommandStepError with the exit code and output tail on failure", async () => {
    const s = commandStep(
      "bad",
      [bun, "-e", "console.log('a'); console.error('b'); process.exit(3)"],
      { cwd: tmpdir(), write: quiet, tailLines: 5 },
    );
    const err = await Promise.resolve(s.run()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CommandStepError);
    expect((err as CommandStepError).exitCode).toBe(3);
    expect((err as CommandStepError).output.toSorted()).toEqual(["a", "b"]);
  });

  test("forwards output to the writers and keeps only the last lines", async () => {
    const out: string[] = [];
    const s = commandStep("many", [bun, "-e", "for (let i = 0; i < 10; i++) console.log(i)"], {
      cwd: tmpdir(),
      write: { stdout: (c) => out.push(c), stderr: () => {} },
      tailLines: 3,
    });
    expect(await s.run()).toEqual({ exitCode: 0, output: ["7", "8", "9"] });
    expect(out.join("")).toBe("0\n1\n2\n3\n4\n5\n6\n7\n8\n9\n");
  });

  test("kills a step that runs past its timeout", async () => {
    const s = commandStep("slow", [bun, "-e", "setTimeout(() => {}, 10000)"], {
      cwd: tmpdir(),
      write: quiet,
      timeoutMs: 200,
    });
    await expect(s.run()).rejects.toThrow(/timed out/);
  });
});
