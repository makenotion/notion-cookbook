# Worker sync: Workday org chart

Create a small, navigable employee directory in Notion from Workday. The Worker
keeps two related managed databases—**Workday People** and **Workday Teams**—so
employees can find a colleague, see their supervisory organization, move to a
manager or direct report, and browse the people in a team.

This is intentionally an employee-facing directory, not a replica of Workday
HCM. It publishes only display names, supervisory organization names,
relationships, and opaque sync keys. It does not publish job, contact,
employment, compensation, demographic, or other private worker data.

## When to use this recipe

Use it when an internal audience should be able to answer:

| Question                                                                     | Start in           |
| ---------------------------------------------------------------------------- | ------------------ |
| Which supervisory organization is this employee in?                          | **Workday People** |
| Who is this employee's manager, and who reports to them?                     | **Workday People** |
| Who belongs to this supervisory organization?                                | **Workday Teams**  |
| How can I navigate from a person to their team and management relationships? | Either database    |

Do not use this directory for HR operations, headcount reporting, access
control, compliance evidence, workforce analytics, or provisioning. Workday
remains the system of record. The Notion copy is a discoverability surface with
hourly—not transactional—freshness.

In this recipe, a **Team** is the supervisory organization in an employee's
current Workday context. It is not a Workday Workteam, Flex Team, cost center,
company, or custom organization. Because the source is `Get_Workers`, the
directory includes supervisory organizations represented by in-scope employees;
it is not a complete inventory of empty organizations.

## Privacy contract

The output is an allowlist. Adding a Workday permission does not make the
corresponding data safe to publish.

### What crosses the Notion sync boundary

| Output                                             | Source                                                                  | Why it is present                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| Employee display name                              | `Worker_Descriptor` (defined by WWS as the worker's person name)        | Find a colleague                                        |
| Supervisory organization name                      | Current organization context                                            | Find and browse a team                                  |
| Team, manager, member, and direct-report relations | Current organization and management references                          | Navigate the org graph                                  |
| `Directory Key`                                    | Domain-separated SHA-256 digest of a Workday WID, truncated to 128 bits | Stable upserts and relations without publishing the WID |

`Directory Key` values look like `wd-person-…` or `wd-team-…`. They are
deterministic technical identifiers, not Workday identifiers and not an
anonymization claim. Raw Workday WIDs are used only in memory to build keys and
relations; they are never emitted as Notion properties or page content.

### What is explicitly excluded

- Inactive workers and contingent workers
- Employee IDs, WIDs, user IDs, external IDs, and links back to worker profiles
- Job or business title, job profile, position, level, location, and work space
- Email, phone, address, photo, and other contact information
- Hire, termination, service, leave, contract, and other employment dates or
  status details
- Company, cost center, region, custom organizations, and financial worktags
- Compensation, benefits, payroll, time, absence, performance, talent, skills,
  recruiting, and disciplinary data
- Date of birth, government and national IDs, gender, pronouns, ethnicity,
  disability, veteran status, citizenship, and other personal or demographic
  data
- Page body content, and raw SOAP request or response payloads in Notion or logs

The SOAP request uses a narrow response group, and the transform separately
allowlists output fields. That defense in depth matters: Workday security and
response shapes vary by tenant, and a future response expansion must not
silently expand the Notion dataset. Do not add raw-response logging while
troubleshooting. Generic Workday reference `Descriptor` attributes are ignored;
they can contain tenant-formatted text outside this contract. A missing explicit
person or organization name fails the run.

Names and reporting relationships are still personal data. A reorganization or
a very small team can make even this narrow graph sensitive. A Workday
administrator must compare both previews with what representative employees can
normally see and navigate in Workday before the first write.

Once records are copied, Workday contextual security no longer evaluates each
Notion view. **The sharing settings of the two managed Notion databases are the
destination security boundary.** Review workspace, teamspace, guest, search,
export, and agent access before broadening either database. Sharing one database
without the other can also expose reciprocal relations in ways users do not
expect.

## Why this uses versioned Workday SOAP

Workday's [API overview](https://developer.workday.com/api-overview) describes
SOAP as the leading practice for scheduled, system-to-system exchange of large
datasets. That fits an hourly directory snapshot. `Human_Resources/Get_Workers`
also provides the three controls this sync needs in one documented contract:
employee/contingent-worker criteria, a selective response group, and consistent
server-side paging.

The recipe pins a configurable Workday Web Services version. Its tested default
is `v46.1`; use the [WWS version directory](https://community.workday.com/sites/default/files/file-hosting/productionapi/versions/index.html)
to confirm what your tenant supports and the
[v46.1 `Get_Workers` operation reference](https://community.workday.com/sites/default/files/file-hosting/productionapi/Human_Resources/v46.1/Get_Workers.html)
to review the exact request and response schema. Configurability is an upgrade
path, not a claim that untested versions are automatically compatible.

| Alternative                 | Why it is not the default here                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workday REST                | REST is optimized for smaller, user-initiated interactions; this recipe needs a complete, version-pinned batch snapshot.                                          |
| Workday Graph API           | Graph is useful for selected app experiences, but this recipe chooses the established, tenant-served WWS bulk contract for a portable HCM export.                 |
| Reports-as-a-Service (RaaS) | RaaS would require every tenant to create and govern a custom report whose mutable fields, filters, prompts, and sharing become part of the integration contract. |

Do not replace this narrow contract with a broad custom report merely to make a
new field easier to retrieve. If a future product requirement is a better fit
for REST, Graph, or RaaS, treat that as a new security and API design decision.

## Data model

### Workday People

| Property         | Type                          | Meaning                                                             |
| ---------------- | ----------------------------- | ------------------------------------------------------------------- |
| `Name`           | Title                         | Employee display name                                               |
| `Team`           | Relation to **Workday Teams** | Current supervisory organization; reciprocal property is `Members`  |
| `Managers`       | Self-relation                 | Current manager references; reciprocal property is `Direct Reports` |
| `Direct Reports` | Reciprocal relation           | People whose `Managers` relation points to this person              |
| `Directory Key`  | Rich text, primary key        | Opaque `wd-person-…` key                                            |

### Workday Teams

| Property        | Type                   | Meaning                                          |
| --------------- | ---------------------- | ------------------------------------------------ |
| `Name`          | Title                  | Supervisory organization name                    |
| `Members`       | Reciprocal relation    | People whose `Team` relation points to this team |
| `Directory Key` | Rich text, primary key | Opaque `wd-team-…` key                           |

Management is modeled once, on People: `Managers` and its reciprocal `Direct
Reports`. From a Team, open `Members`, then follow any member's manager chain.
Not duplicating manager relations onto Teams avoids a circular initial-load
dependency and makes identical team upserts safe when one organization spans
multiple Workday pages.

Names are display values, never keys. Renaming an employee or supervisory
organization updates the existing page because every person and team uses a
kind-scoped digest of its stable Workday WID. The kind prefix also prevents a
person and a team with the same source value from sharing a key.

A manager reference can be blank when Workday does not return one or when the
referenced person is outside the active-employee population visible to the
integration. Do not broaden the ISU merely to fill a relation without first
checking that a typical employee should see that relationship.

## Snapshot and replacement semantics

`teamsSync` and `peopleSync` are independent hourly replace syncs. Each follows
the same cycle:

1. Obtain a cached short-lived OAuth access token, exchanging the dedicated API
   client's refresh token on demand and renewing once after an HTTP 401.
2. Capture one `As_Of_Entry_DateTime`, then derive one
   `As_Of_Effective_Date` from that instant in
   `WORKDAY_EFFECTIVE_TIME_ZONE`.
3. Call `Get_Workers` with inactive workers and contingent workers excluded and
   only the response sections needed for display name, current supervisory
   organization, and management relationships.
4. Request pages of 100 workers. Every page in the cycle reuses the same two
   as-of values.
5. Parse only the allowlisted directory fields, derive opaque keys, and emit
   team or person upserts to the appropriate managed database.
6. Return the final page with `hasMore: false`, allowing the Workers runtime to
   remove records not observed in the completed snapshot.

Workday's [response-filter guidance](https://developer.workday.com/documentation/jas1383238226367/ConceptWorkdayWebServicesResponseFilterElement)
recommends a fixed `As_Of_Entry_DateTime` for paging consistency. Without it,
hires, terminations, transfers, or reorganizations during a long run could move
records between pages. The effective date is derived in an explicit IANA time
zone so a run near midnight has one tenant-intended calendar date. Require the
Workday owner to choose this zone explicitly; use `Etc/UTC` only when UTC is the
approved effective-date boundary.

The client also fails closed if Workday returns an empty page, a duplicate
employee in one page, a changed result/page count, the wrong page number, or
more than 100 pages (10,000 employees). These guards favor a visible failed run
over publishing an ambiguous graph or sweeping the directory after a
suspicious response.

A zero-worker response is intentionally treated as suspicious, not as an
authoritative empty directory. This prevents an expired security assignment or
mis-scoped ISU from erasing the Notion org chart, but it also means that a full
visibility revocation does **not** clear previously copied rows. If zero is the
legitimate end state, restrict sharing on both Notion databases first, pause
both schedules, confirm the zero population with the Workday owner, and follow your
workspace's approved retention process to remove the managed databases. Do not
weaken the empty-response guard during an access incident. Supporting an empty
directory should be a separately reviewed product mode with an explicit
operator confirmation, not an inference from a single upstream response.

Replace mode has a deliberate commit boundary: stale rows are deleted only
after every Workday page succeeds. If authentication, transport, XML parsing,
validation, or a later page fails, the cycle stops and the runtime does not run
the stale-row sweep. Earlier upserts in that run may already be visible, so this
is not a multi-row or cross-database transaction; it is atomic with respect to
replacement deletion.

The two databases are not updated in one transaction and can have different
snapshot instants. Run Teams before People on initial load and during manual
recovery so person-to-team relations have targets. If People fails after Teams
succeeds, no People records are swept and the next successful hourly pair
converges the graph.

Both capabilities share a conservative four-request-per-second pacer in
addition to 100-record pages. Workday overload responses are surfaced to the
Workers runtime for retry instead of being hidden in a partial snapshot. Review
Workday's [integration and web service limits](https://developer.workday.com/documentation/dan1370797408285/ReferenceIntegrationsandWebServiceLimits)
for your tenant and do not increase concurrency to shorten a large backfill.

Every OAuth and SOAP request has a 60-second abort deadline. OAuth responses are
limited to 64 KiB and each 100-worker SOAP page to 5 MiB before parsing. A
timeout or oversized response fails the run without logging the body or
reaching the replace sweep. HTTP 429, 502, 503, 504, and recognized overload
faults are surfaced as retryable runtime rate-limit errors.

This implementation is deliberately bounded to the dataset size for which
Notion recommends replace syncs. If the active-employee result approaches
10,000, do not raise the page cap or assume an hourly double scan will fit both
platforms' execution budgets. Capacity-test in a non-production tenant and
design a backfill plus incremental feed with periodic full reconciliation;
review Workday transaction-log coverage carefully because not every
organization change is represented as a worker transaction.

## Workday security and OAuth setup

Perform this setup with the Workday integration owner and security
administrator. Task and policy labels can vary with tenant configuration.

### 1. Create a dedicated identity

Follow Workday's [ISU setup guidance](https://developer.workday.com/documentation/GUID-f8d46604-e156-492f-a324-62ed2f6496f7/CreateIntegrationSystemUsersforApps)
to create a dedicated Integration System User and security group. Do not reuse a
human account, a tenant administrator, or an integration identity that already
has broad HR access. Disable interactive UI sessions where your tenant policy
supports it, document an owner, and put credential rotation and access review on
an operational calendar.

### 2. Grant only the read path

Authorize only the `Get_Workers` read path. In Workday terms, **Get-only** means
Get web-service operations; SOAP still sends `Get_Workers` over HTTP `POST`.
Do not grant Put operations.

Use **View Security for Securable Item** and your tenant's policy reports to
trace the exact fields. The expected minimum shape is:

- Invocation access through `Worker Data: Public Worker Reports`
- Contextual access through `Worker Data: Workers`
- Field-level access only for the public worker descriptor, current
  supervisory organization, and management references required by this recipe

Do not grant private worker reports, personal data, contact data, employment
detail, compensation, or broad unconstrained domains. Activate pending security
policy changes, then test as the ISU. `Get_Workers` is contextually secured, so
a successful response does not prove its contents match ordinary employee
visibility.

Security policies differ materially across Workday tenants. Before approval,
have a Workday administrator select representative employees across countries,
companies, supervisory organizations, and management levels. Compare the
previews with what each employee can navigate in Workday. Reduce the ISU's
permissions or narrow the audience if the preview is broader; do not rely on the
TypeScript transform as the only security control.

### 3. Register a dedicated API client

Register an **API Client for Integrations** for this Worker, associate only the
functional scope needed by the approved HCM read path, and generate its refresh
token for the dedicated ISU. Copy the exact token endpoint from Workday's
**View API Clients** report. Store the client secret and refresh token only as
Worker secrets.

Workday's [SOAP authentication guidance](https://developer.workday.com/documentation/GUID-4c354bdb-06cd-461d-a632-ea8303beaedb-enHYPHENus/SOAPAPIAuthenticationandSecurity)
documents the tenant SOAP authentication model. This recipe intentionally
supports the tenant `/ccx/service/.../Human_Resources/...` endpoint and its API
Client for Integrations—not the separate Workday Developer Site API Gateway
audience. It uses `WORKDAY_TOKEN_URL` to exchange the ISU refresh token and
sends the resulting access token as a bearer token.

### Configuration contract

| Variable                      | Required | Secret | Contract                                                                                     |
| ----------------------------- | -------- | ------ | -------------------------------------------------------------------------------------------- |
| `WORKDAY_API_URL`             | Yes      | No     | Exact HTTPS Human Resources SOAP endpoint; its path version must match `WORKDAY_API_VERSION` |
| `WORKDAY_API_VERSION`         | No       | No     | Pinned `vN.N` WWS version; defaults to the tested `v46.1`                                    |
| `WORKDAY_TOKEN_URL`           | Yes      | No     | Exact HTTPS tenant OAuth token endpoint ending in `/token`                                   |
| `WORKDAY_CLIENT_ID`           | Yes      | No     | Dedicated API Client for Integrations ID                                                     |
| `WORKDAY_CLIENT_SECRET`       | Yes      | Yes    | Dedicated API client secret                                                                  |
| `WORKDAY_REFRESH_TOKEN`       | Yes      | Yes    | Refresh token generated for the dedicated ISU                                                |
| `WORKDAY_EFFECTIVE_TIME_ZONE` | Yes      | No     | Workday-owner-approved IANA time zone used for the snapshot's effective date                 |

Both endpoint variables reject non-Workday hosts, nonstandard ports, embedded
credentials, query strings, and fragments. `WORKDAY_API_URL` must be the pinned
tenant Human Resources service path—not a tenant home page, API Gateway, WSDL
URL, REST endpoint, or RaaS report URL—and `WORKDAY_TOKEN_URL` must use the same
origin and tenant segment.

## Quickstart

You need:

- Node.js 22+ and npm 10.9.2+
- Access to deploy Notion Workers
- A non-production Workday tenant for initial validation
- The approved ISU, API client, refresh token, exact Human Resources WWS URL,
  and exact tenant OAuth token URL

From the repository root, install and run all offline checks before connecting
to Workday:

```sh
npm install --global ntn
cd workers/workday-sync
npm install
npm run check
npm test
npm run build
ntn login
ntn workers deploy --name workday-sync
ntn workers sync pause teamsSync
ntn workers sync pause peopleSync
```

Use `--name workday-sync` for the first deployment. Once local `workers.json`
identifies the deployed Worker, update it with `ntn workers deploy`. Treat that
generated file as local state. The first deployment has no Workday secrets, so
immediately pause both hourly schedules before adding them. For later updates,
pause both syncs before deploying new code. Pausing affects scheduled runs;
manual previews and triggers bypass the schedule.

While the syncs are paused, locate the two managed databases and restrict their
sharing to the approved audience. This makes destination access an explicit
precondition rather than a cleanup step after employee data is written.

Set configuration and credentials on the deployed Worker. Replace every sample
with a value copied from the approved Workday tenant:

```sh
ntn workers env set WORKDAY_API_URL=https://tenant1.myworkday.com/ccx/service/example_tenant/Human_Resources/v46.1
ntn workers env set WORKDAY_API_VERSION=v46.1
ntn workers env set WORKDAY_TOKEN_URL=https://tenant1.myworkday.com/ccx/oauth2/example_tenant/token
ntn workers env set WORKDAY_CLIENT_ID=your-client-id
ntn workers env set WORKDAY_CLIENT_SECRET=your-client-secret
ntn workers env set WORKDAY_REFRESH_TOKEN=your-refresh-token
ntn workers env set WORKDAY_EFFECTIVE_TIME_ZONE=America/New_York
```

Never commit `.env`, tokens, client secrets, SOAP payloads, or `workers.json`.
The Worker does not need a Notion API token; the Workers platform owns the
managed-database write path.

### Required initial trigger order

Preview Teams and then People. A preview calls Workday and prints directory
data, but does not write the managed databases; handle its terminal output as
internal employee data.

```sh
ntn workers sync trigger teamsSync --preview
ntn workers sync trigger peopleSync --preview
```

Stop here until the Workday administrator has completed the representative
employee visibility comparison and the Notion owner has approved the intended
destination audience.

Then trigger the real snapshots in the same order:

```sh
ntn workers sync trigger teamsSync
ntn workers sync trigger peopleSync
```

Inspect both results while the schedules remain paused. After the Workday and
Notion owners approve the controlled real sync, enable hourly operation:

```sh
ntn workers sync resume teamsSync
ntn workers sync resume peopleSync
```

Keep the databases' sharing restricted to the approved audience.

## Expected result and recommended views

Deployment provisions **Workday Teams** and **Workday People**; the first
successful pair populates them in that order. Each active employee appears
once, their Team relation opens the supervisory organization, and reciprocal
relations make Members and Direct Reports navigable without duplicating those
lists as text.

Useful views include:

- **People directory:** show Name, Team, and Managers; sort by Name.
- **People managers:** filter Direct Reports to non-empty; show Team.
- **Team directory:** show Name; sort by Name.
- **Team roster:** open a team and use its reciprocal Members relation as the
  roster.

Keep `Directory Key` visible to integration owners for debugging or hide it in
employee-facing views. Do not delete or edit it: it is the primary key. Avoid
adding headcount rollups unless the product and privacy owners explicitly
approve turning this navigation surface into a workforce reporting surface.

## Operations runbook

Check capability state and recent runs:

```sh
ntn workers sync status
ntn workers runs list
ntn workers runs logs <run-id>
```

| Event                                   | Action                                                                                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Regular access review                   | Re-run both previews, compare representative employees, and review both Notion databases' complete sharing and agent access.                                                                                        |
| Workday release or WWS upgrade          | Keep the current version pinned; compare the supported-version change log and `Get_Workers` schema, update the URL and `WORKDAY_API_VERSION` together in a non-production tenant, then run tests and both previews. |
| Refresh-token or client-secret rotation | Set the new Worker secret, trigger `teamsSync --preview`, then `peopleSync --preview`; revoke the old credential only after both succeed.                                                                           |
| Workday security-policy change          | Preview immediately. If at least one employee remains visible, the next completed replace cycle removes newly hidden rows. If visibility falls to zero, use the zero-population procedure below.                    |
| Legitimate zero population              | Restrict both databases' sharing, pause both syncs, confirm the result independently with the Workday owner, then follow the workspace's approved retention process to remove the managed databases.                |
| Overbroad output or suspected exposure  | Restrict Notion sharing first, pause both syncs, rotate credentials if needed, correct Workday access or code, then preview before resuming.                                                                        |
| Interrupted or stuck pagination         | Inspect logs and upstream health. Reset state only after finding the cause, then trigger Teams before People.                                                                                                       |

Pause and resume schedules during an incident or planned access change:

```sh
ntn workers sync pause teamsSync
ntn workers sync pause peopleSync
ntn workers sync resume teamsSync
ntn workers sync resume peopleSync
```

If a state reset is genuinely needed, reset both and preserve dependency order:

```sh
ntn workers sync state reset teamsSync
ntn workers sync state reset peopleSync
ntn workers sync trigger teamsSync
ntn workers sync trigger peopleSync
```

Deployments do not clear sync state. A transient failure normally needs a retry,
not a reset.

## Troubleshooting

- **OAuth `invalid_client` or `invalid_grant`:** confirm the client ID, client
  secret, refresh token, token endpoint, API-client status, and ISU status.
  Refresh-token rotation requires updating the Worker secret.
- **HTTP 401 after a previously healthy run:** rotate or regenerate the Workday
  credential, then preview. Never print the access token to diagnose it.
- **HTTP 403 or a Workday security fault:** verify Get-only operation access,
  invocation and contextual domains, field security, and activation of pending
  policy changes. Do not solve it by assigning an administrator role.
- **Version or XML validation fault:** `WORKDAY_API_VERSION`, the version in
  `WORKDAY_API_URL`, and the tenant-supported WWS schema must agree exactly.
- **No employees:** the run fails closed and preserves existing rows. Verify
  the ISU can invoke `Get_Workers`; remember that the request intentionally
  excludes inactive and contingent workers. If zero is legitimate, use the
  zero-population procedure above rather than bypassing the guard.
- **Missing team or manager relations:** check the worker's current supervisory
  organization and management data, then confirm the referenced employee is an
  active employee visible to the same ISU. A relation cannot target a person the
  snapshot does not contain.
- **Inconsistent supervisory organization error:** Workday returned different
  names for the same organization in one page. Do not publish an arbitrary
  winner; inspect effective dating and tenant data, then retry with a consistent
  as-of snapshot.
- **Rows update but stale rows remain:** inspect the final page. Replace mode
  deliberately skips deletion if the run never completes with
  `hasMore: false`.
- **Repeated throttling or slow backfill:** retain the 100-record page size,
  review tenant integration limits and competing integrations, and let pacing
  and runtime retries protect Workday.
- **Unexpected effective-dated assignment:** confirm
  `WORKDAY_EFFECTIVE_TIME_ZONE` is the IANA zone approved by the Workday owner.
  A different zone can select a different calendar date near midnight.

## Project structure

```text
src/
├── index.ts   — registers both managed databases and hourly replace syncs
├── workday.ts — configuration, OAuth, SOAP request/response, and paging
├── sync.ts    — fixed snapshot state and replace-sync execution
├── people.ts  — People schema and allowlisted person transform
├── teams.ts   — Teams schema, per-page organization collapse, and transform
└── keys.ts    — domain-separated opaque directory keys
test.ts        — offline contract, parser, privacy, paging, and failure tests
```

## Extending safely

Treat any new field or population as a privacy, security, product, and API
change—not just a schema edit.

1. Write the employee question the field answers and confirm that ordinary
   employees can already see it in Workday across all relevant populations.
2. Review Workday field and contextual security with the Workday owner. Do not
   grant a broad response section for one field.
3. Add the smallest versioned SOAP field and explicit parser path. Never pass
   through an XML subtree or serialize an upstream object.
4. Add a Notion property only after approving destination sharing, search,
   export, reciprocal-relation, and agent implications.
5. Add offline tests proving both inclusion of the approved field and exclusion
   of nearby sensitive fields. Update this privacy inventory.
6. Validate in a non-production tenant, then compare both previews with
   representative employee visibility.

Keep raw WIDs inside the Workday/transform boundary and derive every relation
key through `keys.ts`. Changing the key prefix, hash input, or digest length is
a data migration because Notion will otherwise create new pages and relations.
Adding inactive or contingent workers should be a separately reviewed dataset,
not a silent relaxation of the existing employee-only filters.

## Verification

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

Live verification requires an approved Workday tenant, API client, ISU, and
Worker secrets. The offline suite cannot prove tenant-specific field security,
effective-dated data quality, OAuth policy, Workday service limits, Notion
sharing, or hosted resolution of a People manager key whose target is emitted
on a later page. Complete both hosted previews, the representative employee
review, and a controlled real sync that verifies cross-page manager/direct-
report relations before treating the integration as production-ready.

For the runtime contract behind paging, replace deletion, relations, preview,
and state management, see the official
[Notion Workers sync guide](https://developers.notion.com/workers/guides/syncs).
