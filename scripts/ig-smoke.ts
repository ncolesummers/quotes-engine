/**
 * Manual smoke test against the real Instagram Graph API. Not run by `bun test`.
 *
 *   op run --env-file=.env -- bun scripts/ig-smoke.ts
 *
 * Prints the account username and the newest post's id and like_count. Never prints the token.
 */
import { createInstagramClient } from "../src/ingest/instagram/client";
import { loadInstagramConfig } from "../src/ingest/instagram/config";

try {
  const client = createInstagramClient(loadInstagramConfig());

  const account = await client.getAccount();
  console.log(`username: ${account.username} (media_count: ${account.mediaCount})`);

  for await (const media of client.listMedia()) {
    console.log(`first post: id=${media.id} like_count=${media.likeCount ?? "n/a"}`);
    break;
  }
} catch (err) {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exit(1);
}
