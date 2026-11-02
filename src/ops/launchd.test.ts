import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  agentStatus,
  type CommandResult,
  DEFAULT_TEMPLATE_PATH,
  installAgent,
  isLinkedWorktree,
  LABEL,
  type PlistVars,
  plistVars,
  renderPlist,
  resolveBunPath,
  uninstallAgent,
} from "./launchd";

const VARS: PlistVars = {
  label: LABEL,
  repoDir: "/Users/me/Code/quotes & co",
  bunPath: "/Users/me/.bun/bin/bun",
  home: "/Users/me",
  claudeBin: "/Users/me/.local/bin/claude",
  path: "/Users/me/.bun/bin:/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin:/bin",
  logDir: "/Users/me/Code/quotes & co/data/logs",
};

describe("resolveBunPath", () => {
  const base = { home: "/Users/me", execPath: "/repo/node_modules/bun/bin/bun.exe" };

  test("BUN_BIN wins", () => {
    expect(resolveBunPath({ ...base, env: { BUN_BIN: "/x/bun" }, exists: () => true })).toBe(
      "/x/bun",
    );
  });

  test("prefers ~/.bun/bin/bun over a node_modules bun that `bun run` puts first", () => {
    expect(
      resolveBunPath({ ...base, env: {}, exists: (p) => p === "/Users/me/.bun/bin/bun" }),
    ).toBe("/Users/me/.bun/bin/bun");
  });

  test("falls back to the running bun when it is a real install", () => {
    expect(
      resolveBunPath({
        ...base,
        execPath: "/opt/homebrew/bin/bun",
        env: {},
        exists: () => false,
      }),
    ).toBe("/opt/homebrew/bin/bun");
  });

  test("refuses to bake in a project-local node_modules bun; asks for BUN_BIN", () => {
    expect(() => resolveBunPath({ ...base, env: {}, exists: () => false })).toThrow(/BUN_BIN/);
  });
});

describe("plistVars", () => {
  test("PATH includes bun, ~/.local/bin and Homebrew; logs live under data/logs", () => {
    const v = plistVars({
      home: "/Users/me",
      repoDir: "/r",
      bunPath: "/Users/me/.bun/bin/bun",
      claudeBin: "/Users/me/.local/bin/claude",
    });
    const dirs = v.path.split(":");
    expect(dirs).toEqual(
      expect.arrayContaining([
        "/Users/me/.bun/bin",
        "/Users/me/.local/bin",
        "/opt/homebrew/bin",
        "/usr/bin",
      ]),
    );
    expect(v.logDir).toBe("/r/data/logs");
    expect(v.label).toBe(LABEL);
  });

  test("logs follow DATA_DIR, like scripts/sync.ts does", () => {
    const base = { home: "/h", repoDir: "/r", bunPath: "/h/.bun/bin/bun", claudeBin: "/c" };
    expect(plistVars({ ...base, dataDir: "elsewhere" }).logDir).toBe("/r/elsewhere/logs");
    expect(plistVars({ ...base, dataDir: "/abs/data" }).logDir).toBe("/abs/data/logs");
  });
});

describe("renderPlist", () => {
  const template = readFileSync(DEFAULT_TEMPLATE_PATH, "utf8");

  test("substitutes every placeholder with XML-escaped absolute paths", () => {
    const xml = renderPlist(template, VARS);
    expect(xml).not.toMatch(/\{\{\w+\}\}/);
    expect(xml).toContain(`<string>${LABEL}</string>`);
    expect(xml).toContain("<string>/Users/me/.bun/bin/bun</string>");
    expect(xml).toContain("<string>/Users/me/Code/quotes &amp; co/scripts/sync.ts</string>");
    expect(xml).toContain("<string>/Users/me/Code/quotes &amp; co</string>");
    expect(xml).toContain("<string>/Users/me/.local/bin/claude</string>");
    expect(xml).toContain("<string>/Users/me/Code/quotes &amp; co/data/logs/sync.out.log</string>");
    expect(xml).toContain("<string>/Users/me/Code/quotes &amp; co/data/logs/sync.err.log</string>");
  });

  test("runs daily at 03:30 via StartCalendarInterval", () => {
    const xml = renderPlist(template, VARS).replace(/\s+/g, "");
    expect(xml).toContain(
      "<key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>",
    );
  });

  test("throws on an unknown placeholder", () => {
    expect(() => renderPlist("<string>{{NOPE}}</string>", VARS)).toThrow(/NOPE/);
  });

  test.skipIf(process.platform !== "darwin")("the rendered plist passes plutil -lint", () => {
    const dir = mkdtempSync(join(tmpdir(), "qe-plist-"));
    try {
      const file = join(dir, `${LABEL}.plist`);
      writeFileSync(file, renderPlist(template, VARS));
      const r = Bun.spawnSync(["plutil", "-lint", file], { stdout: "pipe", stderr: "pipe" });
      expect(r.stdout.toString()).toContain("OK");
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("launchctl wrappers (fake runner)", () => {
  let dir: string;
  let plistPath: string;
  let calls: string[][];
  let responses: Record<string, CommandResult>;

  const ok: CommandResult = { exitCode: 0, stdout: "", stderr: "" };
  const sleep = () => {};
  const run = (cmd: string[]): CommandResult => {
    calls.push(cmd);
    return responses[cmd.slice(0, 2).join(" ")] ?? ok;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qe-agents-"));
    plistPath = join(dir, "LaunchAgents", `${LABEL}.plist`);
    calls = [];
    responses = {};
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("install writes the plist, lints it, boots out any old copy, then bootstraps", () => {
    responses["launchctl bootout"] = { exitCode: 3, stdout: "", stderr: "No such process" };
    installAgent({ plistPath, contents: "<plist/>", uid: 501, label: LABEL, run });
    expect(readFileSync(plistPath, "utf8")).toBe("<plist/>");
    expect(calls).toEqual([
      ["plutil", "-lint", `${plistPath}.tmp`],
      ["launchctl", "bootout", `gui/501/${LABEL}`],
      ["launchctl", "bootstrap", "gui/501", plistPath],
    ]);
  });

  test("install is idempotent: a second install boots out the loaded job first", () => {
    responses["launchctl print"] = { exitCode: 113, stdout: "", stderr: "Could not find service" };
    installAgent({ plistPath, contents: "<plist/>", uid: 501, label: LABEL, run, sleep });
    installAgent({ plistPath, contents: "<plist/>", uid: 501, label: LABEL, run, sleep });
    expect(calls.filter((c) => c[1] === "bootout")).toHaveLength(2);
    expect(calls.filter((c) => c[1] === "bootstrap")).toHaveLength(2);
  });

  test("install stops before launchctl when plutil -lint fails, keeping the old plist", () => {
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, "<good/>");
    responses["plutil -lint"] = { exitCode: 1, stdout: "bad plist", stderr: "" };
    expect(() =>
      installAgent({ plistPath, contents: "<plist", uid: 501, label: LABEL, run }),
    ).toThrow(/plutil/);
    expect(calls.some((c) => c[0] === "launchctl")).toBe(false);
    expect(readFileSync(plistPath, "utf8")).toBe("<good/>");
    expect(readdirSync(dirname(plistPath))).toEqual([`${LABEL}.plist`]);
  });

  test("after a successful bootout, install waits until the job is gone before bootstrapping", () => {
    let prints = 0;
    const runWithTeardown = (cmd: string[]): CommandResult => {
      calls.push(cmd);
      if (cmd[1] === "print") {
        prints++;
        return prints < 3 ? ok : { exitCode: 113, stdout: "", stderr: "Could not find service" };
      }
      return ok;
    };
    const naps: number[] = [];
    installAgent({
      plistPath,
      contents: "<plist/>",
      uid: 501,
      label: LABEL,
      run: runWithTeardown,
      sleep: (ms) => naps.push(ms),
    });
    const verbs = calls.filter((c) => c[0] === "launchctl").map((c) => c[1]);
    expect(verbs).toEqual(["bootout", "print", "print", "print", "bootstrap"]);
    expect(naps.length).toBe(2);
  });

  test("install throws when bootstrap fails", () => {
    responses["launchctl bootstrap"] = { exitCode: 5, stdout: "", stderr: "Input/output error" };
    expect(() =>
      installAgent({ plistPath, contents: "<plist/>", uid: 501, label: LABEL, run, sleep }),
    ).toThrow(/Input\/output error/);
  });

  test("uninstall boots out the job and removes the plist; safe when not installed", () => {
    responses["launchctl print"] = { exitCode: 113, stdout: "", stderr: "Could not find service" };
    installAgent({ plistPath, contents: "<plist/>", uid: 501, label: LABEL, run, sleep });
    calls = [];
    uninstallAgent({ plistPath, uid: 501, label: LABEL, run });
    expect(calls).toEqual([["launchctl", "bootout", `gui/501/${LABEL}`]]);
    expect(existsSync(plistPath)).toBe(false);

    responses["launchctl bootout"] = { exitCode: 3, stdout: "", stderr: "No such process" };
    expect(() => uninstallAgent({ plistPath, uid: 501, label: LABEL, run })).not.toThrow();
  });

  test("status wraps launchctl print and reports when the job is not loaded", () => {
    responses["launchctl print"] = { exitCode: 0, stdout: "state = not running", stderr: "" };
    expect(agentStatus({ uid: 501, label: LABEL, run })).toEqual({
      loaded: true,
      output: "state = not running",
    });
    expect(calls).toEqual([["launchctl", "print", `gui/501/${LABEL}`]]);

    responses["launchctl print"] = { exitCode: 113, stdout: "", stderr: "Could not find service" };
    expect(agentStatus({ uid: 501, label: LABEL, run })).toEqual({
      loaded: false,
      output: "Could not find service",
    });
  });
});

describe("isLinkedWorktree", () => {
  test("true when .git is a file (a `git worktree` checkout), false for the main checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "qe-wt-"));
    try {
      const main = join(dir, "main");
      const wt = join(dir, "wt");
      mkdirSync(join(main, ".git"), { recursive: true });
      mkdirSync(wt);
      writeFileSync(join(wt, ".git"), "gitdir: ../main/.git/worktrees/wt\n");
      expect(isLinkedWorktree(main)).toBe(false);
      expect(isLinkedWorktree(wt)).toBe(true);
      expect(isLinkedWorktree(join(dir, "nope"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
