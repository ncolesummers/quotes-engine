/**
 * Test helper run as a separate process: the sync entry point with one long step.
 *
 *   bun test/helpers/sync-signal-fixture.ts <lock path> <grandchild pid file>
 *
 * The step runs `sh`, which forks a `sleep` and writes that sleep's PID to <pid file>, so the
 * test can check that SIGTERM takes down the whole step process group and frees the lock.
 */
import { dirname, join } from "node:path";
import { commandStep, runSyncMain } from "../../src/ops/sync";

const [lockPath, pidFile] = process.argv.slice(2);
if (!lockPath || !pidFile) {
  console.error("usage: sync-signal-fixture.ts <lock path> <pid file>");
  process.exit(2);
}

process.exitCode = await runSyncMain({
  lockPath,
  steps: [
    commandStep("long", ["sh", "-c", `sleep 30 & echo $! > '${pidFile}'; wait`], {
      cwd: dirname(lockPath),
      write: { stdout: () => {}, stderr: () => {} },
    }),
  ],
  logDir: join(dirname(lockPath), "logs"),
  log: () => {},
});
