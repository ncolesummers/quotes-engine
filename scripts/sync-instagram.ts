/**
 * Sync Instagram posts, metric snapshots and media into the quotes DB.
 *
 *   bun run sync:instagram                 # token from the macOS Keychain
 *   bun run sync:instagram --metrics-only  # skip downloads for posts that already have media
 *
 * Env: IG_USER_ID (required), IG_ACCESS_TOKEN (optional), QUOTES_DB_PATH, MEDIA_DIR
 * (default data/media). Exits non-zero if anything failed.
 */
import { createInstagramClient, InstagramApiError } from "../src/ingest/instagram/client";
import { loadInstagramConfig } from "../src/ingest/instagram/config";
import { DEFAULT_MEDIA_DIR, syncInstagram } from "../src/ingest/instagram/sync";
import { openDb } from "../src/server/db/index";

const metricsOnly = process.argv.includes("--metrics-only");
const mediaDir = process.env.MEDIA_DIR ?? DEFAULT_MEDIA_DIR;

let client: ReturnType<typeof createInstagramClient>;
try {
  client = createInstagramClient(loadInstagramConfig());
} catch (err) {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exit(1);
}

const db = openDb();
try {
  const started = Date.now();
  const { errors, fatal, ...counts } = await syncInstagram({ db, client, mediaDir, metricsOnly });
  console.log({ ...counts, errors: errors.length, seconds: (Date.now() - started) / 1000 });
  for (const e of errors) console.error(`${e.igMediaId ?? "(listing)"}: ${e.message}`);
  if (fatal instanceof InstagramApiError && fatal.isInvalidToken) {
    console.error("The sync stopped early because the access token is invalid.");
  } else if (fatal) {
    console.error("The sync stopped early; not every post was seen.");
  }
  if (errors.length > 0) process.exitCode = 1;
} finally {
  db.close();
}
