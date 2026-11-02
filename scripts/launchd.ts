/**
 * Manage the nightly-sync LaunchAgent (#18).
 *
 *   bun run launchd:install    # render, write to ~/Library/LaunchAgents, lint, bootstrap
 *   bun run launchd:uninstall  # bootout and remove the plist
 *   bun run launchd:status     # launchctl print gui/$(id -u)/<label>
 *   bun run launchd:render [--out <path>]  # render + plutil -lint only; touches no launchctl
 *
 * Paths baked into the plist: this repo, bun (BUN_BIN, default ~/.bun/bin/bun; grant it Full
 * Disk Access), and CLAUDE_BIN (default `claude` on PATH, else ~/.local/bin/claude).
 * Re-running install boots out the loaded job first, so it is safe to repeat after changes.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  agentStatus,
  DEFAULT_TEMPLATE_PATH,
  installAgent,
  LABEL,
  plistVars,
  renderPlist,
  resolveBunPath,
  spawnCommand,
  uninstallAgent,
} from "../src/ops/launchd";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  options: { out: { type: "string" } },
  allowPositionals: true,
});
const command = positionals[0];

if (process.platform !== "darwin") {
  console.error("launchd is macOS only.");
  process.exit(1);
}

const home = homedir();
const repoDir = resolve(import.meta.dir, "..");
const fallbackClaude = join(home, ".local/bin/claude");
const claudeBin =
  process.env.CLAUDE_BIN ??
  Bun.which("claude") ??
  (existsSync(fallbackClaude) ? fallbackClaude : null);
if (!claudeBin) {
  console.error("Could not find `claude`; set CLAUDE_BIN to its full path.");
  process.exit(1);
}

const bunPath = resolveBunPath({
  env: process.env,
  home,
  execPath: process.execPath,
  exists: existsSync,
});
const vars = plistVars({ home, repoDir, bunPath, claudeBin });
const plistPath = join(home, "Library/LaunchAgents", `${LABEL}.plist`);
const uid = process.getuid?.() ?? Number(spawnCommand(["id", "-u"]).stdout.trim());
const target = { uid, label: LABEL, run: spawnCommand };
const render = () => renderPlist(readFileSync(DEFAULT_TEMPLATE_PATH, "utf8"), vars);

switch (command) {
  case "install": {
    // launchd creates the log files but not their directory.
    mkdirSync(vars.logDir, { recursive: true });
    installAgent({ ...target, plistPath, contents: render() });
    console.log(`Installed ${plistPath} and bootstrapped gui/${uid}/${LABEL}.`);
    console.log(`Runs daily at 03:30. Run now: launchctl kickstart -k gui/${uid}/${LABEL}`);
    console.log(`Grant Full Disk Access to ${vars.bunPath} so the Apple Books step can run.`);
    break;
  }
  case "uninstall": {
    uninstallAgent({ ...target, plistPath });
    console.log(`Removed gui/${uid}/${LABEL} and ${plistPath}.`);
    break;
  }
  case "status": {
    const { loaded, output } = agentStatus(target);
    console.log(loaded ? output : `${LABEL} is not loaded (${output}).`);
    if (!loaded) process.exitCode = 1;
    break;
  }
  case "render": {
    const out = resolve(values.out ?? join(vars.logDir, `${LABEL}.plist`));
    mkdirSync(resolve(out, ".."), { recursive: true });
    await Bun.write(out, render());
    const lint = spawnCommand(["plutil", "-lint", out]);
    console.log(out);
    console.log((lint.stdout || lint.stderr).trim());
    if (lint.exitCode !== 0) process.exitCode = 1;
    break;
  }
  default:
    console.error("usage: bun scripts/launchd.ts <install|uninstall|status|render [--out path]>");
    process.exit(1);
}
