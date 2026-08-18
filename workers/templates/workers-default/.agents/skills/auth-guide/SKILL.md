---
name: auth-guide
description: Guide to setting up third-party authentication for a Notion Worker. Covers brokered credentials for external-service API keys / personal access tokens, OAuth, and plaintext environment secrets only when worker code needs the value. Use when the worker needs credentials for a non-Notion API, not for Notion API tokens or `ntn login`.
user-invocable: false
---

## What this guide is for

This guide is for authentication against the **third-party service** your worker integrates with — the place data is coming from or going to (GitHub, Stripe, Salesforce, Google, Slack, etc.).

Use it when the worker needs credentials for a non-Notion API. Do not use it for Notion API tokens, `ntn login`, or general Notion workspace setup.

Never ask the user to send secret or environment-variable values in chat. For environment secrets, tell the user which variables are needed and have them enter the values directly in `.env` themselves. Do not open or print `.env` after they add them.

Most workers will use one of two auth patterns from the upstream service:

- personal API key / personal access token
- OAuth

For a personal API key / PAT, use a brokered credential unless worker code must read the plaintext value.

## Decision framework

Before recommending anything, check the provider's current developer docs. Confirm whether it offers:

- personal API keys / personal access tokens
- OAuth
- neither

Always research the provider's current auth docs on the web before advising the user. Do not rely on memory for auth availability, setup steps, or settings locations.

Then choose mechanically:

1. **Service offers personal API keys / PATs?** Recommend a brokered credential first when the credential is only used in outbound request headers to known domains. Otherwise, use the API key / PAT as an environment secret because worker code needs the plaintext value. It is usually the simplest fit for an individual-scoped worker.
2. **Service is OAuth-only?** Use OAuth.
3. **Both exist, but the worker should not depend on one person's credential or should be easy to re-auth if that person leaves?** Recommend OAuth.
4. **Service has neither?** See "When neither option is available" at the end of this guide.

State the recommendation in one sentence with the reason. Example: "Linear offers personal API keys, so use a brokered credential; it's the simplest fit and keeps the token out of the worker runtime."

## Setup: brokered credential

Pattern: declare where the credential may be injected with `worker.credential()`. The Workers service injects it into outbound request headers outside the worker runtime.

```ts
import { CREDENTIAL_VALUE } from "@notionhq/workers"

worker.credential("LINEAR_API_TOKEN", {
  network: [
    {
      domain: "api.linear.app",
      transform: [{ headers: { Authorization: CREDENTIAL_VALUE } }],
    },
  ],
})
```

Do not read a brokered credential from `process.env` or add its header in `fetch`. Deploy the declaration, then have the user set its value themselves with `ntn workers env set LINEAR_API_TOKEN=<paste token>`. Use the narrowest exact domains that work.

## Setup: API key as an environment secret

Use this fallback only when worker code must read the plaintext value, such as for webhook verification, signing or encryption, a request body or query parameter, or a non-HTTP client.

Pattern: store the credential in `.env` (or directly in the deployed worker's secrets), read it from `process.env` inside the capability's `execute`, push `.env` to the deployed worker before going live.

1. Look up the provider's current docs for creating a token. Link the user to the exact settings page when possible.

2. **Have the user add the token to `.env` themselves** (create the file if it doesn't exist), or tell them the equivalent `ntn workers env set` command. Tell them the variable name to use:

   ```
   GITHUB_API_TOKEN=<paste your token here>
   ```

   `.env` is automatically loaded for local execution (`--local`).

3. Read the token inside `execute` (this is the part you write):

   ```ts
   const token = process.env.GITHUB_API_TOKEN ?? ""

   const res = await fetch("https://api.github.com/user", {
     headers: { Authorization: `Bearer ${token}` },
   })
   ```

4. If auth seems broken, test the token outside the worker first against a simple authenticated endpoint from the provider docs. Example for GitHub:

   ```shell
   curl -H "Authorization: Bearer $GITHUB_API_TOKEN" https://api.github.com/user
   ```

5. Test locally with `ntn workers exec <capability> --local`. Confirm auth works before deploying.

6. **Push the secret to the deployed worker.** Once the token is already in `.env`, run:

   ```shell
   ntn workers env push
   ```

   If the user prefers not to keep the token in `.env`, they can use the direct-set form instead:

   ```shell
   ntn workers env set GITHUB_API_TOKEN=<paste token>
   ```

7. Tell the user how to rotate: revoke the old token at the service, generate a new one, update `.env` (or `ntn workers env set` directly), and re-push if needed.

## Setup: OAuth

`worker.oauth()` declares an OAuth capability. The runtime handles the authorization redirect, token exchange, and refresh — you call `accessToken()` inside `execute` to get a fresh token.

The user has to register an OAuth app with the provider, then plug the credentials in:

```ts
const myAuth = worker.oauth("myAuth", {
  name: "my-provider",
  authorizationEndpoint: "https://provider.example.com/oauth/authorize",
  tokenEndpoint: "https://provider.example.com/oauth/token",
  scope: "read write",
  clientId: process.env.MY_OAUTH_CLIENT_ID ?? "",
  clientSecret: process.env.MY_OAUTH_CLIENT_SECRET ?? "",
  // Optional: extra params the provider needs on the auth URL
  authorizationParams: { ... },
});
```

Setup steps:

1. **Check the provider's current OAuth docs.** Confirm the authorization endpoint, token endpoint, scopes, any extra authorization params, and how the provider wants redirect URLs configured.

2. **Register an OAuth app with the provider.** If the provider asks for a redirect URL up front and you do not have it yet, create the app shell first and come back to fill in the redirect URL after the first deploy.

3. **Have the user add credentials to `.env` themselves**, or tell them the equivalent `ntn workers env set` commands. Tell them which variable names to use:

   ```
   MY_OAUTH_CLIENT_ID=<paste client id>
   MY_OAUTH_CLIENT_SECRET=<paste client secret>
   ```

4. **Add the `worker.oauth()` declaration** to `src/index.ts`. Read `clientId`/`clientSecret` from `process.env`.

5. **Create the worker (if not already created), push secrets, and deploy.** The deployed worker reads `clientSecret` from environment variables during capability registration, so the secret must be present remotely before `deploy`. Have the user run these themselves:

   ```shell
   ntn workers create --name <name>    # if not already created
   ntn workers env push                  # push .env to remote
   # or, to set values directly without putting them in .env:
   # ntn workers env set MY_OAUTH_CLIENT_SECRET=<paste secret>
   ntn workers deploy
   ```

   **Important:** any time the client ID or client secret changes, you must redeploy (`ntn workers deploy`) — the OAuth capability binds these values at registration time, so updating env vars alone won't take effect.

6. **Get the redirect URL and have the user add it to the provider's app settings.** The redirect URL comes from the deployed worker. Get it with:

   ```shell
   ntn workers oauth show-redirect-url
   ```

   The user must paste this exact value into their OAuth app's "redirect URI" (or "authorized redirect URL", or "callback URL") setting before starting the OAuth flow. **Always remind the user of this step — OAuth will fail with a redirect mismatch error if it's missing or wrong.**

7. **Start the OAuth flow:**

   ```shell
   ntn workers oauth start <oauthCapabilityKey>
   ```

   This opens the user's browser, walks them through the provider's consent screen, and stores the resulting tokens.

8. **Use the token inside `execute`:**

   ```ts
   const token = await myAuth.accessToken()
   const res = await fetch("https://provider.example.com/v1/things", {
     headers: { Authorization: `Bearer ${token}` },
   })
   ```

   `accessToken()` returns a valid, refreshed access token. The runtime handles refresh automatically — you don't need to track expiry yourself.

### Local testing with OAuth

OAuth capabilities can be tested locally, but only after a one-time bootstrap — the access token has to exist somewhere before `accessToken()` can read it. The flow:

1. Deploy the worker, configure the redirect URL, and complete the OAuth flow once (steps 5–7 above).
2. Pull the deployed worker's env vars (which now include the OAuth access token) into local `.env`:

   ```shell
   ntn workers env pull
   ```

3. Now `ntn workers exec <key> --local` works — `accessToken()` reads the token from local `.env`.

Caveats:

- Access tokens expire. The deployed runtime auto-refreshes; your local `.env` does not. When the local token goes stale, run `ntn workers env pull` again (or, if the refresh token has also expired, redo `ntn workers oauth start <key>` then `env pull`).
- Until that first deploy + OAuth completes, you can't `--local`. Run `npm run check` for type validation, or mock `accessToken()` in a test file if you need to exercise the rest of the logic.

## Common pitfalls

1. **Hardcoded credentials in source.** Use a brokered credential, or `process.env` when worker code needs the plaintext value — never inline secrets in `src/index.ts`. Even in personal repos, committed secrets get scraped.

2. **Forgetting `ntn workers env push`.** Local works, deploy fails with auth errors. Always push secrets after changing `.env`. The deployed worker doesn't see local `.env`.

3. **Debugging worker code before testing the raw token.** If API key auth is failing, hit a simple authenticated endpoint with `curl` first so you can separate bad credentials from worker bugs.

4. **Pushing secrets after `ntn workers deploy` for OAuth.** OAuth `clientId` is read from `process.env` during capability registration — push secrets _before_ `deploy`, or use the `create` → `env push` → `deploy` sequence.

5. **Wrong redirect URL for OAuth.** `redirect_uri_mismatch` is the #1 OAuth failure mode. Always run `ntn workers oauth show-redirect-url` and verify the user has set the exact URL at the provider.

6. **Asking for too many OAuth scopes.** Request the narrowest set that works. Scope creep makes the consent screen scary and slows OAuth review for production apps.

7. **Not telling the user about manual rotation.** API keys don't refresh themselves. Tell the user up front that they'll need to rotate, and how.

## CLI reference

```shell
# Push .env secrets to the deployed worker (run after any .env change)
ntn workers env push

# Pull remote env vars into local .env (useful for OAuth: brings access tokens
# down so `ntn workers exec --local` can read them)
ntn workers env pull

# List remote env vars (without values)
ntn workers env list

# Set a single env var
ntn workers env set KEY=value

# OAuth: get the redirect URL to configure at the provider
ntn workers oauth show-redirect-url

# OAuth: start the authorization flow (opens browser)
ntn workers oauth start <oauthCapabilityKey>

# OAuth: inspect token state
ntn workers oauth token <oauthCapabilityKey>
```

## When neither option is available

If the service offers neither an API key nor an OAuth flow, the honest first answer is often that the integration isn't viable on that service.

Before giving up, there are a few **indirect paths** worth considering.

- **OAuth into a related service that already has the data.** Sometimes the data flows downstream into a place you _can_ reach with proper auth — a calendar provider, file storage, a shared workspace. Following the data to a sanctioned interface is preferable to forcing a connection at the original source.
- **Have the user export and upload.** If the service offers a manual data export (CSV/JSON), the user can drop files somewhere the worker can read (S3, Drive, etc.) and the worker syncs from there. Higher-friction but unambiguously sanctioned.
- **Pull data out of the user's own email.** If the service sends the user emails containing the data (digests, notifications, exports, receipts), OAuth into the user's own email account (Gmail, etc.) and parse those messages. The user owns the inbox, the service is sending them the data on purpose, and the email provider has a real OAuth API. Indirect but stable.
- **Use the service's own internal/frontend endpoints** (the JSON routes its web app calls). Sometimes the only thing the service exposes is the API its own UI talks to — you can authenticate as the logged-in user (session cookie, captured bearer token) and call those routes from the worker. Honest caveats: it's often flaky (the routes can change with any frontend release), it relies on credentials that probably weren't intended for programmatic use, and **the user needs to confirm this doesn't violate the service's terms of service** before doing it. Reasonable for a personal tool or hobby integration; not something to lean on for serious production use. Don't recommend it as a first choice — but if the user goes this way knowingly, help them do it carefully (sane pacers, descriptive `User-Agent`, manual credential rotation, no rate-limit evasion).

  **Tip for discovery:** ask the user to export a `.har` file from their browser's devtools (Network tab → right-click → "Save all as HAR with content"). HAR files capture every request/response the page made — URLs, methods, headers, bodies — which lets you see the exact endpoint shape without the user having to describe it.
