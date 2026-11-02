import { describe, expect, test } from "bun:test";
import { InstagramConfigError, loadInstagramConfig } from "./config";

const USER_ID = "17841407547014534";

describe("loadInstagramConfig", () => {
  test("reads token, user id and host from the environment", () => {
    const config = loadInstagramConfig({
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
    expect(loadInstagramConfig({ IG_ACCESS_TOKEN: "EAAtoken", IG_USER_ID: USER_ID }).host).toBe(
      "https://graph.facebook.com",
    );
    expect(
      loadInstagramConfig({ IG_ACCESS_TOKEN: "EAAtoken", IG_USER_ID: USER_ID, IG_GRAPH_HOST: " " })
        .host,
    ).toBe("https://graph.facebook.com");
  });

  test("trims whitespace around values", () => {
    const config = loadInstagramConfig({
      IG_ACCESS_TOKEN: " EAAtoken\n",
      IG_USER_ID: ` ${USER_ID} `,
    });

    expect(config.token).toBe("EAAtoken");
    expect(config.userId).toBe(USER_ID);
  });

  test("rejects an unresolved 1Password reference and says to use op run", () => {
    const run = () =>
      loadInstagramConfig({
        IG_ACCESS_TOKEN: "op://Development/quotes-engine Instagram/credential",
        IG_USER_ID: USER_ID,
      });

    expect(run).toThrow(InstagramConfigError);
    expect(run).toThrow("op run --env-file=.env -- ");
  });

  test("rejects a missing token", () => {
    expect(() => loadInstagramConfig({ IG_USER_ID: USER_ID })).toThrow(/IG_ACCESS_TOKEN/);
    expect(() => loadInstagramConfig({ IG_ACCESS_TOKEN: "", IG_USER_ID: USER_ID })).toThrow(
      InstagramConfigError,
    );
  });

  test("rejects a missing user id", () => {
    expect(() => loadInstagramConfig({ IG_ACCESS_TOKEN: "EAAtoken" })).toThrow(/IG_USER_ID/);
  });

  test("never includes the token in error messages", () => {
    try {
      loadInstagramConfig({ IG_ACCESS_TOKEN: "op://Vault/secret-item/field" });
    } catch (err) {
      expect((err as Error).message).not.toContain("secret-item");
      return;
    }
    throw new Error("expected loadInstagramConfig to throw");
  });
});
