# quotes-engine

A local catalog of every quote I've posted to Instagram: when each was posted, how it performed (likes/comments), which quotes were reposted, plus my Apple Books highlights as a backlog of future posts. Includes a searchable UI.

## Stack

TypeScript · Bun · Biome · React · Tailwind v4 · shadcn/ui · SQLite (`bun:sqlite`) · `bun test`

## How it works

- **Instagram sync:** pulls posts, captions, media, likes and comments from the Instagram API (Creator/Business account) and saves metric snapshots over time.
- **Quote extraction:** reads the quote from the caption and/or image using Claude Haiku (subagents for the backfill, `claude -p` for new posts).
- **Apple Books import:** reads highlights from the local Books SQLite databases (the terminal needs Full Disk Access).
- **Repost tracking:** `post_quotes` links quotes to posts many-to-many, so one quote can have several postings.
- **Nightly sync:** a launchd agent runs `bun run sync`.

## Nightly sync

`bun run sync` runs three steps in order: `sync:instagram`, then `extract:new`, then `import:books`. Each step runs as its own process, so if one fails the others still run.

- Each run appends a JSON summary to `data/logs/sync-YYYY-MM-DD.json` (UTC date). The summary has every step's status, its duration, and the last lines of its output.
- The command exits 1 if any step failed. On failure it also shows a macOS notification; set `SYNC_NOTIFY=0` to turn that off.
- `data/sync.lock` holds the running sync's PID, so a manual run and the scheduled run can't overlap. If the process that wrote the lock is no longer running, the next run takes over the lock.
- The Instagram token comes from the login Keychain (service `quotes-engine`, account `ig-access-token`). The token doesn't expire, so the sync has no token-refresh step and needs neither `op` nor a 1Password service account.
- Each extraction batch costs about $0.002 in Haiku usage.

### Install the LaunchAgent

```sh
bun run launchd:install    # render the plist, write it to ~/Library/LaunchAgents, plutil -lint, launchctl bootstrap
bun run launchd:status     # launchctl print gui/$(id -u)/com.ncolesummers.quotes-engine.sync
bun run launchd:uninstall  # launchctl bootout + remove the plist
bun run launchd:render     # render + lint only, written to data/logs/ (no launchctl)
```

- Run `launchd:install` from the checkout the job should use. The rendered plist hardcodes that repo's path, the path to `bun` (`~/.bun/bin/bun` unless you set `BUN_BIN`), and `CLAUDE_BIN`.
- Running `launchd:install` again boots out the loaded job first, so it's safe to repeat after you change something.
- The job is a per-user LaunchAgent in the `gui/<uid>` domain, not a LaunchDaemon, so it can read the login Keychain and your Claude Code login.
- It runs daily at 03:30 (`StartCalendarInterval`). A Mac that's asleep at that time runs the job when it wakes.
- launchd's default `PATH` has neither `bun` nor `claude`. The plist sets `PATH` to include `~/.bun/bin`, `~/.local/bin` and `/opt/homebrew/bin`, and it also sets `CLAUDE_BIN` and `HOME`.

**Run it now:**

```sh
launchctl kickstart -k gui/$(id -u)/com.ncolesummers.quotes-engine.sync
```

**Logs:**

- `data/logs/sync-YYYY-MM-DD.json` has the per-run summary.
- `data/logs/sync.out.log` and `data/logs/sync.err.log` have the job's raw stdout and stderr.

### Grant Full Disk Access to bun

The Apple Books step reads `~/Library/Containers/com.apple.iBooksX`, which macOS protects. When launchd runs the job, the process that needs Full Disk Access is `bun` itself, not your terminal. To grant it:

1. Open System Settings → Privacy & Security → Full Disk Access.
2. Click **+**.
3. Press ⌘⇧G and enter `~/.bun/bin/bun`. If `launchd:install` printed a different path, use that one.
4. Click **Open** and make sure the toggle is on.

When bun is upgraded, its binary is replaced and macOS may drop the permission. If the Books step starts failing after an upgrade, remove `bun` from the list and add it again.

### Troubleshooting

- **`launchctl print` says "Could not find service":** the job isn't loaded. Run `bun run launchd:install`.
- **`import:books` fails with an access error:** bun doesn't have Full Disk Access (see above). The other steps still run.
- **`claude` isn't found, or `extract:new` fails right away:** check `CLAUDE_BIN` in `~/Library/LaunchAgents/com.ncolesummers.quotes-engine.sync.plist`. Then reinstall with `CLAUDE_BIN=/path/to/claude bun run launchd:install`. If Claude reports an auth error under launchd, store a `claude setup-token` token in the Keychain.
- **Instagram step: "No Instagram access token found":** add the token to the login Keychain with `security add-generic-password -U -s quotes-engine -a ig-access-token -w`. `IG_USER_ID` must be set in `.env`; launchd runs the job in the repo, so bun loads that `.env`.
- **"Another sync is already running (pid N)":** a run is still going, or PID N was reused by some other process. Check with `ps -p N`. If it isn't a sync, delete `data/sync.lock`.
- **`database is locked` / `SQLITE_BUSY`:** every connection waits up to 5 s for the lock (`busy_timeout`), so this should be rare. If it still happens, stop whatever is holding the database open and run the job again.
- **The job didn't run at 03:30:** check `bun run launchd:status`, which shows `last exit code` and `runs`, and read `data/logs/sync.err.log`.

## Plan

The implementation plan lives in [GitHub Issues](../../issues), grouped by milestone.
