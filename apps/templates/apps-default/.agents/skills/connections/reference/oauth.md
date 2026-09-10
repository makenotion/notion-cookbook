# Workflow OAuth connections

Use this only when both the installed SDK and deployed server support workflow
OAuth connections. Inspect the SDK declaration for its current options.

```ts
connections.oauth({
  key: "externalService",
  authorizationEndpoint: "https://provider.example/oauth/authorize",
  tokenEndpoint: "https://provider.example/oauth/token",
  clientId: "your-oauth-client-id",
  clientSecretEnv: "EXTERNAL_SERVICE_CLIENT_SECRET",
  scope: "read",
})
```

Replace the example endpoints, client ID, and scope with the provider's
documented configuration. Store the client secret in the app's Workers secrets
under the name supplied by `clientSecretEnv`; never put its value in source.
Use HTTPS endpoints and the minimum scopes needed for the requested task.
Do not override state, callback, client ID, scope, or PKCE through additional
authorization parameters.

Authorize separately for each workflow instance through the supported setup
flow. App-level `worker.oauth` authorization and its CLI commands do not
substitute for this setup. If no workflow setup interface is available, report
that requirement rather than claiming deployment completes authorization.

Inside an awaited durable step, obtain the token with:

```ts
const token = await context.connections.oauth("externalService").accessToken()
```

Use it only for the intended provider's API, following that API's authentication
scheme. Check HTTP status and validate external response data before using it.
Never return the token from a step, log it, or include it in an error. Keep token
retrieval and the authenticated request in the same step so credentials are
not saved as step results.

The server refreshes tokens before execution; the accessor does not refresh a
token during a long-running handler. Do not fall back to another workflow's or
app-level authorization when access is missing or expired.

Return to [the connections skill](../SKILL.md) for retries and verification.
