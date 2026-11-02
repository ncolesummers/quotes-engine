/**
 * Print the classification prompt for one batch file, for one subagent.
 *
 *   bun run extract:classify-prompt data/extractions/todo/batch-007.json
 *
 * The result path is `$EXTRACTIONS_DIR/classified/<batch-name>.json` (default
 * `data/extractions`), which is where `bun run extract:assemble` reads from.
 */
import { existsSync } from "node:fs";
import { DEFAULT_EXTRACTIONS_DIR } from "../src/ingest/extraction/batches";
import {
  buildClassificationPrompt,
  classifiedPathForBatch,
} from "../src/ingest/extraction/classification-prompt";

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: bun run extract:classify-prompt <batchPath>");
  process.exit(1);
}
if (!existsSync(arg)) {
  console.error(`No such batch file: ${arg}`);
  process.exit(1);
}
const extractionsDir = process.env.EXTRACTIONS_DIR ?? DEFAULT_EXTRACTIONS_DIR;
try {
  const outPath = classifiedPathForBatch(arg, extractionsDir);
  process.stdout.write(buildClassificationPrompt({ batchPath: arg, outPath }));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
