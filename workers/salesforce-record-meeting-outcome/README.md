# Record approved meeting outcomes in Salesforce

Give a Notion Agent one governed write tool for the end of a customer meeting.
After a human approves an exact, fingerprinted packet on a Notion page,
`recordMeetingOutcome` does all of the following as one replay-safe operation:

- verifies the Notion approval and Salesforce Opportunity have not changed;
- records one completed Salesforce Task as the meeting activity;
- updates only an explicitly supplied `NextStep`, `CloseDate`, or allowlisted
  `StageName` transition;
- creates zero to five follow-up Tasks for active, allowlisted owners; and
- writes canonical Salesforce record IDs back to the Notion page.

The tool is intentionally narrower than generic Salesforce CRUD. It owns the
approval boundary, all-or-none mutation, durable idempotency claim, ambiguous
result reconciliation, and cross-system receipt that an agent would otherwise
have to coordinate across many calls.

## Try asking

- "The outcome packet on this meeting page is approved. Record revision
  `rev-7` against Opportunity `006…`, including its approved follow-ups."
- "Retry the exact approved Salesforce meeting outcome. Do not create anything
  again if it already committed."
- "Record this approved outcome and tell me which Opportunity fields changed,
  which Tasks were created, and whether the Notion receipt was written."

## Agent contract

Call the tool only when all of these are true:

- one Notion meeting page is the approval source;
- its approval property is approved;
- its revision and SHA-256 fingerprint match the exact semantic tool input;
- the target is one explicit Salesforce Opportunity ID with an approved
  `LastModifiedDate` precondition;
- every requested field change and follow-up is visible in the approved packet;
- every follow-up owner is in the Worker's configured allowlist.

Do not call it to summarize a transcript, infer CRM changes, search for an
Opportunity by name, perform bulk updates, set arbitrary fields, attach files,
send messages, delete records, or correct an already recorded outcome. Never
pass a raw transcript, arbitrary URL, or free-form Salesforce field map. A
correction uses a new approval page and a new operation.

The result is the source of truth for what happened. Do not describe a write as
successful unless `ok` is `true`. On `partial_failure` or `ambiguous`, retain
the returned `resumeToken` as receipt evidence and follow `repairInstruction`.
When a retry is directed, retry the exact original tool input. `resumeToken` is
output-only; it is not an input field. Do not synthesize a new fingerprint or
issue generic Salesforce writes.

## Quickstart

Use Node.js 22+, npm 10.9.2+, the
[Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli), and the
[Notion Workers CLI](https://developers.notion.com/docs/workers). Start with a
Salesforce sandbox, a dedicated API-only integration user, and a test Notion
database.

### 1. Deploy the Salesforce safety metadata

Authenticate the Salesforce CLI to the sandbox, then deploy the custom durable
ledger, unique Task operation key, and narrow permission set:

```sh
cd workers/salesforce-record-meeting-outcome/salesforce
sf project deploy start --source-dir force-app --target-org your-sandbox
sf org assign permset --name Notion_Meeting_Outcome_Worker --target-org your-sandbox
```

`Notion_Meeting_Outcome_Worker` grants create/read/edit on only the custom
`Notion_Meeting_Operation__c` ledger. Its six invariant fields—operation key,
input fingerprint, status, Notion page ID, approved revision, and Opportunity
ID—are universally required in their field metadata, so Salesforce makes them
visible/editable regardless of field-level security. The permission set grants
explicit read/edit FLS to every optional result/timestamp/hash field and to
`Task.Notion_Operation_Item_Key__c`. A metadata-contract test requires every
runtime ledger field to be covered by one of those two mechanisms. The
permission set deliberately does not grant standard-object access, API access,
broad record visibility, or delete access.

Grant the dedicated integration user the following separately:

| Salesforce resource      | Minimum access used by this Worker                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| System                   | **API Enabled** and access to the External Client App                                                                                                 |
| Opportunity              | Read; edit only `NextStep`, `CloseDate`, and `StageName`; read `Id`, `OwnerId`, `LastModifiedDate`, and those three fields                            |
| Task                     | Read and create; field access to `Subject`, `Description`, `ActivityDate`, `Status`, `WhatId`, `WhoId`, `OwnerId`, and `Notion_Operation_Item_Key__c` |
| Opportunity Contact Role | Read `OpportunityId` and `ContactId`                                                                                                                  |
| User                     | Read `Id` and `IsActive`                                                                                                                              |
| Notion Meeting Operation | Supplied by `Notion_Meeting_Outcome_Worker`                                                                                                           |

Do not grant delete, **Modify All Records**, **View All Data**, or administrator
access. Grant **View All Records** only if the documented business workflow
truly requires it; otherwise Salesforce sharing rules bound what the Worker can
see and mutate.

Create a local Salesforce External Client App with client credentials enabled,
the `api` OAuth scope only, and the dedicated integration user as **Run As**.
The [Salesforce sync setup](../salesforce-sync/#create-the-salesforce-external-client-app)
shows the complete UI sequence. Record its consumer key, consumer secret, and
the sandbox or production My Domain origin.

### 2. Add the Notion approval properties

The meeting page must have these properties. The names are configurable, but
the types are not.

| Default property         | Type                        | Purpose                                                       |
| ------------------------ | --------------------------- | ------------------------------------------------------------- |
| `Meeting Outcome Status` | status, select, or checkbox | Human approval gate; the default approved value is `Approved` |
| `Approved Revision`      | rich text or title          | Immutable revision identifier, at most 100 characters         |
| `Approved Fingerprint`   | rich text or title          | Lowercase SHA-256 of the exact semantic packet                |
| `Salesforce Receipt`     | rich text                   | Initially empty; reserved for this Worker's compact receipt   |

Give the custom agent access to the meeting pages. Do not give it permission to
edit the approval, revision, or fingerprint properties unless the agent is also
the intentionally designed approval authority.

The approval workflow must build the exact tool input, compute its fingerprint,
write the revision and fingerprint, and only then mark the page approved. This
repository includes a local helper. Create `approved-input.json` with the exact
packet (the fingerprint value may be omitted or a placeholder), then run:

```sh
cd workers/salesforce-record-meeting-outcome
npm ci
npm run fingerprint -- ./approved-input.json
```

Paste the printed hash into `Approved Fingerprint` and use the same value as
`approvalFingerprint` in the tool call. The canonical hash covers every
semantic input except the fingerprint itself.

An input packet has this shape:

```json
{
  "notionPageId": "11111111-1111-4111-8111-111111111111",
  "approvedRevision": "rev-7",
  "approvalFingerprint": "fd07cb117a15b89cb05d6690fcbe9eacaa6467489381d84693f98e7e158917b5",
  "opportunityId": "006000000000001AAA",
  "expectedOpportunityLastModifiedAt": "2026-07-01T12:00:00.000Z",
  "meetingSubject": "Acme discovery outcome",
  "occurredOn": "2026-07-02",
  "outcomeSummary": "Acme approved a technical validation and named a champion.",
  "primaryContactId": "003000000000001AAA",
  "opportunityUpdates": {
    "nextStep": "Schedule technical validation",
    "closeDate": "2026-09-30",
    "stageName": "Qualification"
  },
  "followUps": [
    {
      "subject": "Send validation plan",
      "description": "Send the approved validation outline.",
      "dueDate": "2026-07-10",
      "ownerId": "005000000000001AAA",
      "contactId": "003000000000001AAA"
    }
  ]
}
```

Replace every example ID and date. The Opportunity `LastModifiedDate` belongs
in the approved packet; the Worker rejects the call if Salesforce no longer
matches it.

### 3. Configure and deploy the Worker

From the Worker directory:

```sh
npm install --global ntn
npm ci
ntn login
ntn workers deploy --name salesforce-record-meeting-outcome
ntn workers env set SALESFORCE_ORG_URL=https://your-domain.my.salesforce.com
ntn workers env set SALESFORCE_CLIENT_ID=your-consumer-key
ntn workers env set SALESFORCE_CLIENT_SECRET=your-consumer-secret
ntn workers env set SALESFORCE_ALLOWED_TASK_OWNER_IDS=005000000000001AAA
ntn workers env set 'SALESFORCE_ALLOWED_STAGE_TRANSITIONS={"Discovery":["Qualification"],"Qualification":["Proposal"]}'
```

Use `--name salesforce-record-meeting-outcome` only for the first deployment.
After `workers.json` identifies it, update with `ntn workers deploy`.

Optional overrides are listed in [`.env.example`](.env.example):

- the five Notion property names and approved value;
- the Salesforce status for completed meeting Tasks; and
- the Salesforce status for open follow-up Tasks.

The stage-transition JSON maps each current stage to the only permitted target
stages. An empty map means no stage changes are allowed. The owner list accepts
at most 25 User IDs; an empty list means no follow-up Tasks are allowed.

### 4. Connect and instruct the agent

Add the deployed Worker under the custom agent's **Tools & Access > Add
connection**, enable `recordMeetingOutcome`, and keep confirmation required for
the write tool. Give the agent instructions that restate the [agent
contract](#agent-contract), especially the exact-input retry rule.

Paste and adapt this block in the agent's instructions:

```text
You have one governed Salesforce write tool: recordMeetingOutcome.

Call it only for one exact meeting-outcome packet that is already marked
Approved on its Notion source page. Read the page first. Require its Approved
Revision and Approved Fingerprint, one explicit Opportunity ID, the approved
Opportunity LastModifiedDate, and only the listed NextStep, CloseDate,
allowlisted StageName, meeting activity, and zero to five follow-up Tasks.

Before the first call, show the user the Opportunity ID, proposed field changes,
meeting Task, and follow-up owners/dates, then ask for explicit confirmation.
Conversation alone is not approval: the page approval, revision, and fingerprint
must also be valid. Never infer missing values, search by Opportunity name,
summarize a raw transcript inside this tool, or substitute generic Salesforce
create/update tools.

Treat the returned receipt as authoritative. Report success only when ok=true.
For no_op, say that this was an exact replay and no duplicate records were
created. For conflict, stop for renewed review. For blocked, retry the exact
input only when retryable=true; otherwise explain the required fix. For
partial_failure or ambiguous, preserve the output-only resumeToken for the
activity log and follow repairInstruction. Retry only the exact original tool
input, including its original approvalFingerprint; never pass resumeToken as an
input and never construct replacement Salesforce writes.
```

## What a call can change

The mutation is bounded in code:

| Resource         | Maximum effect per operation                                                   |
| ---------------- | ------------------------------------------------------------------------------ |
| Notion           | Read one page repeatedly for preconditions; write one rich-text receipt        |
| Opportunity      | Update only changed `NextStep`, `CloseDate`, and/or an allowlisted `StageName` |
| Meeting activity | Create exactly one completed Task                                              |
| Follow-ups       | Create zero to five Tasks; owners must be active and allowlisted               |
| Durable ledger   | Create one private custom-object row and finalize it                           |

Canonical limits include a 32 KiB input, 255-character subjects, a
4,000-character outcome summary, 1,000-character follow-up descriptions, and no
duplicate follow-up tuple. Fresh writes additionally require a meeting date
within the past 365 days, follow-up due dates within 180 days, and currently
allowlisted owners. Contact IDs must already be Opportunity Contact Roles. IDs,
not names or URLs, are required for every Salesforce identity.
Every Salesforce fetch and every Notion page retrieve/update has a fixed
10-second request budget. The Salesforce budget stays active through response
body consumption, not only until headers arrive.

## How reliability works

1. The Worker validates every bounded canonical field, derives the stable
   operation key, recomputes the packet hash, and requires the caller's explicit
   approval fingerprint to match before any provider call.
2. It then looks up and validates the durable Salesforce ledger by that stable
   operation key derived from the Notion page and Opportunity. An existing
   matching checkpoint is reported truthfully even if the current Notion page
   is revoked, revised, unavailable, outside today's date windows, or names an
   owner removed from the current allowlist; only missing writeback remains.
3. Only when no ledger exists does it apply current meeting/due-date windows and
   owner allowlists. It then reads the Notion page and requires the caller
   fingerprint, page fingerprint, and recomputed canonical hash to be identical.
4. Before creating anything, it rejects an occupied Notion receipt, orphaned
   Task operation keys, unrelated Contacts, inactive owners, and stale
   Opportunity state.
5. After identity resolution, it immediately re-reads both the Notion approval
   and Salesforce Opportunity.
6. One Salesforce Composite request with `allOrNone: true` creates the unique
   ledger claim first, conditionally updates the Opportunity with
   `If-Unmodified-Since`, creates the meeting/follow-up Tasks, and saves their
   canonical IDs to the ledger. A 2xx response is accepted only when it contains
   the exact unique planned reference set, numeric successful statuses, the
   conditional Opportunity update when planned, and the final ledger update.
7. The Worker re-reads approval before assigning the Notion receipt, validates
   the update response page ID, and always performs a bounded exact readback of
   the receipt, revision, and fingerprint before marking the Salesforce ledger
   completed.

The unique ledger key is the primary provider-enforced lock. Unique Task item
keys provide a second reconciliation signal. No Task upsert is treated as a
lock. Network failures before a mutation are retryable; an unconfirmed mutation
is reconciled against both durable signals before the Worker returns.

One Notion page and Opportunity pair intentionally identifies one meeting
outcome even if the approval revision later changes. This prevents a revised
packet from silently producing a second activity. Use a new meeting page for a
correction or a genuinely new meeting.

## Receipt semantics

Every response contains `operationId`/`idempotencyKey`, `inputFingerprint`,
canonical record IDs and URLs when known, changed fields, step receipts,
`retryable`, `resumeToken`, and an actionable repair instruction when needed.

| Status            | Meaning                                                                                                       | Agent action                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `completed`       | Salesforce committed and the Notion receipt was written                                                       | Report the returned records                                                                 |
| `no_op`           | Exact replay; matching records and receipt already existed                                                    | Report success without claiming new writes                                                  |
| `blocked`         | No write committed: policy, permission, configuration, temporary read failure, or definite provider rejection | Retry the exact input only when `retryable` is true; otherwise fix the prerequisite         |
| `conflict`        | Approval, fingerprint, revision, Opportunity state, or existing operation differs                             | Require renewed human review                                                                |
| `partial_failure` | Salesforce definitely committed, but Notion receipt or ledger work remains; known records are returned        | Retain the token as evidence, perform any stated repair, and retry the exact original input |
| `ambiguous`       | The mutation result could not yet be proven, or orphaned operation keys exist                                 | Follow `repairInstruction`; never issue substitute writes                                   |

This is a realistic successful result for the example packet (record IDs other
than the sample Opportunity are illustrative):

```json
{
  "ok": true,
  "status": "completed",
  "operationId": "b0d4bc13e2841c588a62ae472f49307dad53fadeed2860f14d72f66b83ab6b0d",
  "idempotencyKey": "b0d4bc13e2841c588a62ae472f49307dad53fadeed2860f14d72f66b83ab6b0d",
  "inputFingerprint": "fd07cb117a15b89cb05d6690fcbe9eacaa6467489381d84693f98e7e158917b5",
  "changed": true,
  "replay": false,
  "records": [
    {
      "system": "salesforce",
      "kind": "opportunity",
      "id": "006000000000001AAA",
      "url": "https://acme.my.salesforce.com/lightning/r/Opportunity/006000000000001AAA/view",
      "action": "updated"
    },
    {
      "system": "salesforce",
      "kind": "meeting_activity",
      "id": "00T000000000001AAA",
      "url": "https://acme.my.salesforce.com/lightning/r/Task/00T000000000001AAA/view",
      "action": "created"
    },
    {
      "system": "salesforce",
      "kind": "follow_up_task",
      "id": "00T000000000002AAA",
      "url": "https://acme.my.salesforce.com/lightning/r/Task/00T000000000002AAA/view",
      "action": "created"
    },
    {
      "system": "notion",
      "kind": "meeting_page",
      "id": "11111111-1111-4111-8111-111111111111",
      "url": null,
      "action": "written"
    }
  ],
  "changedFields": ["CloseDate", "NextStep", "StageName"],
  "steps": [
    {
      "name": "input_policy",
      "status": "completed",
      "detail": "Validated bounded canonical input and its explicit approval fingerprint."
    },
    {
      "name": "salesforce_ledger_lookup",
      "status": "completed",
      "detail": "Confirmed that no durable Salesforce operation checkpoint exists."
    },
    {
      "name": "fresh_write_policy",
      "status": "completed",
      "detail": "Validated current date windows and task-owner allowlists for a new write."
    },
    {
      "name": "notion_approval",
      "status": "completed",
      "detail": "Verified approval, revision, and canonical packet fingerprint."
    },
    {
      "name": "opportunity_precondition",
      "status": "completed",
      "detail": "Re-read the Opportunity and validated current state and transition policy."
    },
    {
      "name": "identity_resolution",
      "status": "completed",
      "detail": "Verified 2 Contact references and 1 follow-up owners."
    },
    {
      "name": "immediate_prewrite_check",
      "status": "completed",
      "detail": "Re-read Notion approval and Salesforce Opportunity immediately before the Composite mutation."
    },
    {
      "name": "salesforce_transaction",
      "status": "completed",
      "detail": "Committed the unique ledger claim, activity, 1 follow-ups, and allowlisted Opportunity changes in one all-or-none Composite request."
    },
    {
      "name": "salesforce_reconciliation",
      "status": "completed",
      "detail": "Verified 2 canonical Task IDs from the committed Composite response."
    },
    {
      "name": "notion_receipt",
      "status": "completed",
      "detail": "Wrote the compact canonical receipt."
    },
    {
      "name": "ledger_completion",
      "status": "completed",
      "detail": "Marked the durable operation ledger completed."
    }
  ],
  "warnings": [],
  "retryable": false,
  "resumeToken": null,
  "repairInstruction": null
}
```

Provider and race failures map to explicit behavior:

| Scenario                                                  | Returned behavior                                                                                        | Safe next action                                             |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Completed exact replay                                    | `no_op`, `ok: true`, same canonical IDs, no Composite write                                              | Report that nothing new was created                          |
| Delayed replay after date/owner policy changed            | Validate the exact packet and ledger first; return canonical `no_op`/`partial_failure` records           | Resume only missing cross-system work; never recreate        |
| Concurrent identical call                                 | The unique ledger claim chooses one winner; the other reconciles to `completed`/`no_op`                  | Use the winning receipt; do not retry with changed input     |
| Approval revoked or revision/fingerprint changed          | `blocked`/`conflict` before Salesforce; `partial_failure` with records if Salesforce already committed   | Obtain a new human review; do not reuse the old hash         |
| Opportunity changed after approval                        | `conflict`, with zero committed writes because of the immediate reread or HTTP precondition              | Refresh the packet and approval                              |
| Provider returns 403                                      | `blocked`, not retryable                                                                                 | Fix the integration user's minimum permissions               |
| Provider returns 409 or 412                               | `conflict`, not retryable                                                                                | Re-read provider state and renew approval                    |
| Provider returns 429                                      | Retryable `blocked`, with no committed Composite write; a bounded `Retry-After` is honored on safe reads | Retry the exact input after the provider window              |
| Composite returns HTTP 5xx                                | No retry; treat as ambiguous and reconcile the exact ledger and Task keys                                | Use recovered records or follow the ambiguity repair         |
| Composite 2xx omits/duplicates an expected reference      | `ambiguous`; never synthesize a committed receipt from a truncated body                                  | Reconcile the ledger and Task keys; never resend blindly     |
| Notion or Salesforce read timeout before any mutation     | Retryable `blocked`, no Composite request, and no partial success                                        | Retry the exact input                                        |
| Transport fails after the Composite was sent              | Reconcile the ledger and Task keys; return recovered `completed` or `ambiguous`                          | Follow `repairInstruction`; never create substitute records  |
| Salesforce committed but a later cross-system step failed | `partial_failure` with known Salesforce records and an output-only resume token                          | Retry the exact original input                               |
| Notion receipt write could not be confirmed               | Re-read the page; if still unknown, `partial_failure` without recreating Salesforce records              | Restore approval/empty receipt if needed, then retry exactly |
| Safe resume after partial completion                      | Ledger IDs are verified, missing Notion/finalization work is completed, then `completed` or `no_op`      | Report the reconciled receipt                                |

The compact Notion receipt contains only version, operation/fingerprint keys,
Opportunity ID, meeting Task ID, and follow-up Task IDs. It does not duplicate
meeting content or credentials.

## Security model

- The Worker uses the pre-authenticated Notion client supplied by the runtime;
  it has no Notion token environment variable.
- Salesforce uses OAuth client credentials with one dedicated integration
  user's object, field, and sharing permissions. Salesforce records therefore
  identify that integration user, while the Notion approval/fingerprint binds
  the human-approved packet.
- Provider reads use fixed field lists and bounded SOQL assembled only from
  format-validated Salesforce IDs or Worker-generated SHA-256 keys.
- Raw Salesforce error messages are never returned to the agent. Failures expose
  only an allowlisted, normalized provider error code inside fixed Worker
  wording, so tokens, field values, URLs, and prompt-like provider text cannot
  cross the tool boundary.
- HTTP redirects are rejected. The configured org must be an HTTPS Salesforce
  My Domain origin with no credentials, path, query, or fragment.
- Each Notion SDK read and update has a fixed 10-second timeout. Because an
  update can commit after the caller times out, the Worker performs one bounded
  page readback after every update response—success or failure—and requires the
  exact page identity, approval revision, fingerprint, and receipt.
- Every Salesforce request keeps its 10-second abort active through response
  body consumption. A stalled Composite body is ambiguous and is never retried;
  OAuth and safe-read body stalls retain their non-mutation retry semantics.
- Explicit 401 responses refresh the token once. Safe reads retry one bounded
  network/5xx failure. A Composite mutation is never retried after a transport
  failure, stalled body, or any HTTP 5xx because its commit state may be unknown;
  the Worker reconciles the ledger and Task keys instead.

The Notion pre-write check, receipt assignment, and readback are not an atomic
transaction. Another actor can still edit the page after the final read. The
Salesforce ledger remains the durable commit truth; the compact Notion receipt
records what was confirmed at readback time. Protect the four packet properties
from unrelated editors and treat later page changes as a new review event.

## Provider and MCP fit

Audit date: **2026-07-03**. This recipe targets Salesforce REST API **v67.0**
and was checked against the current Salesforce Hosted MCP and Notion Custom
Agent connection documentation.

Salesforce's standard
[`platform/sobject-mutations`](https://developer.salesforce.com/docs/platform/hosted-mcp-servers/references/reference/sobject-mutations.html)
server can query, create, and update records while honoring Salesforce
permissions. It can perform individual ingredients of this workflow, but it
does not expose a distinct compound `recordMeetingOutcome` operation, bind a
Notion approval fingerprint, claim an idempotency key before writes, commit the
related records in one all-or-none unit, or write/reconcile a Notion receipt.
This Worker is therefore not a thin rename of standard CRUD.

Salesforce can expose a purpose-built Flow, Apex action, or REST resource on a
[custom Hosted MCP server](https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/custom-servers.html),
and Salesforce specifically documents Flow-backed compound tools. That is the
preferred provider-native implementation when the target agent can connect to
it. Salesforce also advises clients to prefer
[Hosted MCP over custom REST proxy layers](https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/general-best-practices.html).

The compatibility limitation is authentication, not MCP tool expressiveness.
Salesforce documents an External Client App and per-user OAuth Authorization
Code with PKCE for
[Hosted MCP clients](https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/client-connection-overview.html).
Notion documents that a custom OAuth MCP server without dynamic client
registration requires Notion to pre-register a client, or the server must offer
durable header authentication; otherwise it
[cannot be connected to a Custom Agent](https://www.notion.com/help/mcp-connections-for-custom-agents).
Salesforce is not in that page's pre-configured list. Based on those public
documents, there is no documented direct, durable Notion Custom Agent connection
to Salesforce Hosted MCP as of the audit date. Reverify this inference for your
workspace before deploying.

Notion's
[Salesforce AI Connector](https://www.notion.com/help/salesforce-ai-connector)
is a Salesforce search/read surface and does not document CRM write tools, so it
does not replace this outcome.

**Deprecation trigger:** migrate this recipe to one custom Salesforce Hosted MCP
tool when Notion offers a documented compatible Salesforce connection (or
Salesforce offers a compatible DCR/header flow) and the provider-native tool can
preserve the same approval binding, unique claim, all-or-none records, replay,
and cross-system receipt contract. Keep the durable ledger model during that
migration.

## Verification

Offline validation uses mocked Notion and Salesforce gateways and does not need
credentials:

```sh
npm ci
npm run format:check
npm run check
npm test
npm run build
```

The suite covers success, exact and delayed replay after date/owner policy
changes, provider-first recovery after approval revocation/revision/timeout,
concurrent duplicate claims, stale Opportunities, occupied receipts, correlated
orphan evidence, unrelated Contacts, corrupt ledgers, exact Composite reference
contracts, truncated/duplicate 2xx responses, HTTP 500 reconciliation, ambiguous
commits, partial writeback/finalization, token renewal, 403/404, 409/412, 429
`Retry-After`, 5xx/read timeouts, stalled OAuth/safe-read/Composite bodies,
successful and late Notion readback, wrong page identity and receipt races,
metadata/FLS coverage, ordered cross-system prefixes, error redaction, malicious
and oversized inputs, and every terminal status.

For a sandbox smoke test:

1. Create a disposable Opportunity and Contact Role owned by the integration
   user's sharing scope.
2. Create one test meeting page with an empty receipt and explicitly share its
   parent database/page with the test Notion integration. For local-only CLI
   execution, provide the integration token only in the local process
   environment; this placeholder is intentionally not a real credential and
   must never be committed:

   ```sh
   export NOTION_API_TOKEN=ntn_test_replace_with_your_sandbox_token
   ```

3. Prepare and fingerprint an input with no stage change and no follow-ups for
   the first run.
4. Pull the deployed environment and execute locally:

   ```sh
   ntn workers env pull
   ntn workers exec recordMeetingOutcome --local -d "$(cat approved-input.json)"
   ```

5. Require `status: "completed"`, `changed: true`, one meeting Task ID, and no
   retry instruction. Verify one completed Task, one ledger row, the approved
   Opportunity changes, and one compact Notion receipt.
6. Execute the exact packet again. Require `status: "no_op"`, `changed: false`,
   `replay: true`, and exactly the same IDs.
7. In separate disposable cases, change the Opportunity or revoke approval
   after fingerprinting and require `conflict` with no new Tasks.

Clean up with a sandbox administrator, not by broadening the integration user's
permissions. Copy the 64-character `operationId` from the receipt. It is
SHA-256 of `lowercaseNotionPageIdWithoutHyphens + ":" + opportunityId`; each
Task key is that ID plus `:meeting` or `:followup:1` through `:followup:5`.
List the bounded records before deleting anything:

```sh
OPERATION_ID=replace_with_64_character_receipt_operation_id
sf data query --target-org your-sandbox --query "SELECT Id, OperationKey__c, Status__c, ActivityId__c, FollowUp1Id__c, FollowUp2Id__c, FollowUp3Id__c, FollowUp4Id__c, FollowUp5Id__c FROM Notion_Meeting_Operation__c WHERE OperationKey__c = '${OPERATION_ID}' LIMIT 1"
sf data query --target-org your-sandbox --query "SELECT Id, Notion_Operation_Item_Key__c FROM Task WHERE Notion_Operation_Item_Key__c LIKE '${OPERATION_ID}:%' ORDER BY Notion_Operation_Item_Key__c LIMIT 6"
```

Compare those IDs with the tool receipt. Delete only reviewed disposable IDs,
one record at a time, then restore the disposable Opportunity fields and clear
or archive the test Notion page:

```sh
sf data delete record --target-org your-sandbox --sobject Task --record-id 00T_REVIEWED_TEST_ID
sf data delete record --target-org your-sandbox --sobject Notion_Meeting_Operation__c --record-id a00_REVIEWED_LEDGER_ID
```

List both bounded queries again and require zero rows before reusing that
page/Opportunity pair; otherwise the unique keys correctly preserve the replay
history. Never use a broad Task query or bulk delete for this cleanup.

No live Salesforce, Notion mutation, Worker deployment, or MCP connection test
is performed by the offline suite.

## Code map and extension points

```text
src/index.ts          — strict agent-facing input/output schemas and tool copy
src/orchestrator.ts   — approval, preconditions, transaction, replay, receipts
src/policy.ts         — canonical hash, bounds, IDs, dates, stage/owner policy
src/salesforce.ts     — OAuth, fixed reads, Composite request, reconciliation
src/notion.ts         — typed approval reads and idempotent receipt writeback
src/config.ts         — bounded environment configuration
src/types.ts          — gateway and receipt contracts
salesforce/force-app/ — ledger, unique Task key, and narrow permission metadata
test.ts               — deterministic API, reliability, and agent-contract tests
```

To add a new Opportunity field, do not accept an arbitrary field map. Add one
typed input, a bound/allowlist in `policy.ts`, a fixed Composite mapping, minimum
field-level access documentation, receipt coverage, and tests proving stale
state makes zero writes. To change the approval packet, update the canonical
hash function and the local fingerprint helper together; existing fingerprints
must not silently change meaning.

## Learn more

- [Notion Workers documentation](https://developers.notion.com/docs/workers)
- [Salesforce Hosted MCP overview](https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/hosted-mcp-servers-overview.html)
- [Salesforce standard Hosted MCP servers](https://developer.salesforce.com/docs/platform/hosted-mcp-servers/references/reference/servers-reference.html)
- [Salesforce Flow-backed MCP tools](https://developer.salesforce.com/docs/platform/hosted-mcp-servers/references/reference/flows.html)
- [Salesforce Composite resources](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_composite.htm)
- [Salesforce conditional requests](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/headers_if_unmodified_since.htm)
- [Salesforce field-access precedence](https://help.salesforce.com/s/articleView?id=platform.customize_fieldaccess.htm&language=en_US&type=5)
- [Salesforce universally required field considerations](https://help.salesforce.com/s/articleView?id=platform.fields_universally_required_field_considerations.htm&language=en_US&type=5)
- [Notion MCP connections for Custom Agents](https://www.notion.com/help/mcp-connections-for-custom-agents)
- [Contributing guide](../../CONTRIBUTING.md)
