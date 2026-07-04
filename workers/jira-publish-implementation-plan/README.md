# Publish an approved implementation plan to Jira

Publish one complete, explicitly approved Notion work breakdown as a replay-safe Jira hierarchy with dependencies and backlinks, then record the canonical Jira graph in Notion.

This Worker exposes one write tool: `publishImplementationPlan`. It is for the initial publication of a plan, not for exploratory Jira work or later plan changes.

## Example requests

- “The implementation plan on this page is approved at revision 7. Publish its epic, stories, subtasks, owners, estimates, sprint, version, and blockers to ENG.”
- “Create the approved Jira hierarchy for the checkout migration and link every work item back to this Notion plan.”
- “Resume the exact approved Jira plan publication that stopped after creating two stories.”

## Why this is an Agent Tool

The agent and human do the semantic work once: decompose the plan, choose the complete hierarchy and dependencies, approve exact values, and record the canonical hash. The Worker owns the invariant operating procedure:

1. Read the exact Notion approval, revision, plan hash, and receipt without reserving the page.
2. Verify the configured Jira site and exact project ID/key pair, then discover and validate current issue types, fields, users, assignability, and dependency type.
3. Re-read the approved, empty Notion receipt immediately before the permanent claim.
4. Atomically claim the initial publication in Redis only after every read-only gate passes.
5. Create or reconcile each issue in stable parent-first order.
6. Create or reconcile dependencies only after every node has a durable identity.
7. Write one canonical hierarchy receipt back to the approved Notion page.

Putting the model between those calls would add latency and create opportunities to skip a field, change a destination, duplicate an issue after a timeout, or lose the relationship between the approved source and Jira. The Worker does not summarize the plan, invent work, choose owners, or decide whether it is approved.

## Why not the Atlassian Rovo MCP server?

Audit date: **2026-07-03**.

Atlassian's hosted Rovo MCP server currently exposes Jira reads and writes including `getJiraIssueTypeMetaWithFields`, `getJiraProjectIssueTypesMetadata`, `getIssueLinkTypes`, `lookupJiraAccountId`, `createJiraIssue`, `editJiraIssue`, transitions, comments, and JQL search. Atlassian also positions Rovo for generating work from source material. It does not document one tool that consumes an externally approved, complete plan and guarantees a bounded hierarchy, stable cross-system identity, atomic first-publication claim, per-node resume, ambiguity reconciliation, dependency completion, and canonical Notion receipt.

That whole graph transaction is the gap. Rovo MCP is the better choice for exploring Jira, looking up project metadata, drafting or adjusting one issue, asking follow-up questions, and any workflow that benefits from model judgment between steps. If your organization already exposes an equivalent governed graph operation through Rovo, use that instead of this Worker.

Official inventory checked:

- [Atlassian Rovo MCP supported tools](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/)
- [Atlassian Rovo MCP overview](https://developer.atlassian.com/cloud/rovo-mcp/)
- [Jira issue APIs and current create metadata](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/)
- [Jira issue links](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-links/)

## Design and authority boundary

### Joint-customer promise

“Publish this approved work breakdown once, with all structure and backlinks intact.”

### Agent and human judgment

The caller must supply the complete approved graph. The agent or human decides:

- what work belongs in the plan;
- summaries and descriptions;
- issue types and parent relationships;
- owners, labels, estimate points, sprint, and fix version;
- directed dependency semantics (`blockerNodeKey` blocks `blockedNodeKey`);
- whether the exact canonical plan is ready for approval.

### Worker guarantees

The Worker:

- accepts IDs and bounded text, never arbitrary Jira URLs, REST methods, JQL, or field objects;
- permits only configured projects, issue types, parent/type pairs, assignees, labels, versions, sprints, and custom field IDs;
- rejects incomplete or cyclic graphs and all unknown input fields;
- re-discovers paginated project-scoped issue-type and create-field metadata rather than using Jira's deprecated broad create-metadata endpoint;
- verifies the configured estimate is a current numeric custom field, the configured Sprint field has Jira Software's `gh-sprint` schema, and every supplied version or sprint appears in current selectable values;
- fails if a required tenant field is unsupported instead of silently dropping it;
- verifies that every supplied assignee is active and currently assignable to the exact project;
- re-reads Notion authority before each provider mutation;
- creates parents before children and dependencies after all nodes;
- writes a deterministic label and the `notion.cookbook.plan-node` Jira issue property on every created issue;
- durably records a non-expiring, numbered request fence before every issue or link POST;
- treats timeouts, transport failures, `408`, `5xx`, and malformed, truncated, or oversized successful mutation responses as outcome-unknown;
- never posts through an unresolved fence; replay may only reconcile provider state;
- permits a later numbered POST only after an endpoint-specific definite rejection or a proven pre-request stop;
- protects every state transition with the publication owner, live lease token, fencing epoch, exact previous bytes, and monotonic transition checks;
- binds the operation, durable state, and receipt to a fingerprint of the Jira cloud/site, project ID/key, field policy, and link policy;
- writes a bounded canonical receipt to the same Notion page.

The externally visible center is the series of Jira issue creates followed by issue-link creates. Jira does not offer one atomic graph transaction, so the Worker is deliberately resumable rather than claiming cross-SaaS atomicity.

## Supported graph

This first recipe supports a deliberately narrow Jira graph:

- 1–15 nodes in one configured Jira project;
- maximum hierarchy depth of two parent edges, such as Epic → Story → Subtask;
- any number of hierarchy edges implied by those 15 nodes, provided each path stays within that depth;
- tenant-configured parent issue-type pairs;
- current Jira subtask semantics: a subtask needs a parent, cannot parent another node, and a depth-two node must use a currently discoverable subtask type;
- 0–30 acyclic directed “blocks” dependencies;
- up to 10 allowlisted labels per node and 10 unique approved assignees per plan;
- one optional allowlisted fix version, sprint, and integer estimate from 0–100 per node.

This is not a generic Jira hierarchy engine. Jira hierarchy rules vary by tenant, project type, and plan. `parentTypePairs` makes the supported relationship explicit, while fresh metadata verifies that each issue type and field remains creatable.

## What happens in one call

1. Runtime validation canonicalizes the complete graph and verifies `planHash`.
2. The Worker fingerprints the configured provider/policy boundary, then derives `jira-plan:<sha256>` from that fingerprint plus the source page, approval revision, plan hash, and project.
3. The invocation-scoped `context.notion` client first verifies exact Rich text revision/hash without reserving the page. New or unfinished Jira work also requires current Status/Select approval; receipt-only recovery validates the durable completed graph without reopening Jira write authority. A non-empty receipt is accepted only when it is byte-for-byte the already checkpointed, fully bound canonical receipt.
4. For an unfinished or new publication, Jira verifies the current site URL and exact project ID/key pair; paginates `GET /rest/api/3/issue/createmeta/{project}/issuetypes` and the per-issue-type field endpoint; validates numeric-estimate and Jira Software Sprint schemas plus affirmative version/Sprint selectability; checks the issue-link type; and verifies approved accounts are active and assignable. A failure here consumes no permanent claim.
5. Notion approval and the empty Rich text receipt are re-read immediately before one Redis Lua operation atomically binds the source page/project and initializes operation state.
6. A Redis lease with a monotonically increasing fencing epoch serializes the publication. Every save is a Lua compare-and-swap over the claim owner, live lease value, and exact prior state.
7. Nodes run in deterministic parent-first/key order. A marker match is accepted only when the operation property and all governed, explicitly supplied Jira fields read back exactly. `null` optional values are omitted and mean “use the provider default,” not “assert Jira stored null.”
8. Immediately before each Jira POST, the Worker renews its lease and re-reads Notion authority. It then checkpoints a numbered `fenced` disposition before sending the request.
9. A definite documented rejection records `definitely_rejected` and alone permits a later attempt. Any uncertain post-boundary outcome records `outcome_unknown`; replay only searches/read-backs and never reposts that node or link.
10. Dependencies are read before write, created outward from blocker to blocked issue, read back, and checkpointed individually under the same fence rules.
11. A stable receipt containing the approval identity, provider-policy fingerprint, timestamps, exact node/dependency map, and operation identity is checkpointed, written to Notion, read back exactly, and then marked complete in Redis.

Notion is the approval source of truth. Jira is the work-item source of truth after publication. Redis is the durable procedure ledger and concurrency boundary; it is not presented to the model.

## Agent-facing instructions

### Use this tool when

- a human has explicitly approved the exact Notion revision and canonical plan hash;
- the caller already has the complete bounded graph;
- every destination, issue type, person, label, sprint, version, estimate, parent, and dependency is explicit;
- this is the first publication from that Notion page into that Jira project;
- a prior call is retryable and the caller can resend the exact same complete input.

### Do not use this tool when

- approval is implied by prose or conversation rather than the configured properties;
- the plan still needs decomposition, owner selection, field discovery, or Jira exploration;
- the user wants one ticket, a comment, a transition, or an edit to an existing issue;
- the Notion page already published an initial graph and now needs a changed plan;
- the graph exceeds the limits, spans projects, or needs a hierarchy deeper than two;
- a Jira issue carrying this Worker's marker has manual field drift;
- the task requires arbitrary fields, JQL, transitions, status changes, attachments, comments, notifications, or deletion.

Later approved changes belong in a separately reviewed `reconcileApprovedPlan` tool. That tool is intentionally not included in this recipe.

### Pasteable Custom Agent instruction

> Use `publishImplementationPlan` only after a human explicitly approves the exact Notion Approval revision and Approved plan hash. Pass the complete graph once: one allowlisted Jira project, 1–15 nodes, maximum hierarchy depth two, and at most 30 directed dependencies. Do not infer IDs, omit configured values, create a single issue, or use this for later edits. Confirm the project, node count, and externally visible Jira creation before calling. If the result is `ambiguous` or `partial_failure`, surface its node/dependency receipt, satisfy any explicit `repair` prerequisite such as restoring the same approval, and retry only the identical input; never construct a replacement plan.

## Tool contract

The tool key is `publishImplementationPlan`. It is a write tool and declares `readOnlyHint: false`.

### Minimal input

```json
{
  "approvalPageId": "11111111111111111111111111111111",
  "approvalRevision": "revision-7",
  "planHash": "6d798f81855a55f0bd2f899f351c324b9ae1d11fe8e1adfb3543b1a8dd4c710b",
  "projectKey": "ENG",
  "nodes": [
    {
      "nodeKey": "payments-epic",
      "issueTypeId": "10001",
      "parentNodeKey": null,
      "summary": "Move checkout to the payments platform",
      "description": "Coordinate the approved checkout migration.",
      "assigneeAccountId": "fake-account-id",
      "labels": ["approved-plan"],
      "estimatePoints": 8,
      "sprintId": 30001,
      "fixVersionId": "20001"
    },
    {
      "nodeKey": "tokenize-cards",
      "issueTypeId": "10002",
      "parentNodeKey": "payments-epic",
      "summary": "Tokenize stored cards",
      "description": "Move stored-card reads to the token service.",
      "assigneeAccountId": "fake-account-id",
      "labels": ["approved-plan"],
      "estimatePoints": 5,
      "sprintId": 30001,
      "fixVersionId": "20001"
    }
  ],
  "dependencies": [
    {
      "blockerNodeKey": "payments-epic",
      "blockedNodeKey": "tokenize-cards"
    }
  ]
}
```

`nodeKey` is caller-defined stable identity within the plan. It is not a Jira key. `parentNodeKey` and dependency fields may reference only nodes in the same complete input.

For `assigneeAccountId`, `estimatePoints`, `sprintId`, and `fixVersionId`, `null` means the field is omitted and Jira may apply its configured default. It does not request an explicit clear and the Worker does not falsely assert that Jira stored null. When a sprint is supplied, readback validates the sprint ID inside Jira's current structured sprint list representation.

Compute the hash from a JSON file containing the complete input (a placeholder `planHash` is ignored):

```sh
npm run fingerprint -- ./sandbox-plan.json
```

Store the printed lowercase SHA-256 in both the file's `planHash` and the Notion **Approved plan hash** property before approval.

### Completed receipt

```json
{
  "ok": true,
  "status": "completed",
  "operationId": "jplan_9f0d3a85d75a34cc1e5f09ce",
  "idempotencyKey": "jira-plan:9f0d3a85d75a34cc1e5f09cecf07d3d69b3324f3206888b9b1b9f26484a31e23",
  "changed": true,
  "replay": false,
  "projectKey": "ENG",
  "planHash": "6d798f81855a55f0bd2f899f351c324b9ae1d11fe8e1adfb3543b1a8dd4c710b",
  "approvalPageId": "11111111111111111111111111111111",
  "approvalRevision": "revision-7",
  "providerPolicyFingerprint": "8d7f0b886d44a673f7bb0abe14ac2b353c66b8a98353f6729a3e12862f57a862",
  "startedAt": "2026-07-03T15:10:00.000Z",
  "completedAt": "2026-07-03T15:10:08.000Z",
  "nodes": [
    {
      "nodeKey": "payments-epic",
      "issueId": "21001",
      "issueKey": "ENG-41",
      "url": "https://example.atlassian.net/browse/ENG-41",
      "action": "created"
    },
    {
      "nodeKey": "tokenize-cards",
      "issueId": "21002",
      "issueKey": "ENG-42",
      "url": "https://example.atlassian.net/browse/ENG-42",
      "action": "created"
    }
  ],
  "dependencies": [
    {
      "blockerNodeKey": "payments-epic",
      "blockedNodeKey": "tokenize-cards",
      "action": "created"
    }
  ],
  "notionReceiptWritten": true,
  "steps": [
    {
      "name": "approval",
      "status": "completed",
      "detail": "Exact approval revision and canonical plan hash re-read"
    },
    {
      "name": "claim",
      "status": "completed",
      "detail": "Atomic publication claim and durable per-step ledger held"
    },
    {
      "name": "metadata",
      "status": "completed",
      "detail": "Current issue types, fields, users, and link type validated"
    },
    {
      "name": "nodes",
      "status": "completed",
      "detail": "2 hierarchy nodes resolved"
    },
    {
      "name": "dependencies",
      "status": "completed",
      "detail": "1 dependency links resolved"
    },
    {
      "name": "notion_receipt",
      "status": "completed",
      "detail": "Canonical graph receipt written to the approved Notion page"
    }
  ],
  "warnings": [],
  "retryable": false,
  "retryAfterSeconds": null,
  "repair": null
}
```

The successful receipt includes one record for every node and dependency. Provider response bodies, tokens, and arbitrary Jira text are never returned.

## Replay and failure behavior

| Scenario                                                      | Result                         | Writes and next action                                                                                                                         |
| ------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Completed identical replay                                    | `no_op`                        | No Jira or Notion write; returns the same canonical IDs with `changed: false` and `replay: true`.                                              |
| Concurrent identical call                                     | `blocked`                      | No Jira write; retry after `retryAfterSeconds` with identical input.                                                                           |
| Different revision on an already-claimed page/project         | `conflict`                     | No second initial graph. Use a separately approved reconcile workflow.                                                                         |
| Stale status, revision, or hash                               | `conflict`                     | Zero provider writes. Correct the approved packet; do not alter the call to bypass it.                                                         |
| Approval is revoked after partial Jira work                   | `partial_failure`              | Preserves the durable graph. Restore the exact same approved revision/hash, then replay the identical input.                                   |
| Changed issue type, field, required field, user, or link type | `conflict`                     | Zero new Jira writes during preflight. Update policy/approval deliberately.                                                                    |
| Jira documented definite write rejection                      | `blocked` or `conflict`        | Only create `400/401/403/422` and link `400/401/404/413` rearm a fence; after the cause is fixed, identical replay may create a later attempt. |
| Jira `429` on a read                                          | `blocked`                      | Reads retry once and honor a bounded delay; receipt carries bounded `retryAfterSeconds` if still limited.                                      |
| Jira `429` or any undocumented status after a POST            | `ambiguous`                    | The POST is never repeated. `retryable: true` means an identical replay may safely reconcile the non-expiring fence.                           |
| Retryable `5xx` on a read                                     | `blocked`                      | One bounded read retry; safe identical replay is allowed.                                                                                      |
| Proven stop before a request                                  | `blocked`                      | Records a definite no-request disposition; identical replay may create a later numbered attempt.                                               |
| Write `408` / `5xx`, timeout, transport loss, or bad `2xx`    | `ambiguous`                    | The pre-POST fence becomes `outcome_unknown`. It never expires and cannot be rearmed; replay only reconciles.                                  |
| Ambiguous issue create                                        | `ambiguous`                    | Replay searches its deterministic marker and verifies the operation property and all supplied fields; it never blindly posts again.            |
| Ambiguous dependency create                                   | `ambiguous`                    | Replay reads exact outward link state. An unresolved fence is never posted again.                                                              |
| Partial node or dependency success                            | `partial_failure`              | Receipt lists created/existing/failed/unknown records. Identical replay resumes only unfinished idempotent reads and writes.                   |
| Notion receipt write fails after Jira completes               | `partial_failure`              | Stable receipt and timestamps remain in Redis. Replay performs receipt-only completion and does not repeat Jira work.                          |
| Completed Redis state has an empty Notion receipt             | `completed`                    | Restores the exact canonical receipt even after approval revocation; does not repeat Jira reads or writes.                                     |
| Notion update response is lost                                | Completed or `partial_failure` | Exact readback resolves an applied write; otherwise replay checks again.                                                                       |

An `ambiguous` result is intentionally conservative. It does not claim that Jira rolled back or that no object exists.

## Idempotency and durable state

The logical idempotency key binds:

```text
source Notion page ID + explicit approval revision + canonical plan hash + Jira project + provider/policy fingerprint
```

Durable state lives in a dedicated Redis database reached through its HTTPS REST API. A Lua script atomically creates both the page/project publication claim and initial operation ledger. A second Lua operation acquires a token plus monotonically increasing lease epoch. Every state save is a Lua compare-and-swap that verifies the publication owner, live token/epoch, exact previous bytes, and monotonic transition. This is the concurrency boundary; a Jira marker search or Notion row lookup is not treated as a lock.

Every resumed state must preserve the exact ordered approved node keys, dependency edges, and deterministic markers. Redis refuses a receipt-stage or completed state unless every Jira checkpoint is terminal and accepted, so a corrupt or incomplete graph cannot be certified by a stored receipt.

Each issue create carries:

- a deterministic `ntn-…` Jira label used only for bounded readback;
- the `notion.cookbook.plan-node` issue property containing version, operation ID, plan hash, compact source page ID, and node key.

A marker match is accepted only after the property and governed fields match exactly. Redis checkpoints the immutable Jira ID/key/URL after every node and each dependency status. Jira issue-link creation reports duplicate links as created, but this recipe still reads exact outward-link state and does not rely on that behavior as its concurrency primitive.

## Quickstart

### Prerequisites

- Node.js 22+ and npm 10.9.2+
- a Jira Cloud sandbox project with issue linking enabled
- an Atlassian service account or dedicated automation account
- a scoped Atlassian API token
- a dedicated Redis/Upstash database that supports `EVAL`, `GET`, `SET`, `INCR`, `PSETEX`, `PEXPIRE`, `PTTL`, and `DEL`
- a Notion database page shared with the Custom Agent
- the Notion Workers CLI and permission to deploy a Worker

### 1. Install and verify offline

```sh
cd workers/jira-publish-implementation-plan
npm ci
npm run format:check
npm run check
npm test
npm run build
```

Normal tests are deterministic and use no Jira, Notion, or Redis credentials.

### 2. Prepare the Notion approval database

Create these properties with the exact configured types:

| Property                   | Type             | Before a call                                         |
| -------------------------- | ---------------- | ----------------------------------------------------- |
| `Approval status`          | Status or Select | Exactly `Approved` only after human review.           |
| `Approval revision`        | Rich text        | Explicit bounded revision such as `revision-7`.       |
| `Approved plan hash`       | Rich text        | Lowercase SHA-256 printed by the fingerprint command. |
| `Jira publication receipt` | Rich text        | Empty; the Worker owns the first write.               |

The deployed tool uses the invocation-scoped Notion client. Do not configure a separate Notion token.

### 3. Prepare Jira

1. Use a sandbox project first.
2. Confirm the account has Browse Projects and Create Issues in the allowlisted project.
3. Add Assign Issues only if `assigneeAccountId` is used.
4. Add Link Issues for the outward/blocker project and enable issue linking.
5. Grant Browse Users and Groups so the Worker can verify configured account IDs are active, and ensure each configured assignee is assignable to the project.
6. Confirm every supplied field is on the issue type's create screen. The Worker rejects unknown required fields.
7. Create a scoped API token. Atlassian recommends scoped tokens and documents the `api.atlassian.com/ex/jira/{cloudId}` URL used here.
8. Retrieve the site's cloud ID at `https://<site>.atlassian.net/_edge/tenant_info`.

### 4. Configure policy

Copy `.env.example` only for local development. For deployment, set secrets and policy through the Workers CLI.

`JIRA_ALLOWED_PROJECTS_JSON` is an array of at most ten objects:

| Field                     | Meaning                                                                     |
| ------------------------- | --------------------------------------------------------------------------- |
| `projectKey`, `projectId` | Exact immutable destination pair.                                           |
| `issueTypeIds`            | At most 20 issue type IDs the tool may create.                              |
| `parentTypePairs`         | Explicit `parentId>childId` combinations.                                   |
| `assigneeAccountIds`      | Exact active accounts the agent may select.                                 |
| `labels`                  | Exact business labels the agent may supply.                                 |
| `fixVersionIds`           | Exact versions allowed in this project.                                     |
| `sprintIds`               | Exact numeric sprints allowed in this project.                              |
| `fieldIds.estimate`       | Numeric tenant story-point field ID, or `null` to disable estimates.        |
| `fieldIds.sprint`         | Jira Software `gh-sprint` field ID, or `null` to disable sprint assignment. |

The Worker adds its own deterministic marker label; callers cannot choose it.

### 5. Deploy and set environment

```sh
npm install --global ntn
ntn login
ntn workers deploy --name jira-publish-implementation-plan
ntn workers env set JIRA_CLOUD_ID=00000000-0000-0000-0000-000000000000
ntn workers env set JIRA_SITE_URL=https://example.atlassian.net
ntn workers env set JIRA_EMAIL=worker-service-account@example.com
ntn workers env set JIRA_API_TOKEN=replace-with-a-scoped-token
ntn workers env set JIRA_ALLOWED_PROJECTS_JSON='[{"projectKey":"ENG","projectId":"10000","issueTypeIds":["10001","10002","10003"],"parentTypePairs":["10001>10002","10002>10003"],"assigneeAccountIds":["fake-account-id"],"labels":["approved-plan"],"fixVersionIds":["20001"],"sprintIds":[30001],"fieldIds":{"estimate":"customfield_10016","sprint":"customfield_10020"}}]'
ntn workers env set JIRA_DEPENDENCY_LINK_TYPE_ID=10000
ntn workers env set JIRA_DEPENDENCY_LINK_TYPE_NAME=Blocks
ntn workers env set UPSTASH_REDIS_REST_URL=https://example.upstash.io
ntn workers env set UPSTASH_REDIS_REST_TOKEN=replace-with-a-redis-rest-token
```

Set the optional `NOTION_*` variables only if your database uses different property names or approved status.

### 6. Attach to a Notion Agent

After deployment, open the Custom Agent, go to **Tools and access**, add the Worker connection, enable only `publishImplementationPlan`, and paste the agent instruction above. Give the agent access only to the approval database and supporting pages it needs.

## Permissions and secrets

| System                   | Minimum access used by this recipe                                                                                                                                                                                                                                                                                                               | Why                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jira scoped API token    | Classic `read:jira-work`, `write:jira-work`, and `read:jira-user`; for granular OAuth/app auth, include project, issue, issue type/meta, field, field-configuration, user, issue-property, issue-link, and issue-link-type reads plus issue, issue-property, and issue-link writes. Verify the exact scopes against every endpoint linked below. | Verify the live site/project pair, discover create metadata, verify assignability and existing markers, create issues/properties, and create/read dependencies. |
| Jira project permissions | Browse Projects, Create Issues, Link Issues; Assign Issues only when owners are supplied.                                                                                                                                                                                                                                                        | Runtime authority still follows the acting Jira account and tenant screens.                                                                                     |
| Jira global permission   | Browse Users and Groups.                                                                                                                                                                                                                                                                                                                         | Verify each allowlisted account ID is active and query project assignability without exposing email addresses.                                                  |
| Notion invocation        | Retrieve and update the approved page shared with the agent.                                                                                                                                                                                                                                                                                     | Re-read authority and write the receipt. No `NOTION_API_TOKEN` is used.                                                                                         |
| Redis REST token         | Read/write and Lua execution on one dedicated database.                                                                                                                                                                                                                                                                                          | Atomic claim, lease, and durable operation checkpoints.                                                                                                         |

The acting Jira identity is the configured shared service or automation account, not the human invoking the agent. The API token and Redis token exist only in Worker environment variables. They are placed in request headers inside execution and never returned, stored in Notion/Jira, logged by this code, or included in test fixtures.

Approved summaries and descriptions, Jira IDs/URLs, account IDs, labels, and the Notion page ID can reach the model-visible tool input or receipt. Jira and Notion content is treated as untrusted text: the Worker never interprets it as instructions, embeds only bounded plain text in fixed Atlassian Document Format, and accepts no arbitrary URL, JQL, header, field object, or provider method.

## Limits

| Resource                              | Hard bound                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Projects in policy                    | 10                                                                                                           |
| Nodes per call                        | 1–15                                                                                                         |
| Hierarchy depth                       | 2 parent edges per path                                                                                      |
| Dependencies                          | 0–30, unique and acyclic                                                                                     |
| Labels                                | 10 per node, all allowlisted                                                                                 |
| Unique assignees                      | 10 per plan, all allowlisted and active                                                                      |
| Summary                               | 180 UTF-8 bytes                                                                                              |
| Description                           | 4,000 UTF-8 bytes per node                                                                                   |
| Canonical plan                        | 80,000 UTF-8 bytes                                                                                           |
| Issue-type or field metadata          | 4 pages × 50 records for each bounded lookup                                                                 |
| Provider HTTP calls                   | 256 per Worker execution; the supported worst-case fresh graph needs at most 210 before bounded read retries |
| Provider phase wall clock             | 55 seconds, with any active request additionally bounded by its smaller remaining budget                     |
| Jira / Notion / Redis request timeout | 8 s / 10 s / 3 s                                                                                             |
| Redis lease                           | 120 s, renewed before each Jira write                                                                        |
| Read retry                            | Once for retryable read failure; `Retry-After` sleep capped at 2 s                                           |
| Response body                         | 1,000,000 bytes from Jira and 256,000 bytes from Redis                                                       |
| Receipt                               | 20,000 UTF-8 bytes; Notion fragments capped at 1,800 bytes                                                   |

The tool does not perform bulk or background jobs, wait for Jira workflow transitions, send notifications, or span projects. It never deletes Jira issues on failure.

## Local and sandbox verification

### Offline checks

```sh
npm ci
npm run format:check
npm run check
npm test
npm run build
```

The tests assert exact API paths, field schemas and selectable values, ordering, headers, request bodies, request fences, Redis lease epochs and compare-and-swap commands, durable topology and terminal completeness, crash-after-apply replay, search lag, write counts, endpoint-specific mutation classification, reconciliation provenance, latest-state recovery after checkpoint failures, partial approval-loss guidance, receipt recovery after approval revocation, readback, redaction, every terminal receipt family, strict Notion property roles, and Notion chunk limits.

### Opt-in sandbox smoke test

Do this only in a disposable Jira project and Notion approval database:

1. Configure one epic-like root type, one standard child type, and one subtask type in `parentTypePairs`.
2. Create a two- or three-node fixture using fake work and no customer data.
3. Run `npm run fingerprint -- ./sandbox-plan.json` and put the hash/revision on the Notion page.
4. Mark the page approved only after comparing the complete JSON to the page.
5. Invoke `publishImplementationPlan` through the attached agent and explicitly confirm the project and node count.
6. Expect `completed`, exact Jira keys/URLs, backlinks on every description, one dependency, and the identical JSON receipt in Notion.
7. Invoke the identical input again. Expect `no_op` and zero new Jira issues or links.
8. Clean up the sandbox issues manually according to your tenant policy. Clear the test receipt and dedicated Redis keys only after retaining any audit evidence you need; use a fresh Notion page for the next initial-publication test.

No live API, smoke test, Worker deployment, or credential mutation is performed by the normal test suite.

## Extension points

Safe, narrow extensions include:

- add one explicitly configured Jira field by validating its field ID, input type, current create metadata, tenant allowlist, canonical hash representation, readback, receipt behavior, and tests;
- lower node/dependency limits for stricter environments;
- replace the shared API token with a refreshable OAuth credential provider while preserving the `JiraGateway` contract;
- adapt Redis storage to another atomic compare/claim service while preserving claim, lease, exact readback, and state validation;
- add `reconcileApprovedPlan` as a separate permission and approval boundary with Jira version preconditions and manual-edit conflicts.

Do not turn the tool into `jiraAction({ method, fields, jql })`, add arbitrary field pass-through, or merge initial publication and later reconciliation into one action selector.

## Project map

```text
src/
├── index.ts            — registers the agent-visible Worker tool
├── schemas.ts          — strict input and output schemas
├── policy.ts           — graph validation, canonical hash, identity, limits
├── config.ts           — environment parsing and tenant allowlists
├── jira.ts             — bounded Jira REST client, metadata and readback
├── ledger.ts           — Redis atomic claim, lease, checkpoints
├── notion.ts           — exact approval reads and receipt writeback
├── orchestrator.ts     — stable, resumable call graph
├── types.ts            — public and durable contracts
└── fingerprint-cli.ts  — canonical plan hash helper

test/
├── orchestrator.test.ts
├── jira.test.ts
├── ledger.test.ts
├── notion.test.ts
└── policy-config.test.ts
```

## Official references

- [Jira create issue, bulk issue, and current scoped create metadata](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/)
- [Jira Software field input formats](https://developer.atlassian.com/cloud/jira/software/rest/intro/#jira-software-field-input-formats)
- [Jira enhanced JQL search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)
- [Jira issue links](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-links/)
- [Jira issue-link types](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-link-types/)
- [Jira issue properties](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-properties/)
- [Jira users](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-users/)
- [Atlassian API-token authentication and scoped-token URL](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/)
- [Find an Atlassian site cloud ID](https://support.atlassian.com/jira/kb/retrieve-my-atlassian-sites-cloud-id/)
- [Jira OAuth scopes](https://developer.atlassian.com/cloud/jira/platform/scopes-for-oauth-2-3LO-and-forge-apps/)
- [Atlassian Rovo MCP supported tools](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/)
- [Notion Workers overview](https://developers.notion.com/workers/get-started/overview)
- [Notion Workers SDK reference](https://developers.notion.com/workers/reference/sdk)
- [Notion prompt-injection guidance](https://www.notion.com/help/how-notion-protects-against-prompt-injection-risks)
- [Repository contributing guide](../../CONTRIBUTING.md)
