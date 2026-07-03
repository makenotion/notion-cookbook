# Worker sync: Workday employee directory

Bring active Workday employees and their current supervisory organizations into
two connected Notion databases. Employees can find colleagues, follow manager
and direct-report relationships, browse organization membership, and open a
native Notion People profile when the employee's work email resolves.

The worker refreshes both databases daily. Workday remains authoritative; this
is an employee directory, not a replica of Workday Org Chart or a source for HR
operations, headcount, provisioning, compliance, or access control.

Only share the databases with an audience for which every published field and
derived relationship is employee-visible. Workday API access and its `Public`
email flag do not establish that audience automatically.

## Quickstart

You need Node.js 22+, npm 10.9.2+, Notion Workers deployment access, and a
dedicated Workday integration user and API client. Start with a non-production
tenant and complete the [Workday access and data visibility](#workday-access-and-data-visibility)
review before sharing the result.

From the repository root:

```sh
npm install --global ntn@latest
cd workers/workday-sync
npm install
ntn login
ntn workers deploy --name workday-sync
ntn workers sync pause organizationsSync
ntn workers sync pause peopleSync
```

The deployment creates **Workday Supervisory Organizations** and **Workday
People**. Keep both syncs paused while you configure credentials and restrict
the databases to the approved Notion audience.

Set the exact tenant values approved by the Workday integration owner:

```sh
ntn workers env set \
  WORKDAY_API_URL=https://tenant1.myworkday.com/ccx/service/example_tenant/Human_Resources/v46.1 \
  WORKDAY_API_VERSION=v46.1 \
  WORKDAY_TOKEN_URL=https://tenant1.myworkday.com/ccx/oauth2/example_tenant/token \
  WORKDAY_CLIENT_ID=your-client-id \
  WORKDAY_CLIENT_SECRET=your-client-secret \
  WORKDAY_REFRESH_TOKEN=your-refresh-token \
  WORKDAY_EFFECTIVE_TIME_ZONE=America/New_York
```

Preview Organizations and then People. Previews call Workday and print employee
data without writing the databases, so protect terminal output.

```sh
ntn workers sync trigger organizationsSync --preview
ntn workers sync trigger peopleSync --preview
```

Before sharing, confirm that:

- the preview contains only the approved employee population and fields;
- manager, direct-report, organization, and member relations resolve;
- Name remains, and Work Email remains when Workday supplies an eligible
  address, even when Notion Profile is empty; and
- active workspace-member, unmatched, guest, deactivated, alias, and
  case-variant email examples behave as the Notion owner expects.

Populate both databases in relation-target order, then start the daily
schedules:

```sh
ntn workers sync trigger organizationsSync
ntn workers sync trigger peopleSync
ntn workers sync resume organizationsSync
ntn workers sync resume peopleSync
```

No recurring CLI action is required. Never commit `.env`, tokens, SOAP
payloads, preview output, or generated `workers.json` state. The worker does not
need a Notion API token.

## What you can answer

| Managed database                      | Questions it helps answer                                                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workday People**                    | Who manages this employee? Who reports to them? Which organization are they in? Can I open their Notion profile or contact them by work email? |
| **Workday Supervisory Organizations** | Who belongs to this organization? How can I navigate from the organization to its employees and reporting relationships?                       |

## Reference

### Synced databases and schedules

| Database                              | Workday resource                           | Schedule  |
| ------------------------------------- | ------------------------------------------ | --------- |
| **Workday Supervisory Organizations** | Current employee supervisory organizations | Every day |
| **Workday People**                    | Active employees and reporting relations   | Every day |

#### Workday People

| Notion property          | Workday source or derivation                       | Type                      |
| ------------------------ | -------------------------------------------------- | ------------------------- |
| Name                     | Explicit `Worker_Descriptor`                       | title                     |
| Work Email               | Public, primary `WORK` email, when present         | email                     |
| Notion Profile           | People resolution requested by Work Email          | people                    |
| Supervisory Organization | Current supervisory organization WID               | relation to Organizations |
| Supervisory Managers     | Manager(s) of the current supervisory organization | self-relation             |
| Direct Reports           | Reciprocal of Supervisory Managers                 | reciprocal relation       |
| Directory Key            | Opaque value derived from the employee WID         | rich text, primary key    |

`Notion Profile` uses the Workers-native `Schema.people()` and
`Builder.people(workEmail)` primitives. The worker requests resolution using
only the normalized Work Email; there is no name, WID, fuzzy, or Notion
users-list lookup. Name and Work Email are separate properties, so they remain
the fallback identity when the People value is empty. If Workday has no eligible
email, Name remains while Work Email and Notion Profile are blank.

A populated People value does not prove that an account is an active workspace
member. Validate hosted resolution for unmatched, guest, deactivated, alias,
and case-variant addresses before sharing the directory.

#### Workday Supervisory Organizations

| Notion property      | Workday source or derivation                   | Type                   |
| -------------------- | ---------------------------------------------- | ---------------------- |
| Name                 | Supervisory organization name                  | title                  |
| Organization Members | Reciprocal of each employee's organization     | reciprocal relation    |
| Directory Key        | Opaque value derived from the organization WID | rich text, primary key |

This database contains supervisory organizations, not Workday Teams,
Workteams, Flex Teams, cost centers, companies, or custom organizations. It
does not include empty organizations, parent hierarchy, or matrix management.

Opaque deterministic keys preserve upserts and relations without publishing raw
WIDs. Hide Directory Key in employee-facing views for presentation, not as an
access-control measure. Duplicate organization names remain visually ambiguous;
use an approved employee-visible disambiguator or explicitly accept that
limitation before launch.

### Project structure

```text
src/
├── index.ts           — registers databases, schedules, and shared client
├── workday.ts         — OAuth, versioned SOAP operations, parsing, and joins
├── sync.ts            — fixed-snapshot state and replace-sync execution
├── people.ts          — People schema and allowlisted transform
├── organizations.ts   — supervisory-organization schema and collapse
├── keys.ts            — deterministic opaque directory keys
└── validation.ts      — shared page, date, and work-email validation
test.ts                — offline privacy, parser, paging, and failure tests
```

### How it works

1. Each run fixes one Workday entry timestamp and tenant-local effective date
   across every page.
2. `Get_Workers` reads active employees in pages of 100, excluding contingent
   workers and broad HR response sections.
3. People pages batch their WIDs into one
   `Get_Change_Work_Contact_Information` request and join the response by WID.
4. The parser accepts only an email whose same usage record is `Public=true`,
   `Primary=true`, and `Communication_Usage_Type_ID=WORK`. It never substitutes
   home, private, secondary, `BUSINESS`, or guessed addresses.
5. The current supervisory management-chain entry supplies direct employee
   managers or co-managers. Full ancestor and matrix chains are not published.
6. Deterministic keys connect People to Organizations and other People without
   exposing raw Workday identifiers.
7. Both syncs use `mode: "replace"`. Stale rows are removed only after the final
   page succeeds, so a partial failure preserves the previous complete result.

The worker fails closed on empty snapshots, drifting totals, incomplete joins,
ambiguous organization membership or email, reused work email, malformed
manager references, more than 100 manager relations, and snapshots above 100
pages or 10,000 employees. Continuation state contains no raw WIDs or emails.

The databases are separate snapshots rather than one atomic transaction. Run
Organizations before People for initial loads and immediate refreshes. At the
10,000-person ceiling, one daily pair can make up to 300 SOAP calls; confirm
that capacity with the Workday integration owner. Manual triggers are useful
for approved immediate refreshes, but manual-only schedules would leave missed
removals and moves stale indefinitely.

Monitor both daily runs. A failed run leaves the last complete snapshot in
Notion, where it can become stale until the next successful run.

### Workday access and data visibility

Use this recipe only when the Workday and Notion owners approve the same
employee-visible directory boundary:

| Boundary   | What this recipe expects                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------ |
| Audience   | A named employee Notion audience; guests, integrations, exports, search, and AI access need explicit review        |
| Population | Active employees in the approved Workday population; inactive and contingent workers are excluded                  |
| Published  | Display name, optional public primary work email, current supervisory organization name, and reporting relations   |
| Derived    | Notion Profile, Supervisory Managers, Direct Reports, Organization Members, and employee-to-organization links     |
| Excluded   | Employee IDs, raw WIDs, job/location data, compensation, demographics, other contact fields, and page body content |
| Authority  | Workday remains authoritative; Notion is an eventually consistent directory                                        |

Workday operation access and the email `Public` flag do not prove that every
Notion viewer may see the result. Once data is copied, the Notion database
sharing boundary replaces Workday's per-viewer security checks. Approve both
source fields and derived inverse relationships for the complete audience.

The standard Workday response sections are broader than the published output:

- `Get_Workers` can transiently include reference IDs, organization-summary
  metadata, and full supervisory and matrix management chains.
- `Get_Change_Work_Contact_Information` can transiently include other work
  addresses, phone numbers, instant-messenger handles, and web addresses.

The parser retains only the fields listed above. If policy forbids these other
fields from leaving Workday even transiently, use a tenant-owned,
security-reviewed source that projects only the approved fields.

For least-privilege access:

1. Create a dedicated non-human Integration System User and constrained
   security group. Do not reuse an administrator or human account.
2. Grant read access only for `Get_Workers` and
   `Get_Change_Work_Contact_Information`; do not grant Put, compensation,
   personal, home-contact, or broad private-worker access.
3. Constrain contextual Integration GET access to the approved worker
   population and required descriptor, supervisory-organization,
   management-chain, and work-contact fields.
4. Register a dedicated API Client for Integrations, activate pending security
   changes, inspect effective access, and test as the integration user.

Validate representative multi-job, international-assignment, top-level,
co-manager, confidential, missing-email, and duplicate-name records before
sharing. Workday tenant security and naming vary; do not copy role names or
assume a field is universally visible because the integration user can read it.

### Configuration reference

| Variable                          | Required | Secret | Description                                                        |
| --------------------------------- | -------- | ------ | ------------------------------------------------------------------ |
| `WORKDAY_API_URL`                 | Yes      | No     | Pinned tenant Human Resources SOAP URL                             |
| `WORKDAY_API_VERSION`             | No       | No     | WWS version; defaults to tested `v46.1` and must match the API URL |
| `WORKDAY_TOKEN_URL`               | Yes      | No     | Matching tenant OAuth token endpoint ending in `/token`            |
| `WORKDAY_CLIENT_ID`               | Yes      | No     | Dedicated API Client for Integrations ID                           |
| `WORKDAY_CLIENT_SECRET`           | Yes      | Yes    | Dedicated API client secret                                        |
| `WORKDAY_REFRESH_TOKEN`           | Yes      | Yes    | Refresh token generated for the dedicated integration user         |
| `WORKDAY_EFFECTIVE_TIME_ZONE`     | Yes      | No     | Owner-approved IANA zone for effective-dated records               |
| `WORKDAY_EXTERNAL_APPLICATION_ID` | No       | No     | Non-sensitive Workday correlation label, at most 50 characters     |

The API and token URLs must be matching Workday-hosted HTTPS tenant endpoints.
Do not put employee data or credentials in the optional correlation label.

### Resetting sync state

Deployments preserve paging state. For an intentional source, schema, parser,
key, or paging-contract change, pause both syncs, deploy, and reset both states:

```sh
ntn workers sync pause organizationsSync
ntn workers sync pause peopleSync
ntn workers sync state reset organizationsSync
ntn workers sync state reset peopleSync
```

Preview and trigger Organizations before People, then resume both schedules.
Client-secret rotation also requires a paired reset because that secret keys
the cross-page email-collision state. A Workday paging-cache expiry also needs a
paired reset; refresh-token-only rotation does not.

If data may be overexposed, restrict both databases and pause both syncs before
investigating. If relations appear incomplete, inspect both runs: a successful
People run does not make an older or failed Organizations run current.

### Adapting the schema

Treat a new field or population as both a product and data-boundary change:

1. Confirm the value is visible to every member of the Notion audience.
2. Add the narrowest Workday response field and an explicit parser path.
3. Add the Notion property and tests for present, missing, and nearby excluded
   values.
4. Update this inventory and repeat preview and sharing review.

For an incompatible source, key, parser, or schema change, bump
`DIRECTORY_SYNC_CONTRACT_VERSION` and follow the paired reset procedure.
Inactive employees, contingent workers, matrix managers, or parent hierarchy
should be separately reviewed datasets rather than flags on this recipe.

### Local testing

Run the deterministic offline checks; they need no Workday credentials:

```sh
cd workers/workday-sync
npm install
npm run check
npm test
npm run build

cd ../..
npm install
npm run verify:all
```

Tests cover schemas, transforms, Workday request construction, privacy
allowlists, pagination, state, authentication, pacing, and failure behavior.
They cannot prove tenant security, Notion sharing, or hosted People resolution;
verify those before sharing the databases.

## Learn more

- [Notion Workers overview](https://developers.notion.com/workers/get-started/overview)
- [Notion Workers sync guide](https://developers.notion.com/workers/guides/syncs)
- [Notion schema and builders](https://developers.notion.com/workers/reference/schema)
- [Workday `Get_Workers` guide](https://developer.workday.com/documentation/GUID-1f289b82-801e-434e-9e5a-aef66bc35179/GetWorkers)
- [Workday `Get_Change_Work_Contact_Information` v46.1](https://community.workday.com/sites/default/files/file-hosting/productionapi/Human_Resources/v46.1/Get_Change_Work_Contact_Information.html)
- [Workday integration and web service limits](https://developer.workday.com/documentation/dan1370797408285/ReferenceIntegrationsandWebServiceLimits)
- [Contributing guide](../../CONTRIBUTING.md)
