# Worker sync: Workday org chart

Create a small, navigable employee directory in Notion from Workday. The Worker
maintains two related databases—**Workday People** and **Workday Teams**—and
refreshes them every hour.

This is an employee-facing directory, not a replica of Workday HCM. It publishes
only display names, supervisory organization names, relationships, and opaque
sync keys. It excludes job, contact, employment, compensation, demographic, and
other private worker data.

## Quickstart

You need Node.js 22+, npm 10.9.2+, Notion Workers deployment access, and a
non-production Workday tenant. Complete the
[least-privilege setup](#least-privilege-setup) before connecting.

From the repository root, run the offline checks, deploy, and disable both sync
capabilities:

```sh
npm install --global ntn
cd workers/workday-sync
npm install
npm run check
npm test
npm run build
ntn login
ntn workers deploy --name workday-sync
ntn workers capabilities disable teamsSync
ntn workers capabilities disable peopleSync
```

The first deployment creates both managed databases. Disable the capabilities
before adding credentials, then restrict both databases' sharing. For later
updates, disable both capabilities before running `ntn workers deploy`. Treat
the generated `workers.json` as local state and do not commit it.

Set the exact values approved by the Workday integration owner:

```sh
ntn workers env set WORKDAY_API_URL=https://tenant1.myworkday.com/ccx/service/example_tenant/Human_Resources/v46.1
ntn workers env set WORKDAY_API_VERSION=v46.1
ntn workers env set WORKDAY_TOKEN_URL=https://tenant1.myworkday.com/ccx/oauth2/example_tenant/token
ntn workers env set WORKDAY_CLIENT_ID=your-client-id
ntn workers env set WORKDAY_CLIENT_SECRET=your-client-secret
ntn workers env set WORKDAY_REFRESH_TOKEN=your-refresh-token
ntn workers env set WORKDAY_EFFECTIVE_TIME_ZONE=America/New_York
```

Preview Teams and then People. Previews call Workday and print directory data
without writing the databases, so treat terminal output as internal employee
data.

```sh
ntn workers sync trigger teamsSync --preview
ntn workers sync trigger peopleSync --preview
```

Before any real sync, a Workday administrator must compare representative
employees across countries, companies, organizations, and management levels
with what ordinary employees can navigate. A Notion owner must approve both
databases' workspace, teamspace, guest, search, export, and agent access. Narrow
either boundary if a preview is broader.

After approval, populate the databases in the same order:

```sh
ntn workers sync trigger teamsSync
ntn workers sync trigger peopleSync
```

Inspect both results while the capabilities remain disabled. Then enable hourly
operation:

```sh
ntn workers capabilities enable teamsSync
ntn workers capabilities enable peopleSync
```

Never commit `.env`, tokens, client secrets, SOAP payloads, or `workers.json`.
The Worker does not need a Notion API token; the Workers platform owns the
managed-database write path.

## What you can answer

| Managed database   | Questions it helps answer                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **Workday People** | Which supervisory organization is this employee in? Who is their manager? Who reports to them?                                 |
| **Workday Teams**  | Who belongs to this supervisory organization? How can I navigate from a team to its members and their reporting relationships? |

The first Teams-then-People pair creates one page per visible active employee
and supervisory organization. Team, Managers, Members, and Direct Reports make
the graph navigable without copying lists as text.

Here, a **Team** is the employee's current supervisory organization, not a
Workteam, Flex Team, cost center, company, or custom organization. Empty
organizations are absent because the source is `Get_Workers`.

Do not use this directory for HR operations, headcount, access control,
compliance, analytics, or provisioning. Workday remains authoritative; Notion
has hourly rather than transactional freshness.

## Reference

### Synced databases and schedules

| Database           | Workday resource                   | Schedule   |
| ------------------ | ---------------------------------- | ---------- |
| **Workday Teams**  | Current supervisory organizations  | Every hour |
| **Workday People** | Active employees and org relations | Every hour |

#### Workday People

| Notion property | Workday source                | Type                          |
| --------------- | ----------------------------- | ----------------------------- |
| Name            | Explicit `Worker_Descriptor`  | title                         |
| Team            | Current supervisory org WID   | relation to **Workday Teams** |
| Managers        | Current management references | self-relation                 |
| Direct Reports  | Reciprocal of Managers        | reciprocal relation           |
| Directory Key   | Digest of the employee WID    | rich text, primary key        |

#### Workday Teams

| Notion property | Workday source                     | Type                   |
| --------------- | ---------------------------------- | ---------------------- |
| Name            | Supervisory organization name      | title                  |
| Members         | Reciprocal of each employee's Team | reciprocal relation    |
| Directory Key   | Digest of the organization WID     | rich text, primary key |

Names are display values, never keys. Each primary key is a domain-separated
SHA-256 digest of the stable Workday WID, truncated to 128 bits and prefixed
with `wd-person-` or `wd-team-`. Raw WIDs remain in memory and never become a
Notion property or page body.

A referenced manager can be outside the visible active-employee population, so
some relations may have no target. Notion accepts at most 100 pages in one
relation value; the Worker fails rather than truncating an employee with more
than 100 distinct managers.

### Project structure

```text
src/
├── index.ts      — registers both databases and hourly replace syncs
├── workday.ts    — configuration, OAuth, SOAP, correlation, and paging
├── sync.ts       — fixed snapshot state and replace-sync execution
├── people.ts     — People schema and allowlisted transform
├── teams.ts      — Teams schema and per-page organization collapse
├── keys.ts       — domain-separated opaque directory keys
└── validation.ts — shared page and date validation
test.ts           — offline privacy, parser, paging, and failure tests
```

### How it works

This recipe uses the versioned Workday Web Services
`Human_Resources/Get_Workers` operation. It provides employee criteria, a
selective response group, and consistent paging for a scheduled batch snapshot.
The tested version is `v46.1`; other versions require validation.

Each Teams or People cycle follows the same flow:

1. Create one Workday client for the Worker runtime and obtain a cached,
   short-lived OAuth access token. Renew it once after an HTTP 401.
2. Fix one `As_Of_Entry_DateTime` across every page and derive one effective
   date in `WORKDAY_EFFECTIVE_TIME_ZONE`, preventing mid-run movement and
   midnight ambiguity.
3. Request active employees, excluding contingent workers, with only the
   response sections needed for names, current supervisory organizations, and
   management relationships.
4. Read pages of 100 workers, reusing the same two as-of values on every page.
5. Parse only allowlisted fields, derive opaque keys, and emit Team or People
   upserts.
6. Finish with `hasMore: false`. Only a completed replace cycle lets the Workers
   runtime remove rows no longer returned by Workday.

The Worker rejects empty results or pages, duplicates, changed totals, wrong
page numbers, missing management-chain data, and snapshots above 100 pages or
10,000 employees. A top-level employee may have a present chain entry with no
manager; an absent section is not “no manager.”

Page 1 has no client timeout because Workday builds its paging cache there.
OAuth calls and later pages have a 60-second deadline; responses are capped at
64 KiB for OAuth and 5 MiB for SOAP. Both syncs share a four-request-per-second
pacer and surface overload responses for runtime retry.

Pagination state includes a version and non-secret source-contract fingerprint.
A resumed run fails before fetching if the endpoint, WWS version, time zone,
API client ID, or contract changed. Secret and refresh-token rotations remain
compatible. Deployments do not clear state; intentional changes require the
[state reset procedure](#operations-and-troubleshooting).

Teams and People may capture different instants. Earlier upserts can be visible
if a later page fails, but stale rows are deleted only after the final page. The
next successful pair converges the graph.

### Privacy and Workday access

The output is an allowlist. Additional Workday permission does not make another
field safe to publish.

| Published output                            | Purpose                                |
| ------------------------------------------- | -------------------------------------- |
| Employee display name                       | Find a colleague                       |
| Current supervisory organization name       | Find and browse a team                 |
| Team, manager, member, and report relations | Navigate the org graph                 |
| Opaque `Directory Key`                      | Stable upserts without publishing WIDs |

The request and transform exclude:

- Inactive and contingent workers
- Workday IDs, employee IDs, user IDs, profile links, and external IDs
- Job, position, location, organization, worktag, and contact information
- Employment dates and status, compensation, benefits, payroll, time, absence,
  performance, talent, recruiting, and disciplinary information
- Government IDs and other personal or demographic attributes
- Page body content and raw SOAP payloads in Notion or logs

The response group is narrow, and the transform separately allowlists output.
Generic reference `Descriptor` values are ignored because they can contain
tenant-formatted text. Missing explicit names fail the run.

Names and reporting relationships remain personal data. Once copied, Workday
security no longer evaluates each Notion view; sharing both databases is the
destination security boundary. Use the
[operations procedure](#operations-and-troubleshooting) for overbroad output or
a legitimate zero population.

#### Least-privilege setup

1. Create a dedicated Integration System User and constrained security group.
   Do not reuse a human account, tenant administrator, or broadly privileged
   identity. Disable interactive sessions where supported, and assign an owner
   for access review and credential rotation.
2. Authorize only `Get_Workers`. `Worker Data: Public Worker Reports` provides
   invocation. On `Worker Data: Workers`, add the caller's constrained security
   group to **Integration GET** and remove **All Users** from that policy. Limit
   field access to the public worker descriptor, current supervisory
   organization, and required management references. Do not grant Put, private
   worker reports, personal, contact, employment, or compensation data.
3. Activate pending security changes and test as the ISU. A successful response
   does not prove ordinary employees can see the same population; tenant
   policies must be checked during the Quickstart approval review.

Use **View Security for Securable Item** and tenant policy reports to trace the
exact fields. Workday task and policy names can vary by tenant.

#### OAuth and endpoints

Register a dedicated **API Client for Integrations** with only the functional
scope for this read path, then generate its refresh token for the ISU. Copy the
token endpoint from **View API Clients** and keep both secrets in Worker storage.

The supported source is a tenant `/ccx/service/.../Human_Resources/vN.N` SOAP
endpoint, not the Developer Site API Gateway, REST, or Reports-as-a-Service.

### Configuration reference

| Variable                          | Required | Secret | Description                                                                 |
| --------------------------------- | -------- | ------ | --------------------------------------------------------------------------- |
| `WORKDAY_API_URL`                 | Yes      | No     | Exact tenant Human Resources SOAP URL; version must match the setting below |
| `WORKDAY_API_VERSION`             | No       | No     | Pinned `vN.N` WWS version; defaults to tested `v46.1`                       |
| `WORKDAY_TOKEN_URL`               | Yes      | No     | Exact tenant OAuth token endpoint ending in `/token`                        |
| `WORKDAY_CLIENT_ID`               | Yes      | No     | Dedicated API Client for Integrations ID                                    |
| `WORKDAY_CLIENT_SECRET`           | Yes      | Yes    | Dedicated API client secret                                                 |
| `WORKDAY_REFRESH_TOKEN`           | Yes      | Yes    | Refresh token generated for the dedicated ISU                               |
| `WORKDAY_EFFECTIVE_TIME_ZONE`     | Yes      | No     | Owner-approved IANA zone for effective-dated records                        |
| `WORKDAY_EXTERNAL_APPLICATION_ID` | No       | No     | Non-sensitive Workday log-correlation label, at most 50 characters          |

Both URLs reject non-Workday hosts, nonstandard ports, embedded credentials,
query strings, and fragments. They must share an origin and tenant segment.
`WORKDAY_API_URL` must contain the configured version and point to the Human
Resources service, not a home page, API Gateway, WSDL, REST, or RaaS URL.

When `WORKDAY_EXTERNAL_APPLICATION_ID` is set, every SOAP attempt includes it as
`wd-external-application-id` and generates a fresh
`wd-external-request-id`. These headers help a Workday administrator correlate
server logs. Never put employee data or credentials in the application label.

### Operations and troubleshooting

Inspect capability state and recent runs with:

```sh
ntn workers sync status
ntn workers runs list
ntn workers runs logs <run-id>
```

| Event                                     | Action                                                                                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Regular access review                     | Re-run both previews and compare representative Workday visibility, Notion sharing, export, search, guest, and agent access.                                |
| Credential rotation                       | Set the new secret, run both previews, and revoke the old credential only after both succeed.                                                               |
| Workday security-policy change            | Disable both capabilities and preview immediately. If visibility remains nonzero, the next complete replace cycles remove hidden rows.                      |
| Legitimate zero population                | Restrict both databases, disable both capabilities, confirm with the Workday owner, then use the workspace's approved process to remove the databases.      |
| Overbroad output or suspected exposure    | Restrict Notion sharing first, disable both capabilities, rotate credentials if needed, correct the source, and repeat the approval review before enabling. |
| WWS, source, key, schema, or state change | Disable both capabilities, validate in a non-production tenant, deploy, reset both states as below, and repeat the approval review.                         |
| Interrupted or stuck pagination           | Inspect logs and retry promptly. If more than two hours passed between pages or Workday reports expired paging optimization, reset both states as below.    |

For an intentional incompatible change, disable both capabilities, deploy and
configure the intended contract, then reset both states:

```sh
ntn workers sync state reset teamsSync
ntn workers sync state reset peopleSync
```

Repeat the Quickstart previews, approvals, real triggers, and enable steps. A
short transient failure under the same contract normally needs a retry; Workday
paging-cache expiry requires the paired reset.

Common failures:

- **OAuth `invalid_client`, `invalid_grant`, or HTTP 401:** confirm the client
  ID, secret, refresh token, token endpoint, API-client status, and ISU status.
  Never print an access token while diagnosing authentication.
- **HTTP 403 or a Workday security fault:** verify Get-only operation access,
  invocation and contextual domains, field security, and pending policy
  activation. Do not solve this by assigning an administrator role.
- **Version, XML, or incompatible-state error:** confirm the configured version,
  URL version, tenant-supported schema, and state contract agree. Use the reset
  procedure only for an intentional contract change.
- **No employees:** the run fails closed and preserves existing rows. Confirm
  the ISU still sees active employees. Do not bypass the guard to clear data.
- **Missing management-chain data:** verify field security for that response
  section. An empty matching entry is valid for a top-level employee; an absent
  section is not.
- **Missing or excessive relations:** a target must be an active employee
  visible to the ISU. Correct source data if Managers exceeds 100; the Worker
  never truncates the relation.
- **Inconsistent organization name or snapshot totals:** inspect effective
  dating and tenant data, then retry after Workday returns a consistent
  snapshot.
- **Rows update but stale rows remain:** inspect the final page. Replace mode
  skips stale-row deletion until a run completes with `hasMore: false`.
- **Repeated throttling or slow backfill:** retain the 100-record page size,
  review tenant integration limits, and let pacing and runtime retries protect
  Workday.

### Adapting the schema safely

Treat any new field or population as a privacy, security, product, and API
change, not just a schema edit.

1. State the employee question and verify ordinary employees can already see
   the field across all relevant Workday populations.
2. Review contextual and field security with the Workday owner. Do not grant a
   broad response section for one field.
3. Add the smallest versioned SOAP field and an explicit parser path. Never
   pass through an XML subtree or serialize an upstream object.
4. Approve the property's sharing, search, export, relation, and agent effects.
5. Test both inclusion of the approved field and exclusion of nearby sensitive
   fields. Update this privacy inventory.
6. Validate in a non-production tenant and repeat the representative employee
   comparison before production use.

Keep raw WIDs inside the Workday and transform boundary and derive relations
through `keys.ts`. An incompatible source, parser, key, schema, or paging change
requires bumping `DIRECTORY_SYNC_CONTRACT_VERSION` and following the paired
state reset procedure. Adding inactive or contingent workers should be a
separately reviewed dataset.

### Local testing

All repository checks are deterministic and require no Workday credentials:

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

The offline suite cannot prove tenant-specific field security, effective-dated
data quality, OAuth policy, service limits, Notion sharing, or hosted resolution
of a manager relation whose target arrives on another page. Use the Quickstart
preview and approval flow for those boundaries.

## Learn more

- [Notion Workers overview](https://developers.notion.com/workers/get-started/overview)
- [Notion Workers sync guide](https://developers.notion.com/workers/guides/syncs)
- [Notion request limits](https://developers.notion.com/reference/request-limits)
- [Workday `Get_Workers` guide](https://developer.workday.com/documentation/GUID-1f289b82-801e-434e-9e5a-aef66bc35179/GetWorkers)
- [Workday response-filter guidance](https://developer.workday.com/documentation/jas1383238226367/ConceptWorkdayWebServicesResponseFilterElement)
- [Workday integration and web service limits](https://developer.workday.com/documentation/dan1370797408285/ReferenceIntegrationsandWebServiceLimits)
- [Workday SOAP authentication](https://developer.workday.com/documentation/GUID-4c354bdb-06cd-461d-a632-ea8303beaedb-enHYPHENus/SOAPAPIAuthenticationandSecurity)
- [Workday integration system user setup](https://developer.workday.com/documentation/GUID-f8d46604-e156-492f-a324-62ed2f6496f7/CreateIntegrationSystemUsersforApps)
- [Contributing guide](../../CONTRIBUTING.md)
