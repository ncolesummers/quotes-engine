# Instagram setup

quotes-engine reads posts from one Instagram professional account through the Facebook Graph API
(`https://graph.facebook.com/v24.0/{IG_USER_ID}/media`) using a **system-user token that never
expires** and only has the `instagram_basic` permission. The source of truth for the token is
1Password. A copy lives in the macOS login Keychain so unattended runs don't need 1Password or
Touch ID. The token is never written to `.env` or the repo.

`loadInstagramConfig` resolves the token in this order:

1. `IG_ACCESS_TOKEN` from the environment, if it is set and isn't an unresolved `op://`
   reference (for example, when the command runs under `op run`).
2. The Keychain item with service `quotes-engine` and account `ig-access-token`.

If neither yields a token, it throws an error that explains both options.

Steps current as of 2026-11. Meta changes this UI often.

## 1. Create the Meta app

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) and choose
   **Create App**.
2. Pick the **Manage messaging & content on Instagram** use case. Skip the business portfolio
   for now. The app is created.

## 2. Set up the Instagram API (Unified login)

1. Open **Use cases → Customize → Instagram API → API setup with Unified login**.
   New apps no longer get the "API setup with Instagram login" option.
2. This page requires a business portfolio. Link one when prompted.
3. Under **Permissions and features**, add `instagram_basic`.

## 3. Create a Facebook Login for Business configuration

Under **Facebook Login for Business → Configurations**, create a configuration with:

- Login variation: **General**
- Access token: **System-user token**, expiration **Never**
- Assets: **Instagram accounts** only
- Permissions: `instagram_basic` only

## 4. Generate the token

1. In step 1 of the API setup page, set the **Redirect URL**. It must be public HTTPS
   (localhost is rejected). We use `https://ncolesummers.github.io/quotes-engine/auth/callback`.
2. In step 2, **Add account**. This gives the Instagram account the _Instagram Tester_ role.
   Accept the invite at
   [instagram.com/accounts/manage_access/?tab=tester](https://www.instagram.com/accounts/manage_access/?tab=tester).
3. Click **Generate token** yourself (the popup is blocked if it is opened by automation).
   Choose **Continue with Instagram** and approve. Copy the token (it starts with `EAA`).

## 5. Store the token in 1Password

Save the token in the **Development** vault, item **quotes-engine Instagram**, field
`credential`. This is the source of truth.

## 6. Copy the token into the macOS Keychain

Copy it from 1Password into the login Keychain (service `quotes-engine`, account
`ig-access-token`). `printf` is a shell builtin, and `security -i` reads its command from stdin,
so the token never appears in any process's argv (and so never shows up in `ps`):

```sh
printf 'add-generic-password -U -s quotes-engine -a ig-access-token -w %s\n' \
  "$(op read "op://Development/quotes-engine Instagram/credential")" | security -i
```

`-U` updates an existing item, so run the same command again after rotating the token in
1Password. To check that the item exists without printing the token:

```sh
security find-generic-password -s quotes-engine -a ig-access-token >/dev/null && echo ok
```

## 7. Configure `.env`

See `.env.example`:

```sh
IG_USER_ID=17841407547014534
IG_GRAPH_HOST=https://graph.facebook.com
```

`IG_GRAPH_HOST` is optional and defaults to `https://graph.facebook.com`. Leave
`IG_ACCESS_TOKEN` unset to use the Keychain.

## 8. Run commands

With the Keychain item in place, commands run unattended:

```sh
bun scripts/ig-smoke.ts
```

Alternatively, skip the Keychain and inject the token from 1Password for a single run. Add
`IG_ACCESS_TOKEN="op://Development/quotes-engine Instagram/credential"` to `.env`, then run:

```sh
op run --env-file=.env -- bun scripts/ig-smoke.ts
```

The smoke script prints the account username and the newest post's id and like count. It never
prints the token.

## Troubleshooting

- **`InstagramApiError: Instagram access token is invalid or expired (OAuthException code
  190)`**: the token was revoked, or the tester role or app was removed. Generate a new token
  (step 4), update the 1Password item, then re-copy it into the Keychain (step 6). There is no
  refresh flow; system-user tokens don't expire.
- **`InstagramConfigError: No Instagram access token found`**: the Keychain item is missing
  (repeat step 6) and `IG_ACCESS_TOKEN` isn't set.
- **`graph.instagram.com` rejects the token**: expected. This is a Facebook-graph token; use
  `graph.facebook.com`.
- Rate limits (HTTP 429) and 5xx errors are retried with exponential backoff.
