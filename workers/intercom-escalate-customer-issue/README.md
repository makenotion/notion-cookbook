# Escalate an approved Intercom customer issue to Jira

Turn one approved Intercom ticket or conversation into one correctly routed Jira
issue—or one deterministic enrichment of its mapped issue—then leave an internal
link in Intercom and a canonical receipt in Notion.

This recipe is deliberately narrower than “connect Intercom to Jira.” It is for
support escalations where a human has approved the engineering packet and the
team needs one governed, replay-safe transaction instead of several loosely
coordinated agent calls.

Example requests that should invoke `escalateCustomerIssue`:

- “Escalate the approved Enterprise checkout conversation to ENG.”
- “Attach this approved Intercom ticket to ENG-417 and route it to engineering.”
- “Resume the exact partial escalation on this approval page; do not create a
  second issue.”

Do not invoke it to decide whether a customer report is a bug, choose a Jira
project or issue type, summarize a raw transcript, send a customer reply, upload
attachments, bulk-escalate records, or bypass a changed approval/source.

## The one-call outcome

The agent or human decides the meaning once: summary, impact, environment,
reproduction, severity, optional account context, and whether a known Jira issue
is the approved destination. The Worker then performs only invariant plumbing:

1. Re-read the active Notion page and verify its status, explicit revision,
   canonical packet, and SHA-256 fingerprint.
2. Verify the configured Intercom workspace/admin and Jira account identities.
3. Fetch the exact Intercom API record, contact, company association, state,
   SLA, tags, assignment, bounded parts, and safe attachment metadata.
4. Acquire an atomic Redis source lease and a permanent source-to-issue claim.
5. Re-read Notion and Intercom immediately before the Jira boundary.
6. Create one Jira issue with a deterministic label/entity property, or add one
   marker comment to the already mapped issue. Jira has no general create
   idempotency key, so an uncertain create is reconciled by that label/property
   and is never blindly repeated.
7. Independently re-read and apply the configured Intercom tag, team assignment,
   and internal note. The note payload is statically `message_type: "note"`;
   the tool has no customer-comment code path.
8. Re-read Intercom and require the exact tag, team, and internal note; create a
   permanent Redis receipt proof bound to the mapping and current target policy;
   then write the compact Notion receipt and read it back.

The Notion approval page is the authority boundary before writes. Intercom is
authoritative for the current support record. Redis is authoritative for source
mapping, mutation progress, and permanent completion proof. Jira is
authoritative for the engineering issue. The editable Notion receipt is only a
human-visible mirror: the Worker never treats it as completion without the
exact permanent Redis proof and mapping.

## Why this is an Agent Tool

The agent is good at determining impact and turning customer evidence into an
approved issue packet. It adds no value between the fixed identity checks,
atomic claim, Jira mutation, Intercom routing, marker reconciliation, and
receipt writeback. Exposing those primitives separately increases latency and
lets a partial failure create duplicate issues or customer-visible mistakes.

`escalateCustomerIssue` is one recognizable support outcome with one human
approval. It is not a thin Jira create wrapper:

- one source is permanently mapped to one engineering issue;
- many different Intercom sources can intentionally map to the same approved
  Jira issue;
- revised approvals enrich that mapped issue once rather than remapping it;
- provider state and authority are re-read before mutation;
- ambiguous writes become reconciliation-only;
- tag, routing, note, and receipt repair independently after partial success;
- the permanent proof binds the receipt to the exact approval, computed source
  mapping, current target policy, Jira project/type/ID/key/URL, exactly one
  create-or-enrich result, and internal note.

## Why not the provider remote MCP or native integration?

Audit date: **2026-07-03**.

Intercom's hosted MCP currently exposes 13 tools for search/fetch of
conversations, contacts, companies, and Help Center article work. Its documented
inventory has no ticket operations, conversation/ticket note, assignment, tag,
or external-tracker transaction. Atlassian Rovo MCP, however, can search,
create, edit, transition, and comment on Jira issues. Use those MCP servers for
exploration, flexible lookup, and ordinary interactive Jira work.

The overlap is substantial: Intercom's official **Jira for Tickets** app can
create/link Jira issues from tickets, automate ticket-to-issue creation, and
sync notes, comments, and statuses. It should be the default when that native
sync is the desired outcome. It does not make this recipe universally better.

Do not run this Worker and Jira for Tickets automation against the same source
population. Exclude Worker-managed sources from native auto-create and
bidirectional note/comment/status sync using disjoint ticket types, teams, tags,
or automation rules. Running both writers on one ticket can create competing
issues, notes, routing, and status ownership. It is fine to keep the native app
for a different, explicitly disjoint queue.

This Worker is justified only when the terminal outcome must also include the
exact Notion approval, current Intercom evidence gate, permanent cross-system
identity, deterministic many-customer-to-one enrichment, fixed internal-only
routing, partial-failure repair, and a unified receipt. If you do not need those
governance guarantees, install the native integration or attach the provider
MCP instead.

Official inventory and overlap sources:

- [Intercom MCP tool inventory](https://developers.intercom.com/docs/guides/mcp)
- [Atlassian Rovo MCP supported tools](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/)
- [Intercom Jira for Tickets app](https://www.intercom.com/help/en/articles/7918909-jira-for-tickets-app)

## Agent-facing instructions

Use this tool only when:

- the user points to one active Notion page whose escalation status is exactly
  `Approved`;
- the page contains a canonical packet, explicit revision, and matching
  fingerprint;
- the human has already selected the Intercom source and approved Jira target;
- the request is to complete or safely resume this exact escalation.

Do not use it when:

- the correct Jira project, issue type, existing issue, severity, impact, or
  reproduction still requires judgment;
- the Intercom record changed after approval;
- the user asks to reply to the customer, close/snooze the source, upload files,
  transition Jira, or change arbitrary fields;
- the job contains more than one source.

Pasteable Custom Agent instruction:

> For an engineering escalation, first read the referenced Notion page. Call
> `escalateCustomerIssue` only when Escalation status is exactly Approved and
> the user confirms the exact source kind, source API ID, Escalation revision,
> and Escalation fingerprint. Never choose or alter the Jira target or approved
> packet. Never pass a transcript. Call once per confirmation. Show the returned
> Jira link, authority fields, records, warnings, and any repair instruction.
> If retryable is true, resume only with the identical five inputs; never change
> the revision to bypass a fence. This tool never sends a customer-visible reply.

Before calling, confirm: “This will create or enrich the approved Jira issue,
apply the configured internal Intercom route, add an internal Jira-link note,
and write the receipt. It will not reply to the customer.”

### Starting from an Intercom ticket

Intercom's hosted MCP cannot prepare a ticket escalation: its current tool
inventory has no Ticket fetch or mutation tools. For an agent-friendly starting
point, deploy the cookbook's [Intercom sync](../intercom-sync/) and give the
agent access to its managed **Tickets**, **Contacts**, and **Companies**
databases. The synced Ticket page supplies the immutable `Ticket ID`, current
state/category, team, updated time, contact relations, and sanitized default
description; attach or relate that page to the approval page. The agent can use
that attached Notion context to draft the bounded summary, impact, environment,
and reproduction fields, while a human selects the Jira target and approves the
canonical packet. Convert the synced `Updated` timestamp to Unix seconds for
`expectedSourceUpdatedAt`, and use `Ticket ID`—not the human-facing Inbox Ticket
ID—for `sourceId`.

The escalation call still re-fetches the ticket through Intercom REST and fails
closed if the attached/synced evidence is stale. The sync is preparation
context, not mutation authority; do not ask MCP to infer or prepare a Ticket it
cannot read.

For Conversations, `sourceId` must likewise be the raw Intercom REST ID, which
is commonly a numeric string such as `987654321`. Do not pass synthetic hosted
MCP identifiers such as `conversation_...`; those are not valid REST resource
IDs. Copy the immutable `Conversation ID` from the Intercom sync database or a
REST response.

## Approval packet

Create these Notion properties (names are configurable):

| Property                 | Type             | Contract                                         |
| ------------------------ | ---------------- | ------------------------------------------------ |
| `Escalation status`      | Status or select | Exactly `Approved`                               |
| `Escalation revision`    | Rich text        | Immutable 1–100 character revision               |
| `Escalation fingerprint` | Rich text        | Lowercase SHA-256 of the canonical packet        |
| `Escalation packet`      | Rich text        | Canonical compact JSON, at most 8,000 characters |
| `Escalation receipt`     | Rich text        | Empty before execution; Worker-owned afterward   |

An example packet (formatting shown for readability) is:

```json
{
  "version": 1,
  "sourceKind": "conversation",
  "sourceId": "987654321",
  "expectedSourceUpdatedAt": 1783080000,
  "expectedSourceState": "open",
  "expectedContactId": "contact_123",
  "expectedCompanyId": "company_123",
  "expectedTeamAssigneeId": "team_support",
  "jiraProjectKey": "ENG",
  "jiraIssueTypeId": "10001",
  "destinationIssueKey": null,
  "severity": "sev2",
  "summary": "Checkout returns an incorrect total",
  "impact": "Paid customers cannot complete checkout in the EU region.",
  "environment": "Production, EU storefront, build 2026.07.03",
  "reproductionSteps": [
    "Open a cart with a discounted annual plan.",
    "Proceed to checkout and observe the total."
  ],
  "accountTier": "Enterprise",
  "entitlement": "24x7 support",
  "incidentKey": null,
  "includeSafeAttachmentMetadata": true
}
```

Save it as `packet.json`, then generate the exact one-line JSON and fingerprint:

```sh
npm run fingerprint -- packet.json
```

Put the first output line in `Escalation packet` and the second in
`Escalation fingerprint`. The helper validates every bound before hashing.
Changing any semantic field requires a new revision and human approval.

## Tool contract

The agent supplies only five fields:

```json
{
  "approvalPageId": "11111111-1111-4111-8111-111111111111",
  "approvalRevision": "approved-r7",
  "approvalFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "sourceKind": "conversation",
  "sourceId": "987654321"
}
```

The tool is a write tool (`readOnlyHint: false`). Its terminal statuses are
`completed`, `no_op`, `blocked`, `conflict`, `partial_failure`, and
`ambiguous`. A successful result resembles:

```json
{
  "ok": true,
  "status": "completed",
  "operationId": "icj_0123456789abcdef0123456789abcdef",
  "idempotencyKey": "icj_0123456789abcdef0123456789abcdef",
  "changed": true,
  "replay": false,
  "preconditionsVerified": true,
  "issueCreated": true,
  "issueEnriched": false,
  "receiptWritten": true,
  "customerVisibleReplySent": false,
  "approvalPageId": "11111111-1111-4111-8111-111111111111",
  "approvalRevision": "approved-r7",
  "approvalFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "mappingId": "icm_0123456789abcdef0123456789abcdef",
  "intercomTeamId": "team_engineering",
  "intercomTagId": "tag_escalated",
  "sourceKind": "conversation",
  "sourceId": "987654321",
  "jiraIssueId": "10042",
  "jiraIssueKey": "ENG-42",
  "jiraUrl": "https://example.atlassian.net/browse/ENG-42",
  "marker": "notion-int-0123456789abcdef01234567",
  "safeAttachmentCount": 1,
  "records": [
    {
      "system": "jira",
      "kind": "issue",
      "id": "10042",
      "url": "https://example.atlassian.net/browse/ENG-42",
      "action": "created"
    }
  ],
  "steps": [
    { "name": "approval", "state": "completed" },
    { "name": "source", "state": "completed" },
    { "name": "mapping", "state": "completed" },
    { "name": "jira", "state": "completed" },
    { "name": "intercom_tag", "state": "completed" },
    { "name": "intercom_route", "state": "completed" },
    { "name": "intercom_note", "state": "completed" },
    { "name": "receipt", "state": "completed" }
  ],
  "warnings": [],
  "retryable": false,
  "retryAfterMs": null,
  "resumeToken": null,
  "repairInstruction": null,
  "startedAt": "2026-07-03T12:00:00.000Z",
  "completedAt": "2026-07-03T12:00:08.000Z",
  "message": "Created one approved Jira issue, routed the Intercom source, added an internal link note, and wrote the receipt."
}
```

`records` contains the canonical Notion, Intercom, and Jira identities; `steps`
always names all eight workflow stages. Raw Intercom messages, attachment URLs,
emails, tokens, headers, and provider response bodies never reach the result.
`changed`, `issueCreated`, `issueEnriched`, and record actions describe only the
current invocation, not cumulative history. A step is `completed` when this
invocation touched and completed it, `skipped` when durable state proved it was
already complete, and `pending` or `failed` when this invocation could not
finish it. A resume after Jira success therefore reports the Jira step as
`skipped` and never claims it created the issue again.

The compact Notion receipt also contains a `proofHash`, monotonic
`mappingGeneration`, Jira project/type, and the exactly-one create/enrich
result. Editing that JSON and recomputing its hash does not create authority:
replay requires an identical permanent Redis proof, the computed source
mapping, and the currently configured target policy.

### Hard limits

| Resource                               | Limit                                                           |
| -------------------------------------- | --------------------------------------------------------------- |
| Sources per call                       | 1                                                               |
| Reproduction steps                     | 1–10; 500 characters each                                       |
| Summary / impact / environment         | 200 / 1,500 / 500 characters                                    |
| Notion packet / receipt                | 8,000 / 1,900 characters                                        |
| Intercom parts / tags / contacts       | 500 / 100 / 20                                                  |
| Contact-company pagination             | 3 pages, 50 per page                                            |
| Jira create-field metadata             | 3 pages, 50 per page                                            |
| Jira comments scanned for marker       | 5 pages, 100 per page                                           |
| Safe attachment metadata               | 10 entries; PNG, JPEG, PDF, or text; at most 10 MB each         |
| HTTP response body                     | 256 KiB                                                         |
| Read retries                           | At most 3 total attempts for `429`, `5xx`, or transport failure |
| Mutating HTTP retries                  | 0 automatic retries                                             |
| Jira attempts after definite rejection | 3 per exact approved operation                                  |
| Request timeout                        | 8 seconds by default; configurable from 1–30 seconds            |

Attachment bytes and URLs are never copied or fetched. Eligible filenames,
MIME types, and sizes are untrusted metadata, sanitized and labeled as evidence.

## Replay and failure behavior

| Scenario                                           | Provider write behavior                    | Result and next action                                                           |
| -------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| Completed replay                                   | No writes                                  | Verify permanent proof + mapping + current policy, then return `no_op`           |
| Concurrent call                                    | Source lease allows one owner              | `conflict`, retry exact inputs after lease expiry                                |
| Stale/revoked approval or fingerprint              | Zero provider writes                       | `blocked`/`conflict`; create a fresh human approval                              |
| Changed Intercom revision/state/evidence           | Zero new writes                            | `conflict`; refresh evidence and reapprove                                       |
| Worker's own tag/route/note changed `updated_at`   | Own marker/tag/route are normalized        | Resume unfinished steps without becoming falsely stale                           |
| Jira/Intercom `403` or `404`                       | Definite rejection; no blind retry         | `blocked` before Jira, or `partial_failure` after it; repair permission/identity |
| Jira `409`                                         | Definite rejection                         | `conflict`; inspect target policy before exact retry                             |
| `429`                                              | Mutation is not automatically retried      | `retryable=true` with bounded `retryAfterMs`                                     |
| Read timeout before mutation                       | Zero writes                                | Bounded read retries, then `blocked`                                             |
| Jira create/comment timeout after boundary         | Search exact label/property/comment marker | Adopt one match; otherwise `ambiguous` and reconciliation-only                   |
| Mutation body malformed/large/stalled after send   | Keep the mutation fence                    | Reconcile the marker; never re-arm the POST from a response parsing failure      |
| Intercom tag/route/note timeout                    | Re-fetch exact source state/marker         | Adopt observed mutation; otherwise no repost and `partial_failure`               |
| Intercom mutation returns success without state    | Exact authoritative re-read fails          | Keep the step fenced; do not write a receipt or repeat the mutation              |
| Partial success after Jira                         | Jira step stays durable                    | Exact resume runs only unfinished Intercom/receipt steps                         |
| Notion writeback fails                             | Provider work is preserved                 | `partial_failure`; exact resume is receipt-only                                  |
| Receipt response lost but write applied            | Verify permanent proof before adoption     | Next exact call returns `no_op` without provider writes                          |
| Receipt exact but final progress CAS/lease is lost | Proof + Notion remain completion authority | Report `receiptWritten=true`; `changed` still describes this invocation only     |
| Editable receipt lacks proof or mapping            | Zero provider writes                       | `conflict`; reconcile Redis rather than trusting or editing Notion               |
| Same-operation receipt JSON differs from proof     | Zero writes to Notion                      | `conflict`; only byte-exact intended receipt can be `already_written`            |
| Prior source claim is definitely rejected/not sent | Negative Jira marker reconciliation        | CAS-transfer and increment generation; old generations can never reclaim         |

Redis `SET ... NX` atomically creates the permanent source claim. Exact-value
Lua compare-and-set scripts update mappings and operation state. Every guarded
claim transfer increments a permanent integer generation; an operation bound to
an older generation fails closed even if a newer owner crashes before sending
Jira. A second permanent `SET ... NX` record stores the canonical receipt proof
before Notion writeback; unlike operation progress, it has no TTL. A source
lease serializes this Worker, but it cannot prevent a human or unrelated
integration from mutating Jira or Intercom; fresh provider reads detect that
residual race.

## Quickstart

Requirements:

- Node.js 22+ and npm 10.9.2+
- Notion Workers CLI (`ntn`)
- one Intercom private app for your own workspace
- one dedicated Jira Cloud automation account
- one dedicated Upstash-compatible Redis REST database with eviction disabled
  and retention/backups appropriate for permanent mapping and proof records
- a Notion approval page/database with the five properties above

Install and run the offline checks:

```sh
cd workers/intercom-escalate-customer-issue
npm install
npm run format:check
npm run check
npm test
npm run build
```

Deploy and configure:

```sh
npm install --global ntn@latest
ntn login
ntn workers deploy --name intercom-escalate-customer-issue

ntn workers env set INTERCOM_ACCESS_TOKEN=replace-with-private-app-token
ntn workers env set INTERCOM_REGION=us
ntn workers env set INTERCOM_WORKSPACE_ID=workspace_app_id_code
ntn workers env set INTERCOM_ADMIN_ID=admin_id
ntn workers env set JIRA_DOMAIN=example
ntn workers env set JIRA_EMAIL=automation@example.com
ntn workers env set JIRA_API_TOKEN=replace-with-api-token
ntn workers env set JIRA_ACTING_ACCOUNT_ID=account_id
ntn workers env set ESCALATION_TARGETS_JSON='[{"jiraProjectKey":"ENG","jiraIssueTypeIds":["10001"],"intercomTeamId":"12345","intercomTagId":"67890"}]'
ntn workers env set UPSTASH_REDIS_REST_URL=https://example.upstash.io
ntn workers env set UPSTASH_REDIS_REST_TOKEN=replace-with-redis-token
```

After deployment, open the Custom Agent and add the Worker under **Tools and
access > Add connection**. Give the agent access only to the approval pages it
may consume.

## Permissions and secrets

| System          | Minimum access                                                                                                                          | Acting identity and bound                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Intercom        | Read/list users and companies; Read conversations; Write conversations; Read tickets; Write tickets; Read admins; Read tags; Write tags | Dedicated private app/admin in one verified workspace; mutations use only configured team/tag IDs             |
| Jira Cloud      | Browse Projects, Create Issues, **Edit Issues**, and Add Comments in allowlisted projects; read/write issue properties                  | Dedicated automation user verified by `accountId`; project/issue types are fixed in `ESCALATION_TARGETS_JSON` |
| Jira OAuth fork | Classic `read:jira-work` + `write:jira-work` (or the equivalent granular issue, comment, property, and issue-meta scopes)               | Prefer OAuth for a distributable app; this private-workspace recipe uses an API token                         |
| Redis           | Read/write only to a dedicated database                                                                                                 | REST token; keys are namespaced `intercom-jira:v1:*`                                                          |
| Notion          | Invocation-scoped page access supplied by Workers                                                                                       | No deployed Notion token; page sharing is the authority boundary                                              |

Intercom access tokens, Jira email/token pairs, and Redis tokens are Worker
environment secrets. They never appear in tool inputs, outputs, Notion pages,
fixtures, or logged provider errors. The model can see the approved packet and
typed receipt if its Notion access permits; it cannot see raw fetched messages,
contact email, attachment URLs, authorization headers, or provider error bodies.

`Edit Issues` is required even though the Worker does not expose arbitrary
field edits: it writes the deterministic Jira issue property used to reconcile
create/comment outcomes. `Create Issues` covers new escalation mode, `Add
Comments` covers enrichment mode, and `Browse Projects` covers target metadata,
issue readback, marker search, and reconciliation. A post-Jira Intercom `401` or
`403` returns the stable operation ID as `resumeToken` plus an instruction to
repair the Intercom credential and call again with the identical five inputs;
the completed Jira step is skipped.

Do not expire, evict, or routinely flush `intercom-jira:v1:mapping:*` or
`intercom-jira:v1:receipt-proof:*` keys.
Operation progress intentionally has a TTL, but mappings and completion proofs
do not. Losing either permanent record invalidates Notion replay authority and
requires operator reconciliation rather than automatic recreation.

Intercom private apps are appropriate only for your own workspace. A
distributable integration must use Intercom OAuth. Atlassian recommends OAuth
for distributed apps; Basic auth with an API token is retained here as the
documented internal-script path.

## Local sandbox smoke test

Offline tests use fakes and make no network calls. For an opt-in sandbox test,
copy `.env.example` to `.env`, use only disposable Intercom/Jira/Redis/Notion
resources, create and approve one fake escalation packet, then run:

```sh
ntn workers exec escalateCustomerIssue --local -d '{"approvalPageId":"11111111-1111-4111-8111-111111111111","approvalRevision":"sandbox-r1","approvalFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sourceKind":"conversation","sourceId":"987654999"}'
```

Expected output is `status: "completed"`, one sandbox Jira issue, the configured
tag/team and one internal note in Intercom, plus an exact Notion receipt. Run the
same command again and expect `status: "no_op"` with no new writes.

Cleanup: delete the sandbox Jira issue, remove the sandbox Intercom note/tag if
appropriate, delete the approval page, remove `intercom-jira:v1:*` keys, delete
the local `.env`, and revoke all sandbox tokens. Never use a production customer
record for this smoke test.

## Limits and when not to use it

- This is one source and one Jira outcome, not a bulk migration or long-running
  incident workflow.
- It does not copy full transcripts or attachment bytes, send replies,
  close/snooze sources, transition Jira, assign Jira users, or set arbitrary
  custom fields.
- Jira projects with additional required create fields are blocked rather than
  guessed. Fork the typed packet and allowlist those fields deliberately.
- Records beyond the documented pagination limits are blocked; increase a limit
  only after reviewing execution time and reconciliation semantics.
- Use Intercom MCP for support exploration, Rovo MCP for flexible Jira work, and
  Jira for Tickets for ordinary native create/link/sync.
- If model judgment is needed between source reading and engineering action,
  keep that analysis outside the tool and require a fresh approved packet.

## Safe extension points

- Add one explicitly typed Jira custom field only after including it in the
  canonical packet, target policy, ADF/request tests, and approval fingerprint.
- Add a second fixed Intercom route by extending one target object; never accept
  arbitrary team/tag IDs from the agent.
- Replace Jira Basic auth with a centrally registered OAuth app without changing
  the orchestration boundary.
- Add a Salesforce account-context adapter as a pre-mutation read, but bind its
  immutable record identity and approved fields into the packet/fingerprint.
- Add attachment upload only as a separately reviewed policy with malware
  scanning, byte limits, allowlisted MIME types, and its own ambiguous-write
  reconciliation. This first version intentionally copies metadata only.

## Project map

```text
src/
├── index.ts           — tool schema, description, and Worker registration
├── orchestrator.ts    — approval gates, claim, mutation fences, resume, receipt
├── notion.ts          — exact approval parsing and canonical receipt readback
├── intercom.ts        — regional API client and internal-only mutations
├── jira.ts            — ADF, marker create/enrichment, bounded reconciliation
├── redis.ts           — strict progress/mapping/proof records, leases, and CAS
├── canonical.ts       — packet/receipt/proof validation, IDs, source drift guard
├── config.ts          — credentials, target allowlist, and operational bounds
├── types.ts           — strict input, state, gateway, and result contracts
└── fingerprint-cli.ts — canonical packet/fingerprint helper

test/
├── orchestrator.test.ts — proof, claim transfer, rereads, failure, and resume
├── http.test.ts         — ticket paths, response fences, bounds, and redaction
├── redis.test.ts        — strict records, permanent proof, CAS, and leases
└── policy.test.ts       — packet, target, receipt, and source-drift policies
```

## Official references

API and authentication audit completed **2026-07-03**:

- [Intercom REST API 2.15](https://developers.intercom.com/docs/references/rest-api/api.intercom.io)
- [Intercom conversations](https://developers.intercom.com/docs/references/rest-api/api.intercom.io/conversations)
- [Intercom ticket retrieval and replies](https://developers.intercom.com/docs/references/rest-api/api.intercom.io/tickets)
- [Intercom OAuth scopes](https://developers.intercom.com/docs/build-an-integration/learn-more/authentication/oauth-scopes)
- [Intercom authentication](https://developers.intercom.com/docs/build-an-integration/learn-more/authentication)
- [Intercom MCP](https://developers.intercom.com/docs/guides/mcp)
- [Intercom Jira for Tickets](https://www.intercom.com/help/en/articles/7918909-jira-for-tickets-app)
- [Jira Cloud issue REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/)
- [Jira Cloud issue comments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/)
- [Jira Cloud issue properties](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-properties/)
- [Jira Cloud issue search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)
- [Jira Cloud Basic auth and API tokens](https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/)
- [Atlassian Rovo MCP overview](https://developer.atlassian.com/cloud/rovo-mcp/)
- [Atlassian Rovo MCP supported tools](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/)
- [Notion Workers](https://developers.notion.com/docs/workers)
- [Contributing to this cookbook](../../CONTRIBUTING.md)
