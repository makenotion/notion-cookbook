# Integrating an MCP client with Notion MCP

This tutorial walks through building an MCP client that connects to [Notion MCP](https://developers.notion.com/docs/mcp) using OAuth 2 authentication.

## Overview

Notion provides a hosted [MCP (Model Context Protocol)](https://modelcontextprotocol.io/docs/getting-started/intro) server that enables AI tools to interact with Notion workspaces. The server is available at:

- **Streamable HTTP**: `https://mcp.notion.com/mcp` (preferred, more efficient)
- **Server-Sent Events (SSE)**: `https://mcp.notion.com/sse` (fallback, broader compatibility)

Both endpoints support the same MCP protocol and OAuth authentication. Your client should try Streamable HTTP first and fallback to SSE if needed.

To connect to this server, clients must implement OAuth 2.0 authentication with PKCE (Proof Key for Code Exchange).

**Key requirements:**

- OAuth 2.0 Authorization Code flow with PKCE
- Support for Streamable HTTP (`/mcp`) or SSE (`/sse`) transports
- Token refresh handling
- Secure credential storage

## Prerequisites

> [!NOTE]
> This tutorial uses TypeScript/JavaScript examples, but the concepts apply to any programming language. The OAuth 2.0 flow, PKCE implementation, and MCP protocol are language-agnostic.

**Required libraries (TypeScript/JavaScript):**

```bash
npm install @modelcontextprotocol/sdk
npm install oauth  # or openid-client
npm install crypto  # Built-in Node.js module
```

**For TypeScript:**

```bash
npm install --save-dev @types/node
```

### Alternative libraries for other languages

**Python:**

- **MCP SDK**: [python-sdk](https://github.com/modelcontextprotocol/python-sdk) (official)
- **OAuth 2.0**: [`authlib`](https://docs.authlib.org) (recommended) or [`requests-oauthlib`](https://requests-oauthlib.readthedocs.io)
- **PKCE**: Built into both `authlib` and `requests-oauthlib`

**Go:**

- **MCP SDK**: [go-sdk](https://github.com/modelcontextprotocol/go-sdk) (official)
- **OAuth 2.0**: [`golang.org/x/oauth2`](https://pkg.go.dev/golang.org/x/oauth2) (official extended package)
- **PKCE**: Supported via `oauth2.SetAuthURLParam("code_challenge", ...)` and `oauth2.SetAuthURLParam("code_challenge_method", "S256")`

**Rust:**

- **MCP SDK**: [rust-sdk](https://github.com/modelcontextprotocol/rust-sdk) (official)
- **OAuth 2.0**: [`oauth2`](https://docs.rs/oauth2) crate
- **PKCE**: Built into `oauth2` crate via `PkceCodeChallenge` and `PkceCodeVerifier`

**Java:**

- **MCP SDK**: Use HTTP client libraries (Apache HttpClient, OkHttp, or Java 11+ `HttpClient`)
- **OAuth 2.0**: [`Spring Security OAuth2`](https://docs.spring.io/spring-security/reference/servlet/oauth2/index.html) (recommended) or [`ScribeJava`](https://github.com/scribejava/scribejava)
- **PKCE**: Built into Spring Security OAuth2 Client; supported in ScribeJava via `PKCE` configuration

**C# / .NET:**

- **MCP SDK**: Use `HttpClient` with [`System.Net.Http.Json`](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.json)
- **OAuth 2.0**: [`IdentityModel.OidcClient`](https://github.com/IdentityModel/IdentityModel.OidcClient) or [`Microsoft.Identity.Web`](https://learn.microsoft.com/en-us/azure/active-directory/develop/microsoft-identity-web)
- **PKCE**: Built into both libraries

**Ruby:**

- **MCP SDK**: Use `Net::HTTP` (standard library) or [`Faraday`](https://lostisland.github.io/faraday/)
- **OAuth 2.0**: [`oauth2`](https://github.com/oauth-xx/oauth2) gem
- **PKCE**: Supported via `oauth2` gem with appropriate configuration

### Key references

- [MCP Specification](https://spec.modelcontextprotocol.io) - Model Context Protocol standard
  - [Building an MCP client](https://modelcontextprotocol.io/docs/develop/build-client)
- [RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749) - OAuth 2.0 Authorization Framework
- [RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636) - PKCE (Proof Key for Code Exchange)
- [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414) - OAuth 2.0 Authorization Server Metadata
- [RFC 9470](https://datatracker.ietf.org/doc/html/rfc9470) - OAuth 2.0 Protected Resource Metadata
- [Notion MCP Docs](https://developers.notion.com) - Official Notion MCP documentation
- [MCP Registry](https://github.com/modelcontextprotocol/registry/tree/main/docs) - Anthropic's MCP server registry

## Step 1: OAuth discovery

Before connecting to an MCP server, discover its OAuth configuration. Given the MCP server URL (e.g., `https://mcp.notion.com/mcp`), use a standard two-step discovery process:

1. **RFC 9470**: Fetch Protected Resource Metadata to find which authorization server(s) protect this resource
2. **RFC 8414**: Fetch Authorization Server Metadata to get OAuth endpoints

### Understanding the discovery flow

**Why two steps?**

An MCP server (the protected resource) might be hosted at `mcp.example.com` but delegate authentication to a separate OAuth server at `auth.example.com`. The Protected Resource Metadata tells you where to find the authorization server, and the Authorization Server Metadata tells you the specific OAuth endpoints to use.

### Standard discovery implementation

Here's a function that implements the complete RFC 9470 → RFC 8414 discovery flow:

```typescript
type OAuthMetadata = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  code_challenge_methods_supported?: string[]
  grant_types_supported?: string[]
  response_types_supported?: string[]
  scopes_supported?: string[]
}

/**
 * Discovers OAuth configuration for an MCP server using RFC 9470 + RFC 8414.
 */
async function discoverOAuthMetadata(
  mcpServerUrl: string
): Promise<OAuthMetadata> {
  const url = new URL(mcpServerUrl)
  const protectedResourceUrl = new URL(
    "/.well-known/oauth-protected-resource",
    url
  )

  // Step 1: RFC 9470 - Get Protected Resource Metadata
  const protectedResourceResponse = await fetch(protectedResourceUrl.toString())
  if (!protectedResourceResponse.ok) {
    throw new Error(
      `Failed to fetch protected resource metadata: ${protectedResourceResponse.status}`
    )
  }

  const protectedResource = await protectedResourceResponse.json()
  const authServers = protectedResource.authorization_servers

  if (!Array.isArray(authServers) || authServers.length === 0) {
    throw new Error(
      "No authorization servers found in protected resource metadata"
    )
  }

  // Use the first authorization server
  const authServerUrl = authServers[0]

  // Step 2: RFC 8414 - Get Authorization Server Metadata
  const metadataUrl = new URL(
    "/.well-known/oauth-authorization-server",
    authServerUrl
  )
  const metadataResponse = await fetch(metadataUrl.toString())

  if (!metadataResponse.ok) {
    throw new Error(
      `Failed to fetch authorization server metadata: ${metadataResponse.status}`
    )
  }

  const metadata = (await metadataResponse.json()) as OAuthMetadata

  // Validate required fields
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new Error("Missing required OAuth endpoints in metadata")
  }

  // Warn if PKCE support isn't advertised
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    console.warn(
      "Server does not advertise S256 PKCE support, but we will use it anyway"
    )
  }

  return metadata
}
```

**What this does:**

1. Fetches Protected Resource Metadata from `https://mcp.notion.com/mcp/.well-known/oauth-protected-resource`
   - Returns: `{ "authorization_servers": ["https://..."], ... }`
2. Extracts the authorization server URL from the `authorization_servers` array
3. Fetches Authorization Server Metadata from `{authServerUrl}/.well-known/oauth-authorization-server`
   - Returns: OAuth endpoints like `authorization_endpoint`, `token_endpoint`, etc.
4. Validates that all required fields are present and warns if PKCE support isn't advertised

> [!NOTE]
> This approach is universal and works for any MCP server that follows RFC 9470 and RFC 8414 standards, not just Notion's MCP server.

## Step 2: Generate PKCE parameters

PKCE (Proof Key for Code Exchange) is mandatory for secure OAuth flows. Generate a code verifier and challenge:

```typescript
import { randomBytes, createHash } from "crypto"

function base64URLEncode(str: Buffer): string {
  return str
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "")
}

function generateCodeVerifier(): string {
  // Generate 32 random bytes = 256 bits
  // Base64 encoding produces ~43 characters
  const bytes = randomBytes(32)
  return base64URLEncode(bytes)
}

function generateCodeChallenge(verifier: string): string {
  const hash = createHash("sha256").update(verifier).digest()
  return base64URLEncode(hash)
}

// Usage
const codeVerifier = generateCodeVerifier()
const codeChallenge = generateCodeChallenge(codeVerifier)

// Store codeVerifier securely - you'll need it for token exchange
```

> [!IMPORTANT]
> The `codeVerifier` must be kept secret and never sent to the authorization server until the token exchange step. Store it securely (encrypted session, secure cookie, or in-memory with short expiry).

## Step 3: Dynamic client registration

Notion MCP server supports dynamic client registration (RFC 7591). Check if `registration_endpoint` exists in the metadata:

```typescript
type ClientRegistration = {
  client_name: string
  client_uri?: string
  redirect_uris: string[]
  grant_types: string[]
  response_types: string[]
  token_endpoint_auth_method: string
  scope?: string
}

type ClientCredentials = {
  client_id: string
  client_secret?: string
  client_id_issued_at?: number
  client_secret_expires_at?: number
}

async function registerClient(
  metadata: OAuthMetadata,
  redirectUri: string
): Promise<ClientCredentials> {
  if (!metadata.registration_endpoint) {
    throw new Error("Server does not support dynamic client registration")
  }

  const registrationRequest: ClientRegistration = {
    client_name: "Your MCP Client",
    client_uri: "https://example.com",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }

  const response = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(registrationRequest),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(
      `Client registration failed: ${response.status} - ${errorBody}`
    )
  }

  const credentials = (await response.json()) as ClientCredentials

  // Store credentials securely
  return credentials
}
```

## Step 4: Initiate authorization flow

Redirect the user to the authorization endpoint with PKCE parameters:

```typescript
function buildAuthorizationUrl(
  metadata: OAuthMetadata,
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
  state: string,
  scopes: string[] = []
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(" "),
    state: state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "consent",
  })

  return `${metadata.authorization_endpoint}?${params.toString()}`
}

function generateState(): string {
  return randomBytes(32).toString("hex")
}

// Usage
const state = generateState()
const authorizationUrl = buildAuthorizationUrl(
  metadata,
  clientId,
  redirectUri,
  codeChallenge,
  state
)

// Store state and codeVerifier in secure session storage
// Redirect user to authorizationUrl
window.location.href = authorizationUrl // Browser redirect
```

> [!WARNING]
> **Security best practices:**
>
> - Always use HTTPS for redirect URIs in production
> - Store `state` and `codeVerifier` securely (encrypted session storage)
> - Set a short expiry (10 minutes) for stored values
> - Validate `state` on callback to prevent CSRF attacks

## Step 5: Handle OAuth callback

After user authorizes, they'll be redirected back to your `redirectUri` with an authorization code:

```typescript
interface CallbackParams {
  code?: string
  state?: string
  error?: string
  error_description?: string
}

function parseCallback(url: string): CallbackParams {
  const urlParams = new URLSearchParams(new URL(url).search)

  return {
    code: urlParams.get("code") || undefined,
    state: urlParams.get("state") || undefined,
    error: urlParams.get("error") || undefined,
    error_description: urlParams.get("error_description") || undefined,
  }
}

async function handleCallback(
  callbackUrl: string,
  storedState: string,
  codeVerifier: string
): Promise<string> {
  const params = parseCallback(callbackUrl)

  if (params.error) {
    throw new Error(
      `OAuth error: ${params.error} - ${params.error_description || "Unknown error"}`
    )
  }

  if (params.state !== storedState) {
    throw new Error("Invalid state parameter - possible CSRF attack")
  }

  if (!params.code) {
    throw new Error("Missing authorization code")
  }

  return params.code
}
```

## Step 6: Exchange authorization code for tokens

Exchange the authorization code for access and refresh tokens:

```typescript
type TokenResponse = {
  access_token: string
  token_type: string
  expires_in?: number
  refresh_token?: string
  scope?: string
}

async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  metadata: OAuthMetadata,
  clientId: string,
  clientSecret: string | undefined,
  redirectUri: string
): Promise<TokenResponse> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  })

  if (clientSecret) {
    params.append("client_secret", clientSecret)
  }

  const response = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "YourApp-MCP-Client/1.0",
    },
    body: params.toString(),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Token exchange failed: ${response.status} - ${errorBody}`)
  }

  const tokens = await response.json()

  if (!tokens.access_token) {
    throw new Error("Missing access_token in response")
  }

  return tokens
}
```

> [!CAUTION]
> **Token storage security:**
>
> - **Web applications:** Store tokens server-side only, never in localStorage or cookies
> - **Desktop applications:** Use secure credential storage (Keychain on macOS, Credential Manager on Windows)
> - **Mobile applications:** Use secure keychain/keystore APIs
> - Always encrypt tokens at rest

## Step 7: Connect to MCP server with authentication

Notion's MCP server supports two transport protocols. Your client should try Streamable HTTP first and automatically fallback to SSE if needed.

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"

async function createMcpClient(
  serverUrl: string,
  accessToken: string,
  useSSE: boolean = false
): Promise<Client> {
  const client = new Client(
    {
      name: "your-mcp-client",
      version: "1.0.0",
    },
    {
      capabilities: {
        roots: {},
        sampling: {},
      },
    }
  )

  let transport

  if (useSSE) {
    transport = new SSEClientTransport(new URL(`${serverUrl}/sse`), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "YourApp-MCP-Client/1.0",
      },
    })
  } else {
    transport = new StreamableHTTPClientTransport(new URL(`${serverUrl}/mcp`), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "YourApp-MCP-Client/1.0",
      },
    })
  }

  await client.connect(transport)

  return client
}

// Usage with automatic fallback
async function connectToNotionMcp(accessToken: string): Promise<Client> {
  const serverUrl = "https://mcp.notion.com"

  try {
    return await createMcpClient(serverUrl, accessToken, false)
  } catch (error) {
    console.warn("Streamable HTTP failed, falling back to SSE:", error)
    return await createMcpClient(serverUrl, accessToken, true)
  }
}
```

## Step 8: Handle token refresh

Access tokens expire. Implement automatic refresh with proper error handling and concurrent request protection:

```typescript
async function refreshAccessToken(
  refreshToken: string,
  metadata: OAuthMetadata,
  clientId: string,
  clientSecret: string | undefined
): Promise<TokenResponse> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  })

  if (clientSecret) {
    params.append("client_secret", clientSecret)
  }

  const response = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
  })

  if (!response.ok) {
    const errorBody = await response.text()

    try {
      const error = JSON.parse(errorBody)
      if (error.error === "invalid_grant") {
        throw new Error("REAUTH_REQUIRED")
      }
      if (error.error === "invalid_client") {
        throw new Error("INVALID_CLIENT")
      }
    } catch (parseError) {
      // Not JSON error response
    }

    throw new Error(`Token refresh failed: ${response.status} - ${errorBody}`)
  }

  const tokens = await response.json()

  return tokens
}
```

> [!IMPORTANT]
> Many servers rotate refresh tokens for security (RFC 6749 Section 10.4). Always store the new `refresh_token` if provided in the response.

## Complete example: Full integration

Here's a complete example:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { randomBytes, createHash } from "crypto"

class NotionMcpClient {
  private serverUrl = "https://mcp.notion.com"
  private metadata!: OAuthMetadata
  private clientId!: string
  private clientSecret?: string
  private accessToken?: string
  private refreshToken?: string
  private client?: Client

  async initialize(redirectUri: string): Promise<void> {
    this.metadata = await discoverOAuthMetadata(this.serverUrl)
    const credentials = await registerClient(this.metadata, redirectUri)
    this.clientId = credentials.client_id
    this.clientSecret = credentials.client_secret
  }

  async startAuthFlow(redirectUri: string): Promise<string> {
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)
    const state = generateState()

    // Store these securely
    this.storeSecurely("codeVerifier", codeVerifier)
    this.storeSecurely("state", state)

    return buildAuthorizationUrl(
      this.metadata,
      this.clientId,
      redirectUri,
      codeChallenge,
      state
    )
  }

  async handleCallback(
    callbackUrl: string,
    redirectUri: string
  ): Promise<void> {
    const storedState = this.retrieveSecurely("state")
    const codeVerifier = this.retrieveSecurely("codeVerifier")

    const code = await handleCallback(callbackUrl, storedState, codeVerifier)

    const tokens = await exchangeCodeForTokens(
      code,
      codeVerifier,
      this.metadata,
      this.clientId,
      this.clientSecret,
      redirectUri
    )

    this.accessToken = tokens.access_token
    this.refreshToken = tokens.refresh_token

    // Clean up stored values
    this.deleteSecurely("state")
    this.deleteSecurely("codeVerifier")
  }

  async connect(): Promise<Client> {
    if (!this.accessToken) {
      throw new Error("Not authenticated")
    }

    try {
      this.client = await createMcpClient(
        this.serverUrl,
        this.accessToken,
        false
      )
    } catch (error) {
      console.warn("Streamable HTTP failed, falling back to SSE")
      this.client = await createMcpClient(
        this.serverUrl,
        this.accessToken,
        true
      )
    }

    return this.client
  }

  async ensureValidToken(): Promise<void> {
    if (!this.refreshToken) {
      throw new Error("No refresh token available")
    }

    try {
      const tokens = await refreshAccessToken(
        this.refreshToken,
        this.metadata,
        this.clientId,
        this.clientSecret
      )

      this.accessToken = tokens.access_token
      if (tokens.refresh_token) {
        this.refreshToken = tokens.refresh_token
      }
    } catch (error) {
      if (error instanceof Error && error.message === "REAUTH_REQUIRED") {
        throw new Error("Re-authentication required")
      }
      throw error
    }
  }

  private storeSecurely(key: string, value: string): void {
    // Implement secure storage
  }

  private retrieveSecurely(key: string): string {
    // Implement secure retrieval
    return ""
  }

  private deleteSecurely(key: string): void {
    // Implement secure deletion
  }
}
```

## Security best practices

1. **Always use HTTPS** - Never use HTTP except for localhost development
2. **Validate state parameter** - Always verify state matches stored value on callback
3. **Secure token storage** - Encrypt tokens at rest, never expose to client-side code
4. **PKCE is mandatory** - Always use PKCE even if server doesn't advertise support
5. **Token expiry handling** - Check token expiry before each request, refresh proactively
6. **Error handling** - Handle `invalid_grant` errors gracefully (re-authentication required)
7. **HTTPS verification** - Validate SSL certificates in production
8. **Rate limiting** - Implement rate limiting for token refresh to prevent abuse
9. **Scope minimization** - Only request the scopes you actually need
10. **Audit logging** - Log all OAuth operations for security auditing

## Troubleshooting

### Common issues

**"Invalid state parameter"**

- Store the state securely and validate on callback
- Expire after ~10 minutes

**"Invalid code_verifier"**

- Use the exact verifier that produced the code_challenge
- Ensure base64url encoding (no +, /, =)

**Discovery fails**

- Use RFC 9470 (protected resource) then RFC 8414 (authorization server)
- Confirm server supports OAuth and your URL is correct

**Connection timeout**

- Prefer Streamable HTTP; fall back to SSE
- Check proxy or firewall rules

**CORS in browser**

- Do token exchange server-side; browser should only handle redirects

### Token refresh fails with `invalid_grant`

> [!NOTE]
> **Notion MCP OAuth specifics**
>
> Notion's remote MCP server implementation uses [Cloudflare's `workers-oauth-provider` package](https://github.com/cloudflare/workers-oauth-provider). Note these characteristics:
>
> - **Token expiry**: Access tokens expire after one hour.
> - **Refresh token rotation**: At any time a grant may have two valid refresh tokens. When the client uses one, the other is invalidated and a new refresh token is issued
>   - If you correctly switch to the returned `refresh_token` each time, older tokens are continuously invalidated
>   - If a transient failure prevents updating the stored token, you can retry the request with the previously stored token once
>   - With concurrent refreshes, only the first succeeds and later attempts may receive `invalid_grant`

When refresh returns `{ "error": "invalid_grant" }`, the refresh token is invalid, expired, revoked, or superseded by rotation. Do not retry refresh; prompt re-authentication.

**Causes and fixes:**

1. **Rotation on use**
   - Providers rotate refresh tokens and revoke the old one
   - **Fix**: Persist the new `refresh_token` atomically with the access token

2. **Expired refresh token**
   - Often 30–90 days
   - **Fix**: Re-authenticate; monitor early expirations

3. **Client credential mismatch**
   - `client_id` or `client_secret` differs from initial auth
   - **Fix**: Keep credentials consistent for the token's lifetime

4. **Explicit revocation or policy event**
   - User revoked access, password change, or security policy
   - **Fix**: Show clear reconnect UI

5. **Concurrent refreshes**
   - Parallel refreshes cause losers to see `invalid_grant`
   - **Fix**: Use a mutex or distributed lock around refresh

**Operational guidance:**

- `invalid_grant` → re-authenticate
- `temporarily_unavailable` or network errors → retry with backoff
- Refresh 5–10 minutes before expiry to avoid races
- Cache access tokens with accurate expiry

### Minimal refresh helper

```typescript
async function refreshAccessToken(
  refreshToken: string,
  metadata: OAuthMetadata,
  clientId: string,
  clientSecret?: string
) {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  })
  if (clientSecret) params.append("client_secret", clientSecret)

  const res = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
  })

  const body = await res.text()
  if (!res.ok) {
    try {
      const err = JSON.parse(body)
      if (err.error === "invalid_grant") throw new Error("REAUTH_REQUIRED")
    } catch {}
    throw new Error(`Token refresh failed: ${res.status} - ${body}`)
  }

  const tokens = JSON.parse(body)
  return tokens as TokenResponse
}
```

## Additional resources

- [Notion MCP Server GitHub](https://github.com/makenotion/notion-mcp-server)
- [MCP SDK Documentation](https://github.com/modelcontextprotocol/sdk)
- [Notion MCP Developer Docs](https://developers.notion.com)
- [RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749), [RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636), [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414), [RFC 9470](https://datatracker.ietf.org/doc/html/rfc9470)
