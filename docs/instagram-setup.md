# Instagram setup

quotes-engine reads posts from one Instagram professional account through the Facebook Graph API
(`https://graph.facebook.com/v24.0/{IG_USER_ID}/media`) using a **system-user token that never
expires** and only has the `instagram_basic` permission. The token lives in 1Password; `.env`
holds only an `op://` reference, and commands run under `op run`.

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
`credential`. Then set `.env` (see `.env.example`):

```sh
IG_ACCESS_TOKEN="op://Development/quotes-engine Instagram/credential"
IG_USER_ID=17841407547014534
IG_GRAPH_HOST=https://graph.facebook.com
```

`IG_GRAPH_HOST` is optional and defaults to `https://graph.facebook.com`.

## 6. Run commands under `op run`

`op run` resolves the `op://` reference and injects the real token into the process
environment. Nothing writes the token back to disk.

```sh
op run --env-file=.env -- bun scripts/ig-smoke.ts
```

The smoke script prints the account username and the newest post's id and like count. If you
run a command without `op run`, `loadInstagramConfig` fails with a message telling you to.

## Troubleshooting

- **`InstagramApiError: Instagram access token is invalid or expired (OAuthException code
  190)`**: the token was revoked, or the tester role or app was removed. Generate a new token
  (step 4) and update the 1Password item. There is no refresh flow; system-user tokens don't
  expire.
- **`graph.instagram.com` rejects the token**: expected. This is a Facebook-graph token; use
  `graph.facebook.com`.
- Rate limits (HTTP 429) and 5xx errors are retried with exponential backoff.
