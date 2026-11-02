import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLASSIFIER_MODEL,
  claudeClassifyArgs,
  createClaudeClassifier,
  DEFAULT_CLASSIFY_TIMEOUT_MS,
  parseClaudeResult,
} from "./claude";
import type { ClassifyRequest } from "./incremental";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "quotes-claude-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function request(overrides: Partial<ClassifyRequest> = {}): ClassifyRequest {
  return {
    batchPath: join(root, "todo", "batch-001.json"),
    outPath: join(root, "classified", "batch-001.json"),
    prompt: "classify batch-001",
    cwd: root,
    addDirs: [join(root, "extractions")],
    ...overrides,
  };
}

/** A fake `claude` executable: records its argv and cwd, then runs `body`. */
function fakeClaude(body: string): string {
  const bin = join(root, "claude");
  writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/argv.txt"\npwd > "${root}/cwd.txt"\n${body}\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

const RESULT_JSON = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "batch-001: 1 posts, 1 quotes, 0 no_quote",
  duration_ms: 12345,
  num_turns: 3,
  total_cost_usd: 0.0123,
  usage: { input_tokens: 10, output_tokens: 20 },
});

describe("claudeClassifyArgs", () => {
  test("runs Haiku headless with only Read and Write", () => {
    const args = claudeClassifyArgs(request());
    expect(CLASSIFIER_MODEL).toBe("haiku");
    expect(args.slice(0, 2)).toEqual(["-p", "classify batch-001"]);
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(flag("--model")).toBe("haiku");
    expect(flag("--allowedTools")).toBe("Read,Write");
    expect(flag("--tools")).toBe("Read,Write");
    expect(flag("--permission-mode")).toBe("acceptEdits");
    expect(flag("--output-format")).toBe("json");
    expect(flag("--add-dir")).toBe(join(root, "extractions"));
    expect(args).toContain("--no-session-persistence");
  });

  test("the default timeout is 5 minutes", () => {
    expect(DEFAULT_CLASSIFY_TIMEOUT_MS).toBe(5 * 60_000);
  });
});

describe("parseClaudeResult", () => {
  test("reads cost, duration and is_error from --output-format json", () => {
    expect(parseClaudeResult(RESULT_JSON)).toEqual({
      isError: false,
      result: "batch-001: 1 posts, 1 quotes, 0 no_quote",
      costUsd: 0.0123,
      durationMs: 12345,
      numTurns: 3,
    });
  });

  test("returns null for output that isn't a result object", () => {
    expect(parseClaudeResult("not json")).toBeNull();
    expect(parseClaudeResult("")).toBeNull();
  });
});

describe("createClaudeClassifier", () => {
  test("spawns the binary with the prompt and flags, in cwd", async () => {
    const bin = fakeClaude(`echo '${RESULT_JSON}'`);
    const classify = createClaudeClassifier({ bin });
    const outcome = await classify(request());
    expect(outcome).toMatchObject({
      exitCode: 0,
      timedOut: false,
      isError: false,
      costUsd: 0.0123,
      result: "batch-001: 1 posts, 1 quotes, 0 no_quote",
    });
    const argv = readFileSync(join(root, "argv.txt"), "utf8").trim().split("\n");
    expect(argv).toEqual(claudeClassifyArgs(request()));
    expect(readFileSync(join(root, "cwd.txt"), "utf8").trim()).toEndWith(
      root.split("/").at(-1) as string,
    );
  });

  test("reports a non-zero exit with stderr", async () => {
    const bin = fakeClaude(`echo "API Error: 529 overloaded" >&2\nexit 3`);
    const outcome = await createClaudeClassifier({ bin })(request());
    expect(outcome).toMatchObject({ exitCode: 3, timedOut: false });
    expect(outcome.stderr).toContain("API Error: 529 overloaded");
  });

  test("kills the process after the timeout", async () => {
    const bin = fakeClaude("sleep 30");
    const started = performance.now();
    const outcome = await createClaudeClassifier({ bin, timeoutMs: 200 })(request());
    expect(outcome.timedOut).toBe(true);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("a missing binary is a failed outcome, not a throw", async () => {
    const outcome = await createClaudeClassifier({ bin: join(root, "nope") })(request());
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.stderr).not.toBe("");
  });
});
