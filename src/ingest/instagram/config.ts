export const DEFAULT_GRAPH_HOST = "https://graph.facebook.com";

export const KEYCHAIN_SERVICE = "quotes-engine";
export const KEYCHAIN_ACCOUNT = "ig-access-token";

export interface InstagramConfig {
  token: string;
  userId: string;
  host: string;
}

export interface LoadInstagramConfigOptions {
  /** Returns the token stored in the macOS Keychain, or null when there is none. */
  readKeychainToken?: () => string | null;
}

export class InstagramConfigError extends Error {
  override name = "InstagramConfigError";
}

export type CommandRunner = (cmd: string[]) => { exitCode: number; stdout: string };

const spawnCommand: CommandRunner = (cmd) => {
  const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  return { exitCode: result.exitCode, stdout: result.stdout.toString() };
};

/**
 * Reads the token from the login Keychain with
 * `security find-generic-password -s quotes-engine -a ig-access-token -w`.
 * Returns null if the item is missing or `security` is unavailable (e.g. not macOS).
 */
export function readKeychainToken(run: CommandRunner = spawnCommand): string | null {
  try {
    const { exitCode, stdout } = run([
      "security",
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
    ]);
    return exitCode === 0 ? stdout.trim() : null;
  } catch {
    return null;
  }
}

/** A usable token: non-blank and not an unresolved 1Password reference. */
function usableToken(value: string | null | undefined): string | null {
  const token = value?.trim() ?? "";
  return token && !token.startsWith("op://") ? token : null;
}

const MISSING_TOKEN_HELP =
  "No Instagram access token found. Either:\n" +
  `  - store it in the macOS login Keychain (service "${KEYCHAIN_SERVICE}", account ` +
  `"${KEYCHAIN_ACCOUNT}"), e.g. \`security add-generic-password -U -s ${KEYCHAIN_SERVICE} ` +
  `-a ${KEYCHAIN_ACCOUNT} -w\` (it prompts for the token), or\n` +
  "  - set IG_ACCESS_TOKEN, e.g. by running the command under 1Password so the op:// " +
  "reference in .env is resolved: `op run --env-file=.env -- bun scripts/ig-smoke.ts`.\n" +
  "See docs/instagram-setup.md.";

/**
 * Reads Instagram Graph API settings. The token comes from IG_ACCESS_TOKEN when it is set and
 * resolved (e.g. by `op run`); otherwise from the macOS Keychain. Nothing is ever written back.
 */
export function loadInstagramConfig(
  env: Record<string, string | undefined> = process.env,
  { readKeychainToken: readKeychain = readKeychainToken }: LoadInstagramConfigOptions = {},
): InstagramConfig {
  const token = usableToken(env.IG_ACCESS_TOKEN) ?? usableToken(readKeychain());
  if (!token) {
    throw new InstagramConfigError(MISSING_TOKEN_HELP);
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
