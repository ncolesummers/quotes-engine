export const DEFAULT_GRAPH_HOST = "https://graph.facebook.com";

export interface InstagramConfig {
  token: string;
  userId: string;
  host: string;
}

export class InstagramConfigError extends Error {
  override name = "InstagramConfigError";
}

const OP_RUN_HINT =
  "Run the command under 1Password so the op:// reference in .env is resolved, e.g. " +
  "`op run --env-file=.env -- bun scripts/ig-smoke.ts`. See docs/instagram-setup.md.";

/**
 * Reads Instagram Graph API settings from the environment. The token is expected to be
 * injected by `op run`; this function never reads or writes .env itself.
 */
export function loadInstagramConfig(
  env: Record<string, string | undefined> = process.env,
): InstagramConfig {
  const token = env.IG_ACCESS_TOKEN?.trim() ?? "";
  if (!token) {
    throw new InstagramConfigError(`IG_ACCESS_TOKEN is not set. ${OP_RUN_HINT}`);
  }
  if (token.startsWith("op://")) {
    throw new InstagramConfigError(
      `IG_ACCESS_TOKEN is still an unresolved 1Password reference. ${OP_RUN_HINT}`,
    );
  }

  const userId = env.IG_USER_ID?.trim() ?? "";
  if (!userId) {
    throw new InstagramConfigError(
      "IG_USER_ID is not set. Set it in .env to the Instagram professional account id.",
    );
  }

  const host = env.IG_GRAPH_HOST?.trim() || DEFAULT_GRAPH_HOST;
  return { token, userId, host };
}
