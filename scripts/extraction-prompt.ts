/**
 * Print the extraction prompt for one batch file, for one subagent.
 *
 *   bun scripts/extraction-prompt.ts data/extractions/todo/batch-007.json
 *   bun run docs:prompt     # regenerate docs/extraction-prompt.md (--doc mode)
 *
 * The result path is `$EXTRACTIONS_DIR/<batch-name>.json` (default `data/extractions`), which is
 * where `bun run import:extractions` reads from.
 */
import { existsSync, writeFileSync } from "node:fs";
import { DEFAULT_EXTRACTIONS_DIR } from "../src/ingest/extraction/batches";
import {
  buildExtractionPrompt,
  outPathForBatch,
  renderExtractionPromptDoc,
} from "../src/ingest/extraction/prompt";

const DOC_PATH = "docs/extraction-prompt.md";

const arg = process.argv[2];
if (arg === "--doc") {
  writeFileSync(DOC_PATH, renderExtractionPromptDoc());
  console.log(`Wrote ${DOC_PATH}`);
} else if (!arg) {
  console.error("Usage: bun scripts/extraction-prompt.ts <batchPath>");
  process.exit(1);
} else if (!existsSync(arg)) {
  console.error(`No such batch file: ${arg}`);
  process.exit(1);
} else {
  const extractionsDir = process.env.EXTRACTIONS_DIR ?? DEFAULT_EXTRACTIONS_DIR;
  const outPath = outPathForBatch(arg, extractionsDir);
  process.stdout.write(buildExtractionPrompt({ batchPath: arg, outPath }));
}
