import { describe, expect, test } from "bun:test";
import { InstagramConfigError, loadInstagramConfig } from "./config";

const USER_ID = "17841407547014534";
const OP_REF = "op://Development/quotes-engine Instagram/credential";

type Env = Record<string, string | undefined>;

/** Always inject a Keychain reader so tests never touch the real Keychain. */
function load(env: Env, keychain: string | null = null) {
  return loadInstagramConfig(env, { readKeychainToken: () => keychain });
}

describe("loadInstagramConfig", () => {
  test("reads token, user id and host from the environment", () => {
    const config = load({
      IG_ACCESS_TOKEN: "EAAtoken",
      IG_USER_ID: USER_ID,
      IG_GRAPH_HOST: "https://graph.example.test",
    });

    expect(config).toEqual({
      token: "EAAtoken",
      userId: USER_ID,
      host: "https://graph.example.test",
    });
  });

  test("defaults the host to https://graph.facebook.com when unset or blank", () => {
    expect(load({ IG_ACCESS_TOKEN: "EAAtoken", IG_USER_ID: USER_ID }).host).toBe(
      "https://graph.facebook.com",
    );
    expect(
      load({ IG_ACCESS_TOKEN: "EAAtoken", IG_USER_ID: USER_ID, IG_GRAPH_HOST: " " }).host,
    ).toBe("https://graph.facebook.com");
  });

  test("trims whitespace around values", () => {
    const config = load({ IG_ACCESS_TOKEN: " EAAtoken\n", IG_USER_ID: ` ${USER_ID} ` });

    expect(config.token).toBe("EAAtoken");
    expect(config.userId).toBe(USER_ID);
  });

  test("prefers IG_ACCESS_TOKEN over the Keychain and does not read the Keychain", () => {
    let reads = 0;
    const config = loadInstagramConfig(
      { IG_ACCESS_TOKEN: "EAAenv", IG_USER_ID: USER_ID },
      {
        readKeychainToken: () => {
          reads++;
          return "EAAkeychain";
        },
      },
    );

    expect(config.token).toBe("EAAenv");
    expect(reads).toBe(0);
  });

  test("falls back to the Keychain when IG_ACCESS_TOKEN is unset or blank", () => {
    expect(load({ IG_USER_ID: USER_ID }, "EAAkeychain").token).toBe("EAAkeychain");
    expect(load({ IG_ACCESS_TOKEN: "  ", IG_USER_ID: USER_ID }, "EAAkeychain").token).toBe(
      "EAAkeychain",
    );
  });

  test("falls back to the Keychain when IG_ACCESS_TOKEN is an unresolved op:// reference", () => {
    expect(load({ IG_ACCESS_TOKEN: OP_REF, IG_USER_ID: USER_ID }, "EAAkeychain").token).toBe(
      "EAAkeychain",
    );
  });

  test("trims the Keychain value and treats a blank one as missing", () => {
    expect(load({ IG_USER_ID: USER_ID }, "EAAkeychain\n").token).toBe("EAAkeychain");
    expect(() => load({ IG_USER_ID: USER_ID }, " \n")).toThrow(InstagramConfigError);
  });

  test("ignores an op:// reference stored in the Keychain", () => {
    expect(() => load({ IG_USER_ID: USER_ID }, OP_REF)).toThrow(InstagramConfigError);
  });

  test("with no token anywhere, explains both the Keychain and op run options", () => {
    for (const env of [{ IG_USER_ID: USER_ID }, { IG_ACCESS_TOKEN: OP_REF, IG_USER_ID: USER_ID }]) {
      const run = () => load(env, null);
      expect(run).toThrow(InstagramConfigError);
      expect(run).toThrow(/IG_ACCESS_TOKEN/);
      expect(run).toThrow(/Keychain/);
      expect(run).toThrow("security add-generic-password");
      expect(run).toThrow("op run --env-file=.env -- ");
    }
  });

  test("rejects a missing user id", () => {
    expect(() => load({ IG_ACCESS_TOKEN: "EAAtoken" })).toThrow(/IG_USER_ID/);
  });

  test("never includes the token or the op:// reference in error messages", () => {
    try {
      load({ IG_ACCESS_TOKEN: "op://Vault/secret-item/field" });
    } catch (err) {
      expect((err as Error).message).not.toContain("secret-item");
      return;
    }
    throw new Error("expected loadInstagramConfig to throw");
  });
});

describe("default Keychain reader", () => {
  test("is used when no reader is injected", async () => {
    const { readKeychainToken } = await import("./config");
    const calls: string[][] = [];
    const token = readKeychainToken((cmd) => {
      calls.push(cmd);
      return { exitCode: 0, stdout: "EAAfromsecurity\n" };
    });

    expect(token).toBe("EAAfromsecurity");
    expect(calls).toEqual([
      ["security", "find-generic-password", "-s", "quotes-engine", "-a", "ig-access-token", "-w"],
    ]);
  });

  test("returns null when the item is missing or security cannot run", async () => {
    const { readKeychainToken } = await import("./config");

    expect(readKeychainToken(() => ({ exitCode: 44, stdout: "" }))).toBeNull();
    expect(
      readKeychainToken(() => {
        throw new Error("ENOENT: security");
      }),
    ).toBeNull();
  });
});
