# Vercel approved deployment promotion

Promote one exact, staged Vercel production deployment only while its Notion
approval, Git identity, current production owner, Deployment Checks, and fixed
health checks still match an operator-owned policy. The tool then reconciles
the exact complete production-domain set and writes a compact receipt back to the
approval page.

This is a governed release outcome, not a convenience wrapper around
`vercel promote`. It is deliberately unable to choose a deployment, accept a
URL from an agent, bypass a failed check, rebuild, force, roll back, or retry an
unobserved mutation.

## When to use this tool

Use `promoteApprovedDeployment` when a Notion Custom Agent should execute an
already-approved production cutover and return one durable, machine-readable
result. The approval page and server-side allowlist remain authoritative; the
agent repeats their exact values but cannot widen them.

Do not use it for preview deployments, selecting a release candidate,
progressive or rolling releases, automatic rollback, or projects with more
than 20 production domains. Those outcomes need separate review and a distinct
tool contract.

Also do not use it for bulk promotions, long-running release orchestration or
monitoring, actions that require the model to judge which candidate or risk is
acceptable, or unscoped project/account changes. Split those workflows into
bounded review and execution tools with explicit human authority.

Realistic requests that should trigger this tool are:

- “Promote the checkout release approved on this Notion release page. Show me
  the exact deployment and current production deployment, then ask before you
  execute.”
- “The `release-42.7` approval is ready. Move its staged Vercel deployment to
  production only if the recorded SHA, branch, checks, health paths, and current
  deployment still match.”
- “Resume operation `vpa_4bcbe90c4e39db80e8bdc41bc63a98d1`. Reconcile it;
  do not send another promotion request if the outcome is unknown.”

## Why this Worker exists

As audited on **2026-07-03**, Vercel's hosted MCP server can list and inspect
projects and deployments and create ordinary deployments, but its published
tool inventory does not expose project promotion, promotion reconciliation,
rollback, or rolling-release operations. Vercel's REST API exposes the raw
promotion request, project aliases, deployments, and checks separately. This
Worker composes those APIs with Notion approval verification, durable
coordination, health gates, reconciliation, and receipt writeback.

Prefer Vercel's hosted MCP server for exploratory or flexible inspection of
projects and deployments. Its native read tools are the better fit when an
agent needs to discover, compare, or explain provider state without performing
this narrowly approved compound cutover.

For the agent, the positioning is:

> Promote this exact Notion-approved staged Production deployment only while
> its pinned release evidence remains valid, then return an authoritative,
> resumable receipt.

For the maintainer, the boundary is equally important: keep provider reads,
policy validation, the one-way mutation boundary, durable state, and receipt
semantics separate. A raw `requestPromote` tool would not preserve the outcome.

## Safety contract

Before the single promotion request, the Worker verifies all of the following
twice under a project-wide lease:

- The Notion page is active, its explicit `Approval revision` is unchanged,
  its status is exactly `Approved`, and its stored SHA-256 fingerprint matches
  the canonical approval fields. The Worker-owned receipt property is empty on
  both fresh preflight reads.
- The exact `team_` and `prj_` IDs are allowlisted in Worker configuration.
- The exact `dpl_` deployment belongs to that team and project, targets
  `production`, is `READY`, and has `readySubstate=STAGED`.
- The deployment's full Git SHA and branch equal the approval packet.
- Vercel's complete provider-reported production alias set exactly equals the
  fixed policy: no extra, missing, or duplicate production alias exists, and
  every domain still points to the approved previous deployment.
- Every configured stable Deployment Check ID resolves once, its optional
  pinned name still matches, and its run for this deployment is
  `completed`/`succeeded`. The aggregate deployment check state must also be
  `completed`/`succeeded`.
- Check completion is no older than one hour by default, not older than the
  deployment, and not implausibly in the future.
- Every fixed health path returns 2xx from the canonical `vercel.app` or
  `now.sh` deployment hostname without following redirects.

The Worker then sends exactly one
`POST /v10/projects/{projectId}/promote/{deploymentId}`. Accepted responses,
HTTP 409, 5xx, connection loss, and timeouts cross into read-only
reconciliation. They never trigger an automatic second POST. HTTP 400, 401,
403, and 429 are the closed definite-rejection set; 429 returns bounded
`Retry-After` metadata and a safe resume token. Every other status—including
unexpected 2xx, 3xx, 404, and 408—crosses the mutation boundary and can only be
reconciled, never blindly re-armed.

Every Vercel API fetch uses the fixed `api.vercel.com` origin with manual
redirect handling. A 3xx response is surfaced as an ambiguous mutation outcome;
Fetch cannot follow a 307/308 and silently send a second promotion POST.

Success requires the complete provider-reported production alias set to equal
the fixed policy exactly, every alias to point to the candidate, and the
deployment to become `READY`/`PROMOTED`. The
Worker deliberately does not call the advisory “last promote aliases” API;
that response has no operation ID and cannot strengthen the authoritative
project/deployment observation.

One call follows this sequence:

1. Validate the bounded input and resolve one exact server-side target policy.
2. Acquire the Redis project lease and read the durable operation record.
3. Read the Notion approval and Vercel project, deployment, stable check
   definitions, and deployment check runs.
4. Gate the approval, identity, staged state, expected production owner,
   check freshness/conclusions, and fixed deployment health paths.
5. Persist prepared intent, renew the lease, and repeat every mutable read and
   health gate immediately before the write.
6. Persist `mutation_started`, renew the token-owned lease again after that
   durable write, then send the one allowed promotion POST.
7. Poll authoritative current project/deployment state; classify convergence,
   conflict, partial failure, or ambiguity.
8. On convergence, recheck health, renew the lease, re-observe provider state,
   then persist `receipt_pending`, write only the configured Notion rich-text
   property, read it back, and re-observe provider state once more before
   success.
9. Persist a non-expiring completed record and return the typed receipt.

## Notion approval page

Create these properties on the approval page's database. Names and types are
part of the recipe contract.

| Property                         | Type             | Required value                    |
| -------------------------------- | ---------------- | --------------------------------- |
| `Approval status`                | Status or select | Exactly `Approved`                |
| `Approval revision`              | Rich text        | Immutable release revision token  |
| `Vercel team ID`                 | Rich text        | Exact `team_...` ID               |
| `Vercel project ID`              | Rich text        | Exact `prj_...` ID                |
| `Vercel deployment ID`           | Rich text        | Exact staged `dpl_...` ID         |
| `Git SHA`                        | Rich text        | Lowercase full 40- or 64-char SHA |
| `Git branch`                     | Rich text        | Exact branch                      |
| `Expected current deployment ID` | Rich text        | Exact current `dpl_...` ID        |
| `Approval fingerprint`           | Rich text        | Canonical lowercase SHA-256       |
| `Promotion receipt`              | Rich text        | Empty; Worker-owned               |

The fingerprint is SHA-256 over this exact compact JSON field order:

```json
{
  "approvalStatus": "Approved",
  "approvalRevision": "release-42.7",
  "teamId": "team_example",
  "projectId": "prj_example",
  "deploymentId": "dpl_candidate",
  "gitSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "gitBranch": "main",
  "expectedCurrentDeploymentId": "dpl_previous"
}
```

For example, save the JSON as `packet.json` and calculate the lowercase digest:

```zsh
node --input-type=module -e 'import{createHash}from"node:crypto";import{readFileSync}from"node:fs";const p=JSON.parse(readFileSync("packet.json","utf8"));const c=JSON.stringify({approvalStatus:p.approvalStatus,approvalRevision:p.approvalRevision,teamId:p.teamId,projectId:p.projectId,deploymentId:p.deploymentId,gitSha:p.gitSha,gitBranch:p.gitBranch,expectedCurrentDeploymentId:p.expectedCurrentDeploymentId});process.stdout.write(createHash("sha256").update(c).digest("hex")+"\n")'
```

The command parses either compact or pretty-printed JSON, then reconstructs the
Worker's exact field order before hashing. Writing a receipt changes Notion's
`last_edited_time`, so replay safety uses the explicit `Approval revision`
property instead.

## Vercel and Redis prerequisites

Use a dedicated Vercel automation identity. On Enterprise, prefer a
project-scoped Contributor with Project Developer and the Full Production
Deployment extended permission. On plans without equivalent project-level
scoping, document that the token may have broader team access. Do not use an
owner token. Scope the access token to only the owning team; Vercel access
tokens are not project-scoped, so the acting identity's project role enforces
the project boundary.

| Capability or credential               | Acting identity                              | Least privilege                                                                                   | Model exposure                                                                                |
| -------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Notion approval read and receipt write | Custom Agent caller through `context.notion` | Share only the approval database/pages the agent may release; allow page read and property update | The model may read approval fields and the returned receipt; it never receives a Notion token |
| Vercel API token                       | Dedicated Worker automation user             | Target project only, Project Developer, plus Full Production Deployment where available           | Secret environment value; never an input, output, URL, provider error, or log field           |
| Redis REST token                       | Dedicated Worker coordination database       | Isolate the database to this Worker; permit only the required key operations operationally        | Secret environment value; never returned to the model                                         |
| Protection bypass secret               | Vercel project automation bypass identity    | Configure only when staged health endpoints are protected; rotate independently                   | Sent only in the fixed health-request header; never returned to the model                     |
| Approval page content                  | Human approver/editor                        | Limit editors to release approvers; keep the receipt property Worker-owned                        | Visible to the agent only when the page is in its Notion access scope                         |

Create a dedicated Upstash-compatible Redis REST database for this Worker. Its
token is a coordination credential, not an agent input. The Worker uses:

- `SET key token NX PX ttl` for the project-wide lease;
- token-checked Lua `PEXPIRE` and `DEL` for renewal and release;
- a stable operation key derived from the approval and target identities;
- expiring prepared records, plus non-expiring records after the mutation
  boundary and for completed operations.

If Redis is unavailable, acquisition or renewal fails closed before any new
mutation. A provider/Notion reconstruction path can restore a missing
completed record without another POST.

The lease TTL is longer than the worst uninterrupted bounded preflight. The
Worker renews before and after durable record writes, after `mutation_started`
and immediately before POST, around every reconciliation observation, around
final health/provider verification, and around receipt writeback. Losing the
token at any fence stops the current invocation; token-checked release cannot
delete a newer owner's lease.

## Configure and deploy

Workers require Node.js 22 and npm 10.9.2 or newer.

```zsh
npm install --global ntn
cd workers/vercel-promote-approved-deployment
npm ci
npm run format:check
npm run check
npm test
npm run build
ntn login
ntn workers deploy --name vercel-promote-approved-deployment
```

Set secrets and fixed policy on the deployed Worker:

```zsh
ntn workers env set VERCEL_ACCESS_TOKEN=replace-with-dedicated-token
ntn workers env set UPSTASH_REDIS_REST_URL=https://example.upstash.io
ntn workers env set UPSTASH_REDIS_REST_TOKEN=replace-with-redis-token
ntn workers env set VERCEL_PROMOTION_TARGETS_JSON='[{"teamId":"team_example","projectId":"prj_example","productionDomains":["app.example.com"],"deploymentChecks":[{"id":"check_example","name":"Integration tests"}],"healthPaths":["/healthz"]}]'
```

If Vercel Deployment Protection covers the staged hostname, set its separate
automation bypass secret. This credential bypasses multiple protection layers
for every deployment in the project, so rotate it independently and never put
it in an agent prompt or approval page.

```zsh
ntn workers env set VERCEL_PROTECTION_BYPASS_SECRET=replace-with-bypass-secret
```

Optional settings are:

| Variable                                 | Default            | Bound                   |
| ---------------------------------------- | ------------------ | ----------------------- |
| `NOTION_PROMOTION_RECEIPT_PROPERTY`      | Receipt name above | 100 chars               |
| `VERCEL_PROMOTION_POLL_TIMEOUT_MS`       | `90000`            | 5,000–90,000 ms         |
| `VERCEL_PROMOTION_LEASE_TTL_MS`          | `120000`           | 90,000–300,000 ms       |
| `VERCEL_PROMOTION_OPERATION_TTL_SECONDS` | `604800`           | 1 hour–30 days prepared |
| `VERCEL_PROMOTION_CHECK_MAX_AGE_MS`      | `3600000`          | 1 minute–1 hour         |

The JSON policy allows 1–20 team/project pairs. `team_`, `prj_`, and `dpl_`
identifiers are capped at 100 characters including their prefix. Each policy allows 1–20
production domains, 1–20 stable check IDs, and 1–5 health paths. Health paths
are path-only values of at most 256 characters; callers cannot supply a URL,
headers, method, check list, domain list, or health path.

The recipe intentionally has no pagination loop. Configured check IDs and
domains are hard bounded before any API request. The current project response
is the authoritative complete production-alias inventory used for preflight
and every reconciliation. At most 100 total project aliases are inspected; a
larger provider inventory blocks before mutation or remains bounded and
ambiguous after mutation, without retaining alias values. The advisory
promotion-alias endpoint is not called.

## Limits and time budgets

Reconciliation stops when either 30 observations have started or the configured
poll deadline (90 seconds by default) has passed. A started observation is
allowed to finish, so a final set of bounded read retries can extend elapsed
poll time beyond the nominal deadline; it cannot start observation 31.

For the largest valid policy and a fresh call that reaches all 30 observations,
including a final verification failure on every observation, the code permits
at most:

- 293 logical Vercel requests: 132 API reads, one promotion POST, and 160 fixed
  health requests. Each API read can make at most three HTTP attempts, while
  each promotion or individual health request has no hidden transport retry,
  for a hard ceiling of 557 Vercel HTTP requests.
- Six logical Notion requests: three approval reads, receipt pre-read, one
  property update, and receipt readback.
- 177 logical Redis REST commands, including token-checked lease fences around
  durable writes, reconciliation, final verification, and release.

Vercel API, Redis, and Notion requests each have a 10-second attempt timeout;
each fixed health request has a 5-second timeout. Idempotent Vercel reads have
two retries with bounded backoff. Mutation, Redis, Notion, and health requests
have no hidden retry. There is no unbounded loop or unbounded page scan. If the
Notion Workers runtime enforces a shorter overall execution ceiling, the
persisted operation state makes the exact call resumable without an unobserved
second promotion.

Malformed bounded strings and valid-but-unallowlisted team/project pairs return
a schema-valid `blocked` receipt before coordination. The current Worker schema
format supports UUID validation directly; the remaining length and identifier
patterns are enforced by the runtime boundary and reflected in field
descriptions.

## Connect and call the tool

In Notion, add the deployed Worker to a Custom Agent under **Tools and access >
Add connection**. Give the agent access to the approval database. The Worker
uses the pre-authenticated Notion client from the tool context; do not add a
second Notion token.

The tool explicitly publishes `readOnlyHint: false`. Notion therefore treats
it as an action tool; keep user confirmation enabled in the Custom Agent.

Paste the following instruction into the Custom Agent:

```text
When a user asks to promote a Vercel release, first read the referenced Notion approval page. Extract Approval revision, Approval fingerprint, Vercel team ID, Vercel project ID, Vercel deployment ID, Git SHA, Git branch, and Expected current deployment ID exactly; never normalize, shorten, infer, or substitute them. Summarize the candidate deployment, SHA/branch, expected current deployment, and approval revision, then obtain explicit user confirmation before calling promoteApprovedDeployment. Call the tool at most once for that confirmation. Do not call when Approval status is not exactly Approved, a required field is missing, the user asks you to choose a deployment, the request is for preview/rollback/force/rolling release, or confirmation is absent. Interpret every non-success receipt from retryable, retryAfterMs, and repairInstruction rather than from the status name alone. If retryable is true, explain the receipt, wait at least retryAfterMs when present, and call again with the exact same nine inputs only after the user explicitly asks to resume. If retryable is false, do not repeat the call until a human completes repairInstruction and explicitly confirms a new call; treat conflict as terminal and require a new approval for any new promotion. Retain resumeToken only as correlation evidence. Never pass resumeToken as a tool argument, change an approval revision to bypass a result, or invoke another Vercel mutation tool for the same release.
```

The agent should read the approval page, repeat the exact nine inputs, call the
tool once after user confirmation, and interpret the structured receipt. It
must reuse the same nine inputs for reconciliation; `resumeToken` is output-only
correlation evidence, not an accepted argument. It must branch on `retryable`
for every status and never invent a new revision to work around a blocked
result.

For a sandbox-only live smoke test, create a local environment file and keep it
out of deployed Worker state:

```zsh
cp .env.example .env
chmod 600 .env
${EDITOR:-vi} .env
```

Fill `.env` only with disposable sandbox values. In addition to the Vercel,
Redis, policy, and optional protection-bypass values shown in the example, set
`NOTION_API_TOKEN` to a sandbox Notion internal-integration token. In Notion,
share only the disposable approval page or its test database with that
integration before executing the command. The token is needed by `--local`
to construct `context.notion`; it is not read by the deployed Worker. Never run
`ntn workers env set NOTION_API_TOKEN=...` for this recipe—the deployed tool
uses the Custom Agent's pre-authenticated Notion context instead.

Then execute locally:

```zsh
ntn workers exec promoteApprovedDeployment --local -d '{"approvalPageId":"11111111-1111-4111-8111-111111111111","approvalRevision":"release-42.7","approvalFingerprint":"replace-with-64-char-digest","teamId":"team_example","projectId":"prj_example","deploymentId":"dpl_candidate","expectedGitSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expectedGitBranch":"main","expectedCurrentDeploymentId":"dpl_previous"}'
```

This command can move production traffic. Use only a disposable Vercel project,
test domains, a test Notion approval page, and test credentials.

A successful sandbox call should return `status: "completed"`, `ok: true`, the
candidate as `currentDeploymentId`, five completed steps, canonical records,
and `receiptWritten: true`. A second identical call should return
`status: "no_op"`, `changed: false`, `replay: true`, and issue zero promotion
POSTs.

After the smoke test, verify the receipt in Notion and restore or remove the
test domains through the normal Vercel sandbox process. Delete temporary
deployments and the approval row if no longer needed. Remove the integration's
share from the page/database, revoke the sandbox Notion integration token,
revoke the temporary Vercel token and protection-bypass secret, and delete the
sandbox Redis database (or its `vercel-promotion:*` keys) and token. Finally,
remove local secrets and the sample packet:

```zsh
unset NOTION_API_TOKEN
rm -f .env packet.json
```

This Worker never performs cleanup or rollback.

## Receipt contract

Every returned object includes `ok`, `idempotencyKey`, `changed`, `replay`,
`preconditionsVerified`, canonical `records` with IDs/URLs/actions, per-step
`steps`, `warnings`, `retryable`, `retryAfterMs`, `resumeToken`, and
`repairInstruction`, plus the verified Vercel and approval identities.

Example request:

```json
{
  "approvalPageId": "11111111-1111-4111-8111-111111111111",
  "approvalRevision": "release-42.7",
  "approvalFingerprint": "29628dfae54e80c44bbb59c46645d45a580fb0972a677b889963dd94721c9988",
  "teamId": "team_acme",
  "projectId": "prj_checkout",
  "deploymentId": "dpl_candidate",
  "expectedGitSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "expectedGitBranch": "main",
  "expectedCurrentDeploymentId": "dpl_previous"
}
```

Example completed receipt:

```json
{
  "ok": true,
  "operationId": "vpa_4bcbe90c4e39db80e8bdc41bc63a98d1",
  "idempotencyKey": "vpa_4bcbe90c4e39db80e8bdc41bc63a98d1",
  "status": "completed",
  "changed": true,
  "replay": false,
  "preconditionsVerified": true,
  "promotionRequested": true,
  "receiptWritten": true,
  "records": [
    {
      "kind": "approval",
      "system": "notion",
      "id": "11111111-1111-4111-8111-111111111111",
      "url": "https://www.notion.so/11111111111141118111111111111111",
      "action": "receipt_written",
      "state": "verified"
    },
    {
      "kind": "project",
      "system": "vercel",
      "id": "prj_checkout",
      "url": "https://api.vercel.com/v9/projects/prj_checkout?teamId=team_acme",
      "action": "verified",
      "state": "current:dpl_candidate"
    },
    {
      "kind": "deployment",
      "system": "vercel",
      "id": "dpl_candidate",
      "url": "https://checkout-abc.vercel.app",
      "action": "promoted",
      "state": "completed"
    },
    {
      "kind": "production_domain",
      "system": "vercel",
      "id": "app.example.com",
      "url": "https://app.example.com",
      "action": "routed",
      "state": "target"
    }
  ],
  "steps": [
    { "name": "approval", "state": "completed" },
    { "name": "preflight", "state": "completed" },
    { "name": "promotion", "state": "completed" },
    { "name": "reconciliation", "state": "completed" },
    { "name": "receipt", "state": "completed" }
  ],
  "warnings": [],
  "retryable": false,
  "retryAfterMs": null,
  "resumeToken": null,
  "repairInstruction": null,
  "teamId": "team_acme",
  "projectId": "prj_checkout",
  "deploymentId": "dpl_candidate",
  "deploymentUrl": "checkout-abc.vercel.app",
  "previousDeploymentId": "dpl_previous",
  "currentDeploymentId": "dpl_candidate",
  "gitSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "gitBranch": "main",
  "approvalPageId": "11111111-1111-4111-8111-111111111111",
  "approvalRevision": "release-42.7",
  "approvalFingerprint": "29628dfae54e80c44bbb59c46645d45a580fb0972a677b889963dd94721c9988",
  "checkIds": ["check_integration"],
  "checkNames": ["Integration tests"],
  "healthPaths": ["/healthz"],
  "productionDomains": ["app.example.com"],
  "startedAt": "2026-07-03T14:00:00.000Z",
  "completedAt": "2026-07-03T14:00:08.000Z",
  "message": "The exact approved deployment owns the exact complete production-domain set and the Notion receipt is recorded."
}
```

| Status            | Meaning                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `completed`       | Domains converged and Notion readback confirmed the receipt.     |
| `no_op`           | Live provider state, health, and receipt prove prior completion. |
| `blocked`         | No accepted mutation; fix policy, credentials, state, or lease.  |
| `conflict`        | A different deployment owns the exact complete domain set.       |
| `partial_failure` | Aliases split, final health failed, or receipt work remains.     |
| `ambiguous`       | Outcome is not authoritative; resume performs reads only.        |

`completed` and `no_op` are the only `ok=true` results. A retryable result has
a non-null resume token. The token is the stable operation ID, not a secret.
Redis and Vercel credentials, protection bypass values, provider bodies, and
arbitrary response text never appear in output or logs.

## Failure and resume behavior

- A second caller for the same project receives `blocked` while the lease is
  held. Lease expiry and ownership are enforced by Redis, not by a Notion row.
- The mutation record is followed by a fresh lease renewal immediately before
  POST. Final health, provider re-observation, Notion writeback, and completed
  persistence are fenced by the same token-owned lease.
- A crash after durable `mutation_started` but before a response can only enter
  reconciliation. The same operation cannot send another POST.
- HTTP 409, timeout, reset, and 5xx are reconciled against project aliases and
  deployment state before any result is returned.
- Split aliases or an extra, missing, or duplicate production alias produce
  `partial_failure`; another unanimous deployment on an exact set produces
  `conflict`; unchanged previous aliases produce `ambiguous`.
- Promotion success followed by Notion failure stores `receipt_pending`. A
  replay verifies production and writes only the receipt.
- Notion writeback is read after write. Missing or mismatched readback remains a
  partial failure.
- Provider state is observed again after receipt readback. Drift or an
  unavailable final read returns `partial_failure` with `receiptWritten=true`
  and never triggers another POST.
- Once the canonical receipt is confirmed, later drift reconciliation and
  coordination failures preserve `receiptWritten=true`; a receipt-pending
  replay re-reads the exact canonical receipt before its provider observation,
  so a Vercel read failure cannot erase that evidence.
- A live conflict remains terminal even if its durable reconciliation write
  fails: `retryable=false`, no resume token, and a new approval is required for
  any new promotion.
- If the final durable `complete` write fails after the canonical receipt and
  provider state are confirmed, the result remains `partial_failure` with
  `receiptWritten=true`; resumption rebuilds persistence without another POST.
- A completed replay still verifies live approval, provider state, health, and
  the receipt before returning `no_op`. A later rollback returns the live
  deployment as `conflict`; a removed receipt is restored only after provider
  verification, without POST.
- Completed records are persistent. If one is lost, reconstruction always
  revalidates the exact provider deployment, Git SHA/branch, aliases, and
  health. An exact canonical stored receipt proves prior completion; without
  one, fresh Deployment Check evidence is also required before the Worker may
  write a replacement receipt. Non-canonical or occupied receipt content fails
  closed without POST.

External dashboard, CLI, and unrelated credentials do not participate in the
Redis lease. The Worker therefore re-reads approval and Vercel state immediately
before mutation and treats any later divergence as a conflict or partial state.

| Scenario                                                                                              | Mutation behavior                                     | Receipt/status                                                              | Safe next action                                                               |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Approval revision, status, packet, or fingerprint is stale                                            | Zero POST                                             | `blocked`, `changed=false`                                                  | Repair or create a genuinely new human approval revision                       |
| Project, exact production-alias set, deployment, Git, current owner, check, or health evidence drifts | Zero POST                                             | `blocked`, `changed=false`                                                  | Investigate provider state; do not weaken the approval                         |
| Vercel returns 403                                                                                    | One definitely rejected POST; no reconciliation retry | `blocked`, non-retryable                                                    | Repair acting-identity scope, then explicitly run the same operation           |
| Vercel returns 409                                                                                    | One POST maximum, followed by reads                   | Converged result, otherwise `ambiguous`, `conflict`, or `partial_failure`   | Resume the same operation; never issue an independent promote                  |
| Vercel returns 429                                                                                    | One definitely rejected POST                          | `blocked`, retryable, bounded `retryAfterMs`                                | Wait the stated interval and explicitly resume                                 |
| Vercel definitely rejects but Redis cannot persist the prepared retry state                           | One definitely rejected POST                          | Truthful `blocked`, `promotionRequested=true`, with original retry metadata | Restore Redis, then follow the returned repair instruction                     |
| Vercel responds but Redis becomes unavailable before reconciliation                                   | One POST maximum; durable `mutation_started` remains  | `ambiguous`, retryable, phase-safe diagnostic                               | Restore Redis and resume the exact operation; it cannot send another POST      |
| A pre-mutation Vercel/Notion/Redis read times out                                                     | Zero POST                                             | `blocked`                                                                   | Retry only after the dependency recovers; all gates run again                  |
| The promotion response times out or the socket resets                                                 | One POST maximum, then reads                          | `completed` if observed; otherwise `ambiguous`                              | Retain the token as correlation evidence and resume with the same nine inputs  |
| Production aliases split                                                                              | No second POST                                        | `partial_failure`                                                           | Repair Vercel alias state manually, then resume reconciliation                 |
| Another deployment owns all domains                                                                   | No second POST                                        | `conflict`                                                                  | Investigate the external promotion and require a new approval for a new action |
| Candidate owns production but final health or verification fails                                      | No second POST                                        | `partial_failure`, `changed=true`                                           | Do not promote again; investigate the incident, then resume read-only checks   |
| Promotion converges but Notion write or readback fails                                                | No second POST                                        | `partial_failure`, durable `receipt_pending`                                | Resume; the Worker writes and verifies only the receipt                        |
| Receipt/provider confirmation succeeds but final Redis completion write fails                         | No second POST                                        | `partial_failure`, `receiptWritten=true`                                    | Restore Redis and resume; never promote again                                  |
| A completed replay observes rollback or receipt removal                                               | Zero POST                                             | Live `conflict`, or verified receipt repair                                 | Investigate rollback; never reuse the completed approval for another promote   |
| A receipt-only resume succeeds                                                                        | Zero POST                                             | `completed`, `receiptWritten=true`                                          | No further action; later calls are `no_op`                                     |

## Staged deployment caveat and sandbox qualification

This Worker does **not** require `project.autoAssignCustomDomains=false`.
Vercel's manual staged-deployment guidance commonly disables automatic domain
assignment at project level, while `vercel deploy --prod --skip-domain`
documents a per-deployment path. The observable safety condition is the exact
deployment's `target=production`, `READY`, and `readySubstate=STAGED`, together
with an unchanged, exact complete production-alias set.

Vercel's public documentation does not explicitly guarantee every interaction
between `--prod --skip-domain`, all Deployment Check types, and the checks-v2
API. Before adopting this Worker, qualify the behavior in a non-critical
project:

1. Run `vercel deploy --prod --skip-domain` for a test commit.
2. Confirm the deployment API reports production, `READY`, and `STAGED` while
   test production domains still point to the previous deployment.
3. Confirm the project check-definition API returns every configured stable
   check ID, the deployment run API returns completed/succeeded runs, and the
   deployment aggregate is also completed/succeeded.
4. Run the Worker and verify every test domain, final deployment state, and
   Notion receipt.

Native Deployment Checks were introduced in 2026. Their complete coverage in
checks-v2 is not stated for every check type, which is why the Worker requires
both configured run evidence and deployment aggregate evidence. Re-run this
qualification when changing check providers or Vercel project behavior.

## Code map and maintenance

| Path              | Responsibility                                      |
| ----------------- | --------------------------------------------------- |
| `src/index.ts`    | Strict tool input and output schemas                |
| `src/config.ts`   | Secret loading, policy parsing, and hard bounds     |
| `src/approval.ts` | Canonical approval hash and safe receipt readback   |
| `src/redis.ts`    | REST operation records and token-owned lease        |
| `src/vercel.ts`   | Fixed-origin API client, gates, health, observation |
| `src/promote.ts`  | Durable state machine and receipt semantics         |
| `src/types.ts`    | Typed provider, operation, and public contracts     |
| `test/`           | Deterministic mocked API and reliability cases      |

Keep new release outcomes separate. For example, a rolling release or automatic
rollback changes authority, concurrency, and receipt semantics and should not
be added as a mode flag. If Vercel adds operation IDs or conditional promotion,
adopt them without removing the current project-wide lease and pre-mutation
revalidation until their concurrency guarantees are explicit.

## Verification

Offline verification uses no live Notion, Vercel, or Redis credentials:

```zsh
npm ci
npm run format
npm run format:check
npm run check
npm test
npm run build
```

Tests cover strict schemas, typed validation failures, all six receipt statuses,
approval drift, allowlist and identity failures, stale/failed/missing checks,
post-promotion health incidents, final provider drift, Redis
acquisition/contention/expiry/ownership and overlap fencing, provider
401/403/404/409/429/5xx and transport loss, one-POST enforcement, alias
conflicts, completed-record rollback and receipt removal, lost operation
records, receipt-only resume, Notion write failure/readback, hard bounds,
malicious inputs, and credential/error redaction.

## Official references

API and native-workflow audit date: **2026-07-03**.

- [Vercel MCP tool inventory](https://vercel.com/docs/agent-resources/vercel-mcp/tools)
- [Vercel MCP overview and authorization](https://vercel.com/docs/agent-resources/vercel-mcp)
- [Point production traffic to a deployment](https://vercel.com/docs/rest-api/projects/point-production-traffic-to-a-given-deployment)
- [Get a project](https://vercel.com/docs/rest-api/projects/find-a-project-by-id-or-name)
- [Get a deployment](https://vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url)
- [List project checks](https://vercel.com/docs/rest-api/checks-v2/list-all-checks-for-a-project)
- [List deployment check runs](https://vercel.com/docs/rest-api/checks-v2/list-check-runs-for-a-deployment)
- [Promoting a deployment](https://vercel.com/docs/deployments/promoting-a-deployment)
- [Deployment Checks](https://vercel.com/docs/deployment-checks)
- [`vercel deploy --skip-domain`](https://vercel.com/docs/cli/deploy)
- [Native Deployment Checks announcement](https://vercel.com/changelog/native-deployment-checks)
- [Vercel API access tokens](https://vercel.com/kb/guide/how-do-i-use-a-vercel-api-access-token)
- [Vercel extended permissions](https://vercel.com/docs/rbac/access-roles/extended-permissions)
- [Protection bypass for automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)
- [Notion agent tool guide](https://developers.notion.com/workers/guides/tools)
- [Notion API client in Workers](https://developers.notion.com/workers/guides/api-client)
