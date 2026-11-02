import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
 * standard `~/.bun/bin/bun`, else the bun running now. `bun run` puts a `node_modules/bun` (a
 * peer dependency of bun-plugin-tailwind) first on PATH and in `process.execPath`, and a
 * project-local binary is not something to grant Full Disk Access to.
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
  return exists(standard) ? standard : execPath;
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
}: {
  home: string;
  repoDir: string;
  bunPath: string;
  claudeBin: string;
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
    logDir: join(repoDir, "data/logs"),
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
 * Writes the plist, checks it with `plutil -lint`, boots out any loaded copy (so reinstalling
 * picks up changes), then `launchctl bootstrap gui/<uid>`: a per-user LaunchAgent, which sees
 * the login Keychain. Never a LaunchDaemon.
 */
export function installAgent(target: AgentTarget & { plistPath: string; contents: string }): void {
  mkdirSync(dirname(target.plistPath), { recursive: true });
  writeFileSync(target.plistPath, target.contents);
  const lint = target.run(["plutil", "-lint", target.plistPath]);
  if (lint.exitCode !== 0) throw failure("plutil -lint", lint);
  bootout(target);
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
