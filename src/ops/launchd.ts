import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const LABEL = "com.ncolesummers.quotes-engine.sync";

export const DEFAULT_TEMPLATE_PATH = resolve(
  import.meta.dir,
  "../../scripts/launchd",
  `${LABEL}.plist.template`,
);

export interface PlistVars {
  label: string;
  repoDir: string;
  bunPath: string;
  home: string;
  claudeBin: string;
  path: string;
  logDir: string;
}

/**
 * The bun the job runs, which is also the binary that needs Full Disk Access: BUN_BIN, else the
 * standard `~/.bun/bin/bun`, else the bun running now. `bun run` can put a `node_modules/bun` (a
 * peer dependency of bun-plugin-tailwind) first on PATH and in `process.execPath`; a
 * project-local binary is not something to grant Full Disk Access to, so that case throws.
 */
export function resolveBunPath({
  env,
  home,
  execPath,
  exists,
}: {
  env: Record<string, string | undefined>;
  home: string;
  execPath: string;
  exists: (path: string) => boolean;
}): string {
  if (env.BUN_BIN) return env.BUN_BIN;
  const standard = join(home, ".bun/bin/bun");
  if (exists(standard)) return standard;
  if (execPath.includes("/node_modules/")) {
    throw new Error(
      `The running bun is project-local (${execPath}); set BUN_BIN to the bun the job should use.`,
    );
  }
  return execPath;
}

/** True when `dir` is a linked `git worktree` checkout (its `.git` is a file, not a directory). */
export function isLinkedWorktree(dir: string): boolean {
  try {
    return statSync(join(dir, ".git")).isFile();
  } catch {
    return false;
  }
}

/**
 * Values for the plist. launchd's default PATH has neither bun (`~/.bun/bin`) nor claude
 * (`~/.local/bin`, symlinked from `/opt/homebrew/bin`), so PATH spells them out; CLAUDE_BIN pins
 * claude regardless. `/usr/bin` is needed for `swiftc` (OCR) and `security` (Keychain).
 */
export function plistVars({
  home,
  repoDir,
  bunPath,
  claudeBin,
  dataDir = "data",
}: {
  home: string;
  repoDir: string;
  bunPath: string;
  claudeBin: string;
  /** DATA_DIR, resolved against the repo exactly as scripts/sync.ts does (default `data`). */
  dataDir?: string;
}): PlistVars {
  const path = [
    dirname(bunPath),
    join(home, ".bun/bin"),
    join(home, ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter((d, i, all) => all.indexOf(d) === i);
  return {
    label: LABEL,
    repoDir,
    bunPath,
    home,
    claudeBin,
    path: path.join(":"),
    logDir: join(resolve(repoDir, dataDir), "logs"),
  };
}

function xmlEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Fills `{{NAME}}` placeholders with XML-escaped values; throws on an unknown one. */
export function renderPlist(template: string, vars: PlistVars): string {
  const values: Record<string, string> = {
    LABEL: vars.label,
    REPO_DIR: vars.repoDir,
    BUN: vars.bunPath,
    HOME: vars.home,
    CLAUDE_BIN: vars.claudeBin,
    PATH: vars.path,
    LOG_DIR: vars.logDir,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`Unknown plist placeholder {{${name}}}`);
    return xmlEscape(value);
  });
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (cmd: string[]) => CommandResult;

export const spawnCommand: CommandRunner = (cmd) => {
  const r = Bun.spawnSync(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};

interface AgentTarget {
  uid: number;
  label: string;
  run: CommandRunner;
}

const serviceTarget = ({ uid, label }: AgentTarget) => `gui/${uid}/${label}`;

function failure(what: string, r: CommandResult): Error {
  return new Error(`${what} failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim()}`);
}

/** `launchctl bootout`, ignoring "not loaded"; returns whether a loaded job was removed. */
function bootout(target: AgentTarget): boolean {
  return target.run(["launchctl", "bootout", serviceTarget(target)]).exitCode === 0;
}

/**
 * Lints the plist with `plutil -lint` before it replaces the installed one, boots out any loaded
 * copy (so reinstalling picks up changes), waits for launchd to finish tearing it down, then
 * `launchctl bootstrap gui/<uid>`: a per-user LaunchAgent, which sees the login Keychain. Never a
 * LaunchDaemon. `bootout` returns before the service is gone, and bootstrapping too early fails
 * with "Bootstrap failed: 5: Input/output error".
 */
export function installAgent(
  target: AgentTarget & { plistPath: string; contents: string; sleep?: (ms: number) => void },
): void {
  const sleep = target.sleep ?? Bun.sleepSync;
  mkdirSync(dirname(target.plistPath), { recursive: true });
  const tmp = `${target.plistPath}.tmp`;
  writeFileSync(tmp, target.contents);
  const lint = target.run(["plutil", "-lint", tmp]);
  if (lint.exitCode !== 0) {
    rmSync(tmp, { force: true });
    throw failure("plutil -lint", lint);
  }
  renameSync(tmp, target.plistPath);
  if (bootout(target)) {
    for (let i = 0; i < 50 && agentStatus(target).loaded; i++) sleep(100);
  }
  const boot = target.run(["launchctl", "bootstrap", `gui/${target.uid}`, target.plistPath]);
  if (boot.exitCode !== 0) throw failure("launchctl bootstrap", boot);
}

/** Boots out the job (if loaded) and removes the plist (if present). */
export function uninstallAgent(target: AgentTarget & { plistPath: string }): void {
  bootout(target);
  rmSync(target.plistPath, { force: true });
}

/** `launchctl print gui/<uid>/<label>`. */
export function agentStatus(target: AgentTarget): { loaded: boolean; output: string } {
  const r = target.run(["launchctl", "print", serviceTarget(target)]);
  return { loaded: r.exitCode === 0, output: (r.exitCode === 0 ? r.stdout : r.stderr).trim() };
}
