# Publish an approved GitHub release from Notion

Publish one exact reviewed GitHub draft release, verify that the approved gates
still hold, and write the authoritative shipping receipt back to its Notion
release packet.

This Worker exposes one write tool: `publishPreparedRelease`.

## Example requests

- “Publish the v1.2.3 draft that release packet 7 approved, then record what
  shipped on the packet.”
- “The release manager approved this exact tag, commit, notes, checks, and
  asset manifest. Publish release 987654 as latest.”
- “Resume the approved release operation. GitHub published, but the Notion
  receipt failed last time.”

Do not invoke it to draft or edit a release, write release notes, select a
commit, create or move a tag, bypass a check, explore GitHub, or infer approval.
Those decisions must happen before the call.

## Why this is an Agent Tool

The agent or human decides _what_ should ship and approves a structured packet.
The Worker owns the invariant operating procedure: verify the Notion approval,
claim one release operation, authenticate to one allowlisted repository, read
the exact draft/tag/commit/assets/checks, re-read every precondition, publish,
reconcile the terminal release, checkpoint durable state, and write the Notion
receipt. Asking a model to choose what to do between those fixed calls adds
latency and creates opportunities to omit a gate or switch resources.

This is not a thin wrapper around `PATCH /releases/{id}`. The single PATCH is
the small, externally visible center of a governed cross-system procedure.

### Why not GitHub's remote MCP?

Audit date: **2026-07-03**.

GitHub's official hosted MCP server currently documents release reads—list
releases, get the latest release, and get a release by tag—but no release
create, update, or publish tool. It has broad issue, pull request, Projects,
Actions, security, and notification coverage, but no one-call equivalent of
this approval-gated publication plus Notion receipt. See the
[official server and tool inventory](https://github.com/github/github-mcp-server)
and [GitHub MCP toolset documentation](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/configure-toolsets).

Use GitHub MCP for exploration and flexible repository interaction. Use the
native GitHub UI or `gh release edit` when a person is intentionally performing
an ad hoc release. If your organization already has an approved Actions
workflow that implements the complete gate, replay, reconciliation, and
writeback procedure, prefer dispatching and observing that workflow rather
than duplicating it here. The generic MCP Actions trigger is not itself that
procedure.

Notion's preconfigured GitHub MCP connection also uses the credentials of the
person who authenticates the connection, which other authorized users of the
agent can indirectly invoke. This Worker instead uses a documented shared
GitHub App installation identity (recommended) or a fine-grained PAT. Review
that delegated authority before attaching the tool. See [MCP connections for
Custom Agents](https://www.notion.com/help/mcp-connections-for-custom-agents)
and [Notion's GitHub connection](https://www.notion.com/help/github).

## What happens in one call

1. Validate bounded semantic input and recalculate the canonical packet
   fingerprint. Resolve the configured owner/repository to its immutable
   allowlisted numeric repository ID.
2. Read durable operation state in an Upstash-compatible Redis REST database.
   Atomically claim a 120-second lease scoped to **numeric repository ID +
   release ID** with `SET NX PX`. State remains separately keyed to the exact
   approval.
3. Read the Notion packet through the invocation-scoped `context.notion`
   client. Require its configured status, approval revision, fingerprint, and
   an empty receipt property. An exact canonical spent receipt enters
   read-only reconciliation; any other content conflicts.
4. Make the first GitHub read `GET /repos/{owner}/{repo}` and require both the
   configured numeric ID and name. Then read the exact release ID, its complete
   asset manifest, existing tag ref (peeling at most three annotated tags),
   release target, full commit, and required App-bound check-runs.
5. Renew the token-owned lease, repeat the authoritative GitHub reads, then
   make the final Notion approval/receipt read the last external precondition.
   The release must still be a draft and the approval must still be current.
6. Renew the lease, durably close the operation in `mutation_unknown`, and
   renew once more to fence that checkpoint. Only then send exactly one
   `PATCH /repos/{owner}/{repo}/releases/{release_id}` with
   `{ "draft": false, "make_latest": ... }`.
7. Re-read the exact release and tag after success, timeout, retryable server
   failure, or `409`. A retry from `mutation_unknown` is reconciliation-only
   and can never send PATCH again. When `makeLatest` is `"true"`, also require
   `GET /releases/latest` to return the same numeric release ID.
8. Persist the published checkpoint, assign a compact JSON receipt to the
   packet's rich-text receipt property, read that property back, then persist
   the completed receipt. A spent-receipt replay instead confirms both systems
   by reads and persists completion directly, without a provider write. A
   token-checked Redis `EVAL` releases the lease.

GitHub is the source of truth for release publication; the approved Notion
packet is the source of truth for authorization and expected content. The two
systems are not one atomic transaction.

## Agent-facing instructions

Use `publishPreparedRelease` only when:

- a human has explicitly approved the packet's current revision and canonical
  fingerprint;
- the call contains one configured owner/repository and exact numeric release
  ID—not a URL or search query;
- an existing tag and both the release target and tag resolve to one approved
  full commit SHA;
- the exact draft name/body hashes, prerelease flag, complete asset manifest,
  and required terminal gates are known; and
- the caller wants the release published now and expects a Notion receipt.

Do not use it when approval is implied by conversation, a check is pending,
the tag must be created or moved, release content must be edited, the target is
not allowlisted, more than one release is involved, or model judgment is needed
between steps. Ask for the missing approval or use GitHub/MCP read tools first.

Pasteable Custom Agent instruction:

> Call `publishPreparedRelease` only after I explicitly approve the exact
> release packet revision and canonical fingerprint. Never invent or alter a
> repository, release ID, tag, commit, hash, check, asset, prerelease setting,
> or latest-release policy. Confirm the exact release and external visibility
> before the call. Treat `conflict`, `blocked`, `partial_failure`, and
> `ambiguous` as non-success; present the receipt and repair instruction, and
> retry only with the identical approved input when `retryable` is true.

The tool is a write tool (`readOnlyHint: false`), so normal Custom Agent policy
asks for confirmation unless the agent's settings deliberately change that
behavior.

## Tool contract

All schema fields are required; nullable is used only for receipt repair
fields.

| Input                      | Meaning and bound                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approvalPageId`           | One Notion page UUID.                                                                                                                             |
| `approvalRevision`         | Exact rich-text revision value; 1–160 UTF-8 bytes.                                                                                                |
| `approvalFingerprint`      | Lowercase SHA-256 of the canonical packet below.                                                                                                  |
| `repository`               | One configured `owner/repository`; never a URL.                                                                                                   |
| `releaseId`                | One positive numeric draft-release ID.                                                                                                            |
| `tag`                      | Existing exact tag in a safe subset; at most 128 UTF-8 bytes.                                                                                     |
| `targetCommit`             | Full lowercase 40-character commit SHA.                                                                                                           |
| `nameSha256`, `bodySha256` | Exact SHA-256 of the raw UTF-8 strings returned by GitHub; null is hashed as the empty string. No whitespace or line-ending normalization occurs. |
| `prerelease`               | Exact approved flag; the Worker verifies but does not change it. A prerelease cannot request `makeLatest: "true"`.                                |
| `makeLatest`               | GitHub enum `"true"`, `"false"`, or `"legacy"`; always sent explicitly.                                                                           |
| `requiredChecks`           | 1–20 exact successful check-runs, each bound to its positive GitHub App ID. Same-name runs from a different App do not satisfy the gate.          |
| `requiredAssets`           | Exact complete manifest of 0–100 filenames, byte sizes, and SHA-256 digests. Extra assets conflict.                                               |

The canonical fingerprint is SHA-256 over a deterministic JSON object containing
version `1`, normalized packet page ID, approval revision, normalized repository,
release ID, tag, target commit, both content hashes, prerelease/latest policy,
checks sorted by kind/name/app ID, and assets sorted by name. The fingerprint
field itself is excluded. To calculate it from a local JSON input file:

```sh
npm run fingerprint -- ./packet.json
```

Store the printed value in the packet's fingerprint property and send the same
value as `approvalFingerprint`. The helper reads only the named local file and
does not write it.

Example input (identifiers and hashes are intentionally fake):

```json
{
  "approvalPageId": "550e8400-e29b-41d4-a716-446655440000",
  "approvalRevision": "release-approval-7",
  "approvalFingerprint": "8c6f9b3c3ef4a6e40123456789abcdef0123456789abcdef0123456789abcdef",
  "repository": "example-org/release-sandbox",
  "releaseId": 987654,
  "tag": "v1.2.3",
  "targetCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "nameSha256": "ef12ef12ef12ef12ef12ef12ef12ef12ef12ef12ef12ef12ef12ef12ef12ef12",
  "bodySha256": "cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34",
  "prerelease": false,
  "makeLatest": "true",
  "requiredChecks": [{ "kind": "check_run", "name": "build", "appId": 15368 }],
  "requiredAssets": [
    {
      "name": "app.tar.gz",
      "sizeBytes": 512,
      "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
  ]
}
```

Terminal `status` is one of `completed`, `no_op`, `blocked`, `conflict`,
`partial_failure`, or `ambiguous`. Every result has the same strict shape:
operation and idempotency IDs, `changed`, `replay`, observed publication,
canonical records, per-step state, warnings, retryability, a nullable bounded
`retryAfterSeconds`, and nullable resume and repair fields. Raw provider
payloads are never returned.

Example success receipt:

```json
{
  "ok": true,
  "status": "completed",
  "operationId": "ghrel_0123456789abcdef01234567",
  "idempotencyKey": "github-release:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "changed": true,
  "replay": false,
  "published": true,
  "records": [
    {
      "system": "github",
      "kind": "release",
      "id": "987654",
      "url": "https://github.com/example-org/release-sandbox/releases/tag/v1.2.3",
      "action": "published"
    },
    {
      "system": "notion",
      "kind": "release_packet",
      "id": "550e8400e29b41d4a716446655440000",
      "url": "https://www.notion.so/550e8400e29b41d4a716446655440000",
      "action": "receipt_written"
    }
  ],
  "steps": [
    {
      "name": "publish_release",
      "status": "completed",
      "detail": "Publication confirmed by authoritative read-back"
    },
    {
      "name": "notion_receipt",
      "status": "completed",
      "detail": "Authoritative receipt written"
    }
  ],
  "warnings": [
    "GitHub provides no conditional release PATCH; tag rules and immutable releases reduce but do not eliminate the final tag-move race."
  ],
  "retryable": false,
  "retryAfterSeconds": null,
  "resumeToken": null,
  "repair": null
}
```

## Replay and failure behavior

| Scenario                                            | Result and safe next action                                                                                                                                                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Completed replay                                    | Durable receipt returns as `no_op`, `changed: false`, `replay: true`; no GitHub or Notion call.                                                                                                                                          |
| Concurrent identical call                           | Resource lease returns retryable `conflict`; wait for the named TTL/active call and retry identical input.                                                                                                                               |
| Different approval for same release                 | It contends on the same numeric-repository/release lease, preventing two approvals from both acting on `draft: true`.                                                                                                                    |
| Stale status/revision/fingerprint                   | `conflict`; zero GitHub writes. Create a new explicit approval and fingerprint.                                                                                                                                                          |
| Receipt is occupied by other content                | `conflict` before PATCH. Only empty content authorizes a fresh mutation; the exact canonical receipt for this operation is the sole accepted spent value.                                                                                |
| Canonical spent receipt exists                      | Provider-read-only reconciliation: no GitHub PATCH or Notion update. A matching published release is adopted; a draft or mismatch requires investigation and a new approved revision.                                                    |
| Changed release/tag/target/content/assets/gates     | `conflict`; zero GitHub writes. Never “fix” the provider from this tool.                                                                                                                                                                 |
| GitHub `401`/`403`                                  | `blocked`, normally not retryable; repair App/PAT identity or permissions. Provider text is redacted.                                                                                                                                    |
| GitHub `404`                                        | `blocked`, not blindly retried; check the allowlist, App installation, and exact release.                                                                                                                                                |
| GitHub `409` during PATCH                           | No second PATCH. Re-read exact release ID; success only if it is observably published and exact, otherwise `ambiguous`.                                                                                                                  |
| GitHub primary/secondary rate limit                 | Parse `Retry-After` or primary `X-RateLimit-Reset`; recognize GitHub's secondary-limit response and otherwise use 60 seconds. Return a typed delay capped at 86,400 seconds. PATCH is not retried.                                       |
| Retryable GitHub `5xx`                              | Safe GET retries once. A PATCH response is reconciled by reads, never blindly repeated.                                                                                                                                                  |
| Timeout before mutation                             | Safe read retries once, then retryable `blocked`; zero PATCH calls.                                                                                                                                                                      |
| Timeout after PATCH                                 | Re-read exact release ID. If published and exact, continue; if read-back cannot decide, return retryable `ambiguous`.                                                                                                                    |
| Crash/lease loss after mutation boundary            | Durable stage remains `mutation_unknown`. Every identical retry is read-only reconciliation, even when GitHub still shows a draft; use a new approved revision after investigating rather than rearming this approval.                   |
| Published but post-PATCH checkpoint drifted         | Minimal exact-release read reports `partial_failure`, `published: true`, and the observed release. It is never downgraded to an unpublished precondition conflict.                                                                       |
| Published, Redis checkpoint unavailable             | `partial_failure`, `published: true`, canonical release record. Restore Redis and retry identical input; the durable mutation boundary prevents another PATCH.                                                                           |
| Published, Notion writeback fails                   | Durable stage remains `published`; return `partial_failure` and resume token. Identical retry skips PATCH and transient branch/latest/gate/Approved-state checks, verifies the immutable checkpoint, and resumes only receipt writeback. |
| Notion update times out after applying              | Read back the exact receipt property; do not send a second update when it matches.                                                                                                                                                       |
| GitHub and Notion complete, final Redis write fails | `partial_failure` with both records. Restore Redis and retry; only durable finalization remains.                                                                                                                                         |

The logical idempotency key hashes normalized repository, release ID, packet
page, explicit revision, and approved input fingerprint. Redis stores operation
state without an expiry. The lease is a separate resource-scoped key using
`SET NX PX`; renew and release use token-comparing Lua `EVAL` scripts. If Redis
is unavailable before publication, the Worker fails closed.

The durable `mutation_unknown` stage is written before PATCH and is
non-rearmable. It deliberately sacrifices automatic reuse of the same approval
after a crash between checkpoint and request in exchange for an at-most-once
publication attempt. The durable `published` checkpoint contains the exact
numeric identities, release URL, tag, target commit, content hashes, prerelease
flag, and GitHub publication timestamp. Receipt-only recovery re-verifies that
does not re-authorize publication: it intentionally ignores a branch that has
advanced, a later release becoming latest, completed checks changing retention
state, and an approval status transitioning to Published/Done. It still binds
the Notion page ID, approval revision, fingerprint, and exact empty/matching
receipt property before writeback.

## Quickstart

Prerequisites:

- Node.js 22+, npm 10.9.2+, and the `ntn` CLI.
- A Notion database page with the properties in the next section and edit
  access granted to the Custom Agent.
- A GitHub App installation (recommended) or fine-grained PAT, one sandbox
  repository, an exact draft release, and an existing protected tag.
- An Upstash-compatible Redis REST database. This is required; a Notion row is
  not a concurrency-safe operation lock.

Install and validate offline:

```sh
cd workers/github-publish-prepared-release
npm ci
npm run format:check
npm run check
npm test
npm run build
```

Deploy and configure:

```sh
npm install --global ntn
ntn login
ntn workers deploy --name github-publish-prepared-release
ntn workers env set GITHUB_ALLOWED_REPOSITORIES_JSON='[{"repository":"example-org/release-sandbox","repositoryId":123456789}]'
ntn workers env set GITHUB_AUTH_MODE=installation
ntn workers env set GITHUB_APP_CLIENT_ID=Iv1.example
ntn workers env set GITHUB_APP_INSTALLATION_ID=12345678
ntn workers env set GITHUB_APP_PRIVATE_KEY_BASE64='<single-line base64 PEM>'
ntn workers env set UPSTASH_REDIS_REST_URL=https://example.upstash.io
ntn workers env set UPSTASH_REDIS_REST_TOKEN='<token>'
```

Then add the deployed Worker to a Custom Agent under **Tools and access > Add
connection** and apply the agent instruction above. Do not commit `.env`,
private keys, PATs, Redis tokens, generated Worker state, or `workers.json`.

### Notion packet properties

Defaults are configurable through `.env.example`:

| Property               | Supported type     | Required value before call                                                                                                                |
| ---------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `Approval status`      | Status or select   | Exactly `Approved` (configurable).                                                                                                        |
| `Approval revision`    | Rich text or title | Explicit stable revision such as `release-approval-7`; do not use `last_edited_time`, because receipt writeback edits the page.           |
| `Approval fingerprint` | Rich text or title | Exact canonical SHA-256.                                                                                                                  |
| `Release receipt`      | Rich text          | Empty for a fresh mutation. The exact canonical spent receipt permits read-only reconciliation; every other pre-existing value conflicts. |

The Worker uses the invocation-scoped Notion client; deployed agent calls need
no extra Notion token. Local `ntn workers exec --local` needs a Notion PAT or
internal integration token in `NOTION_API_TOKEN` plus page access because the
platform client is not injected locally. Never deploy that extra token for the
invocation-scoped path.

Notion page properties do not support compare-and-set. A competing writer can
race between the pre-read, update, and post-read. The Worker only reports the
receipt written when immediate authoritative read-back exactly matches; a
different observed value is a conflict. This detects a winning race but cannot
promise permanent non-overwrite against a later writer, so restrict edits to
the packet workflow.

## Permissions and secrets

| System              | Permission                   | Why                                                                                                    | Boundary                                                                                                         |
| ------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| GitHub App          | Metadata read                | Verify immutable repository identity.                                                                  | Token is minted for exactly the configured numeric repository ID.                                                |
| GitHub App          | Contents write               | GitHub's release-update endpoint requires it; it also covers release/tag/commit/asset reads used here. | Broader than release-only authority; install the App only on release repositories and protect branches/tags.     |
| GitHub App          | Checks read                  | Read required check-runs and exact App IDs.                                                            | Names and App IDs come from the approved packet; max 20 gates.                                                   |
| Notion Custom Agent | Read/update packet page      | Verify approval and write one receipt property.                                                        | Invocation-scoped client has the agent's page permissions; share only the packet database.                       |
| Redis REST token    | Read/write selected database | Atomic lease and durable operation state.                                                              | Use a dedicated database/token and TLS origin; state contains metadata and receipts, never provider credentials. |

GitHub App installation authentication is preferred because it provides a
stable service identity, installation scoping, expiring tokens, and centralized
revocation. The code asks GitHub for each installation token restricted to the
one numeric repository ID plus the permissions above. The App installation ID
itself should cover only allowlisted repositories.

For local evaluation, set `GITHUB_AUTH_MODE=pat` and `GITHUB_TOKEN` to a
fine-grained PAT restricted to the same repository and permissions. A PAT acts
as its owning user, does not become an independent service identity, and must
be inventoried, rotated, and revoked when that person or environment changes.
It is not the recommended unattended production credential.

Secrets stay in Worker environment variables and authorization headers. They
are never accepted as tool input, stored in Notion/Redis operation state, logged,
or returned. Provider response bodies are drained and redacted. Agent-visible
input does include asset filenames, gate names/App IDs, hashes, repository,
tag, commit, and packet identity; do not place secrets in those fields. Release
body/name content is compared by hash and is not copied into the receipt.

## Local and sandbox verification

Normal validation is deterministic and credential-free:

```sh
npm ci
npm run format:check
npm run check
npm test
npm run build
```

The tests assert exact cross-system request ordering, final approval placement,
headers and PATCH count; immutable repository identity; stale approval/provider
preconditions; check App identity on draft and uncheckpointed published
adoption; asset/check pagination; primary and secondary rate-limit delays;
`403`, `404`, `409`, `429`, `5xx`, header and body timeouts; redaction; Redis
contention/expiry/token ownership, the non-rearmable mutation boundary, and
corrupt nested state; completed and spent-receipt replay; output schema for
every terminal status; ambiguous GitHub/Notion writes and competing receipt
assignment; stable receipt-only resume; and Redis failures at all durable
checkpoints.

Opt-in destructive sandbox smoke test (not run as part of cookbook validation):

1. Use a private disposable repository and dedicated Notion/Redis test data.
   Enable a tag ruleset that blocks update/delete for the release tag and allow
   bypass only for the release App if your process needs it. Enable immutable
   releases if suitable for the repository.
2. Create and push one test commit and existing tag. Upload no more than 100
   draft assets, record their GitHub digest/size, and create one successful check
   with its exact App ID. Create the draft release manually or through your
   existing preparation process.
3. Create the four Notion properties, calculate the packet fingerprint with
   `npm run fingerprint -- ./packet.json`, store it, and set status to Approved.
4. Copy `.env.example` to `.env`. Set only sandbox credentials, including
   `NOTION_API_TOKEN` for the local invocation, then run:

   ```sh
   ntn workers exec publishPreparedRelease --local -d "$(tr -d '\n' < packet.json)"
   ```

5. Expect `status: "completed"`, `published: true`, one GitHub release record,
   one Notion packet record, and the same operation ID in Redis and Notion. Run
   the identical command again and expect `status: "no_op"`, `changed: false`,
   and no new PATCH.
6. Derive the two exact Redis keys from the returned `idempotencyKey`, configured
   numeric repository ID, and release ID. Inspect them before deleting only
   those keys (the lease should already be absent after a completed call):

   ```sh
   IDEMPOTENCY_KEY='github-release:<64-hex-digest-from-receipt>'
   REPOSITORY_ID='123456789'
   RELEASE_ID='987654'
   STATE_KEY="notion-cookbook:github-release:v1:${IDEMPOTENCY_KEY}:state"
   LEASE_KEY="notion-cookbook:github-release:v1:repository:${REPOSITORY_ID}:release:${RELEASE_ID}:lease"

   curl --silent --show-error "$UPSTASH_REDIS_REST_URL" \
     --header "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
     --header 'Content-Type: application/json' \
     --data "[\"MGET\",\"$STATE_KEY\",\"$LEASE_KEY\"]"

   curl --silent --show-error "$UPSTASH_REDIS_REST_URL" \
     --header "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
     --header 'Content-Type: application/json' \
     --data "[\"DEL\",\"$STATE_KEY\",\"$LEASE_KEY\"]"
   ```

   Then archive/delete only the sandbox release and tag according to your
   policy and remove the Notion test page. Deleting a release cannot recall
   workflows or consumers already triggered by publication, so never use a
   production target for this test.

7. After the Redis deletion succeeds, remove the local secret file and clear
   any values that may have been exported into the current shell. This removes
   `.env`, not the committed `.env.example`:

   ```sh
   rm -f -- .env
   unset NOTION_API_TOKEN GITHUB_TOKEN GITHUB_APP_PRIVATE_KEY_BASE64
   unset UPSTASH_REDIS_REST_TOKEN UPSTASH_REDIS_REST_URL
   unset IDEMPOTENCY_KEY REPOSITORY_ID RELEASE_ID STATE_KEY LEASE_KEY
   ```

   Finally, revoke the temporary Notion integration token (or delete the
   temporary integration), revoke the sandbox fine-grained GitHub PAT, and
   rotate/delete the sandbox Redis REST token in their provider consoles. If
   the smoke test used a dedicated GitHub App instead of a PAT, remove its
   sandbox repository access and delete its temporary private key. If it used a
   disposable Redis database, delete that database after confirming the exact
   keys above are gone. Local deletion alone does not revoke provider-side
   credentials.

## Limits and when not to use

- Exactly one packet, repository, release, tag, and commit per call.
- 1–20 App-bound gates and up to 300 observed check-runs across at most three
  pages.
- 0–100 exact assets. A second page that raises the count above 100 conflicts.
- At most three annotated-tag dereferences and 50 GitHub calls per invocation.
- GitHub API requests and their response bodies, plus GitHub App token requests,
  time out after eight seconds. Notion reads, updates, and read-backs time out
  after ten seconds. Safe GitHub reads get at most two total attempts. Redis
  requests time out after three seconds. PATCH is one attempt.
- Approval values, tag/check/asset names, output records/steps, and receipt size
  are bounded in code. The Notion receipt is at most 2,000 UTF-8 bytes, and a
  reported retry delay is capped at 86,400 seconds.
- The public Workers documentation does not publish a total wall-clock or CPU
  guarantee; this recipe bounds provider calls instead of claiming one.

Do not use it for bulk releases, long-running deployments, draft creation,
release-note generation, mutable/unprotected tags, arbitrary URLs, unscoped
repositories, or a workflow that requires model judgment after validation.
GitHub MCP is better for exploratory reads and flexible interaction.

### Residual publication race

GitHub documents no idempotency key or conditional precondition header for the
release-update PATCH. The Worker therefore re-reads the tag/release immediately
before PATCH, requires both the existing tag and release target to resolve to
the full approved SHA, holds a durable resource lease, sends one PATCH, and
reconciles afterward. Another sufficiently privileged actor can still move the
tag in the small interval between the final read and PATCH. Use repository tag
rulesets to restrict create/update/delete and bypass, and consider immutable
releases. Those controls reduce the race; this Worker does not claim to make
the GitHub operations atomic.

Publishing can immediately trigger `release: published` Actions workflows and
external consumers. There is no rollback of those effects even if someone
later edits or deletes the release.

For `makeLatest: "true"`, the Worker verifies the repository's observable
latest release ID. GitHub release reads do not expose the historical
`make_latest: false` or `legacy` request intent, so those modes return a warning
and the Worker claims only that the exact release is published—not that the
original intent is independently observable afterward.

## Extension points

- Replace the static JSON repository/ID map with a reviewed configuration
  source, but preserve immutable ID binding and exact per-token repository
  downscoping.
- If gate provenance requirements change, preserve an immutable producer
  identity; do not accept name-only commit statuses as an equivalent gate.
- Add a separate side-effect-free preparation/preview tool only if your process
  has a real human approval boundary. Do not add `dryRun` to this write tool.
- Add post-publication Jira/Linear/announcement adapters only as independently
  idempotent stages after the durable `published` checkpoint. Keep publication
  usable without them and add receipt fields/tests for every adapter.
- Swap Redis for another store only when it implements atomic resource-scoped
  first claim, token-owned lease renewal/release, and durable operation state.
  A normal Notion row lookup is not equivalent.

## Project map

```text
src/
  index.ts            Worker registration and strict input/output schemas
  orchestrator.ts     gated publish, replay, reconciliation, and writeback
  github.ts           bounded GitHub REST client and provider preconditions
  ledger.ts           Redis REST state plus SET-NX/token-EVAL lease
  notion.ts           approval reads and idempotent receipt assignment
  policy.ts           bounds, canonical fingerprint, and identities
  auth.ts             GitHub App installation token or PAT fallback
  config.ts           repository-ID allowlist and environment validation
  types.ts            receipt, packet, and durable-state types
  fingerprint-cli.ts  local read-only fingerprint helper
test/                  deterministic boundary and orchestration tests
```

## Official references

- [Notion Workers overview](https://developers.notion.com/workers/get-started/overview)
- [Notion Worker tools](https://developers.notion.com/workers/guides/tools)
- [Notion Worker schemas](https://developers.notion.com/workers/reference/schema)
- [Using the Notion API from a Worker](https://developers.notion.com/workers/guides/api-client)
- [GitHub MCP server and inventory](https://github.com/github/github-mcp-server)
- [GitHub MCP toolsets](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/configure-toolsets)
- [GitHub Releases REST API](https://docs.github.com/en/rest/releases/releases?apiVersion=2026-03-10)
- [GitHub release assets REST API](https://docs.github.com/en/rest/releases/assets?apiVersion=2026-03-10)
- [GitHub check-runs REST API](https://docs.github.com/en/rest/checks/runs?apiVersion=2026-03-10)
- [Git references REST API](https://docs.github.com/en/rest/git/refs?apiVersion=2026-03-10)
- [Git tag objects REST API](https://docs.github.com/en/rest/git/tags?apiVersion=2026-03-10)
- [Repository REST API](https://docs.github.com/en/rest/repos/repos?apiVersion=2026-03-10)
- [GitHub App installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- [GitHub App best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)
- [Fine-grained PAT management](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [GitHub REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
- [About GitHub releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
- [Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
- [Ruleset rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [Actions release event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release)
- [`gh release edit`](https://cli.github.com/manual/gh_release_edit)
- [Upstash Redis REST API](https://upstash.com/docs/redis/features/restapi)
- [Redis `SET` options (`NX`, `PX`)](https://upstash.com/docs/redis/sdks/ts/commands/string/set)
- [Redis `EVAL`](https://upstash.com/docs/redis/sdks/ts/commands/scripts/eval)
- [Contribute to this cookbook](../../CONTRIBUTING.md)
