# Worker sync: Workday employee directory

Create a navigable employee directory in Notion from Workday display names,
available public primary work email addresses, and current supervisory
organizations. The Worker links employees to managers, organization members,
and—when an exact email match resolves—their native Notion profile. It refreshes
both managed databases every hour.

This is an employee directory with reporting links, not a replica of Workday
Org Chart. Workday remains authoritative, and Notion does not re-evaluate
Workday security for each viewer.

> **Deployment contract:** Share these databases only with a named audience for
> which the Workday data owner has confirmed that every published value and
> derived relationship below is visible to every audience member. Permission to
> call a Workday API does not certify its result as employee-visible. If this
> cannot be established, narrow the Workday population or Notion audience before
> syncing.

## Quickstart

You need Node.js 22+, npm 10.9.2+, Notion Workers deployment access, and a
non-production Workday tenant. Complete the
[source and audience approval](#source-and-audience-approval) before enabling a
sync.

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
ntn workers capabilities disable organizationsSync
ntn workers capabilities disable peopleSync
```

The first deployment creates **Workday Supervisory Organizations** and
**Workday People**. Disable the capabilities before adding credentials, then
restrict both databases to the approved employee audience. For later updates,
disable both capabilities before deploying. Treat `workers.json` as local state
and do not commit it.

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

Preview Organizations and then People. Previews call Workday and print
employee data without writing the databases, so protect terminal output.

```sh
ntn workers sync trigger organizationsSync --preview
ntn workers sync trigger peopleSync --preview
```

Before a real sync, the Workday data and security owners must attest the exact
audience, worker population, source fields, and derived relations. Test personas
from every materially different country, company, organization, and security
cohort validate that attestation; sampling does not replace it. The Notion owner
must separately approve database, teamspace, guest, search, export,
integration, and AI/agent access.

After approval, populate both databases in order:

```sh
ntn workers sync trigger organizationsSync
ntn workers sync trigger peopleSync
```

Inspect both results while the capabilities remain disabled. Confirm every
manager and organization relation resolves across page boundaries. Exercise an
active member, a person without an eligible work email, an email with no Notion
account, and any guest, deactivated, alias, or case-variant behavior covered by
your approved identity contract. In every case, confirm Name remains and Work
Email remains when Workday supplied it. Then enable hourly operation:

```sh
ntn workers capabilities enable organizationsSync
ntn workers capabilities enable peopleSync
```

Never commit `.env`, tokens, client secrets, SOAP payloads, previews, or
`workers.json`. The Worker does not need a Notion API token; the Workers
platform owns the managed-database write path.

## What you can answer

| Managed database                      | Questions it helps answer                                                                                                                |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Workday People**                    | Which supervisory organization is this employee in? Who manages them? Who reports to them? Does their email resolve to a Notion profile? |
| **Workday Supervisory Organizations** | Who belongs to this supervisory organization? How can I navigate from an organization to its employees and reporting relationships?      |

Do not use this directory for HR operations, headcount, access control,
compliance, analytics, or provisioning. It has hourly, eventual consistency.

## Reference

### Synced databases and schedules

| Database                              | Workday resource                                | Schedule   |
| ------------------------------------- | ----------------------------------------------- | ---------- |
| **Workday Supervisory Organizations** | Current employee supervisory organizations      | Every hour |
| **Workday People**                    | Active employees, work email, and org relations | Every hour |

#### Workday People

| Notion property          | Workday source or derivation                       | Type                      |
| ------------------------ | -------------------------------------------------- | ------------------------- |
| Name                     | Explicit `Worker_Descriptor`                       | title                     |
| Work Email               | Public, primary `WORK` email, when present         | email                     |
| Notion Profile           | Attempted exact Work Email resolution              | people                    |
| Supervisory Organization | Current supervisory organization WID               | relation to Organizations |
| Supervisory Managers     | Manager(s) of the current supervisory organization | self-relation             |
| Direct Reports           | Reciprocal of Supervisory Managers                 | reciprocal relation       |
| Directory Key            | Digest of the employee WID                         | rich text, primary key    |

`Notion Profile` uses the Workers-native `Schema.people()` and
`Builder.people(workEmail)` primitives. Resolution is email-based only: there
is no WID or name matching, and no Notion users-list call. Name and Work Email
are emitted independently, so they remain the fallback identity even when the
People value is empty or does not identify the intended account. Before launch,
verify the hosted resolver for active members, emails with no account, guests,
deactivated accounts, aliases, and case variants. A populated People property
does not by itself prove current workspace-member status.

#### Workday Supervisory Organizations

| Notion property      | Workday source or derivation               | Type                   |
| -------------------- | ------------------------------------------ | ---------------------- |
| Name                 | Supervisory organization name              | title                  |
| Organization Members | Reciprocal of each employee's organization | reciprocal relation    |
| Directory Key        | Digest of the organization WID             | rich text, primary key |

This database contains supervisory organizations, not Workday Teams,
Workteams, Flex Teams, cost centers, companies, or custom organizations. Empty
organizations and parent-child organization hierarchy are absent because the
source is employee membership. Matrix management is intentionally excluded.

Names are display values, never identifiers. Duplicate employee and
organization names remain technically distinct because opaque keys differ, but
duplicate organization names are visually ambiguous after Directory Key is
hidden. Before launch, require unique approved names, add an approved
employee-visible disambiguator in a reviewed extension, or explicitly accept
that limitation. Employee-facing views should show Work Email and Supervisory
Organization beside Name and hide Directory Key. Managed schemas cannot hide a
property in code; view hiding is presentation, not access control. Never add
employee IDs merely to disambiguate names.

Each key is a domain-separated SHA-256 digest of a stable Workday WID, truncated
to 128 bits and prefixed with `wd-person-` or `wd-organization-`. Raw WIDs are
processed in memory for joins, upserts, and relations but never become a Notion
property, state value, page body, or log field.

### Product and privacy contract

| Boundary             | Contract                                                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audience             | A named employee-only Notion audience. Guests, external collaborators, integrations, and agents require separate approval.                                                   |
| Population           | Active employees in the approved Workday directory population. The ISU-visible population is acceptable only after the owner confirms universal visibility for the audience. |
| Published source     | Employee display name, optional public primary work email, and current supervisory organization name. Personal or home email is never a fallback.                            |
| Published derivation | Notion Profile, Supervisory Managers, Direct Reports, Organization Members, and the employee-to-organization link. Approve these global/inverse views explicitly.            |
| Not published        | Raw WIDs and employee IDs, other work contact fields, job/position/location data, employment details, compensation, demographics, and page body content.                     |
| Authority            | Workday is authoritative. Notion is an eventually consistent directory and must not drive HR decisions, authorization, compliance, or headcount.                             |

The two APIs have different source boundaries:

- `Get_Workers` requests references, supervisory organization membership, and
  management-chain data. Its coarse response sections can transiently include
  reference IDs, organization-summary metadata, and the full supervisory and
  matrix management chains. The parser keeps only the worker descriptor,
  current supervisory organization name and WID, and its direct employee
  manager WIDs; personal, employment, compensation, role, and other broad
  sections remain disabled.
- `Get_Change_Work_Contact_Information` is called once for the WIDs on each
  People page. It is narrower than Workday `Personal_Data`, but its transient
  response can contain other **work** addresses, phones, instant-messenger
  handles, and web addresses. The parser retains only one email whose same
  usage record is `Public=true`, `Primary=true`, and
  `Communication_Usage_Type_ID=WORK`.

If the policy requires that no non-published field—including organization
summary metadata, non-current management-chain data, or other work-contact
fields—may leave Workday even transiently, these standard operations are too
broad. Use a tenant-owned, security-reviewed source that projects only approved
fields; do not weaken this recipe's parser or grant private contact access.

The Workday `Public` flag is necessary but not proof of universal visibility.
Workday separately evaluates operation access, contextual worker population,
and field access for the calling ISU. Once copied, Workday no longer evaluates
each Notion viewer; the sharing boundary of both databases becomes the security
boundary.

### Source and audience approval

Before enabling either sync, the Workday HR data owner, Workday security owner,
Notion workspace data owner, Privacy, Security, and—where applicable—Legal or a
works council must approve:

- the named Notion audience and exact Workday worker population, including
  restricted workers, countries, companies, and supervisory organizations;
- display name, optional public primary work email, organization name, and every
  derived relation or cross-system identity link;
- how multi-job, international-assignment, top-level, confidential, and
  co-manager records appear to the approved audience;
- database, search, export, guest, integration, and AI/agent access;
- closure of the population under manager references, plus the approved
  handling of duplicate supervisory-organization display names; and
- the freshness objectives and incident owner below.

Repeat approval after a Workday security or schema change, Notion audience or
sharing change, new field or relation, and at the organization's normal access
review cadence. Availability in Workday is not by itself approval to copy data
into Notion.

### Least-privilege Workday setup

1. Create a dedicated Integration System User and constrained security group.
   Do not reuse a human account or tenant administrator. Assign owners for
   access review and credential rotation.
2. Authorize read access only for `Get_Workers` and
   `Get_Change_Work_Contact_Information`. `Worker Data: Public Worker Reports`
   permits `Get_Workers` invocation but does not prove its result is public.
3. Constrain `Worker Data: Workers` contextual **Integration GET** access to the
   approved population. Grant only the fields required for worker descriptors,
   current supervisory organizations, supervisory manager references, and work
   contact information. Do not grant Put, compensation, employment, personal,
   home-contact, or broad private-worker access.
4. Activate pending security changes, inspect the effective policy with
   **View Security for Securable Item**, and test as the ISU. Tenant task and
   domain names can vary; have the Workday security owner verify the effective
   operation, population, and field grants rather than copying role names.

Register a dedicated **API Client for Integrations** with only the functional
scope for this read path, then generate its refresh token for the ISU. The
supported source is the pinned tenant
`/ccx/service/.../Human_Resources/vN.N` SOAP endpoint—not REST, RaaS, or an
unversioned custom endpoint.

### How it works

1. Each sync fixes one `As_Of_Entry_DateTime` across all pages and derives one
   effective date in `WORKDAY_EFFECTIVE_TIME_ZONE`.
2. `Get_Workers` reads active employees in pages of 100, excluding contingent
   workers and non-directory response sections.
3. For People only, the Worker batches that page's WIDs into one pinned
   `Get_Change_Work_Contact_Information` request and joins the response by WID
   in memory.
4. The parser accepts zero or one public primary `WORK` email per employee: zero
   leaves Work Email and Notion Profile blank, while ambiguity or malformed data
   fails the run. It validates a one-to-one WID join and rejects a nonempty email
   reused by another employee anywhere in the snapshot.
5. The current supervisory management-chain entry supplies the organization's
   direct manager or co-managers. It is not the full ancestor or matrix chain.
6. Both syncs use `mode: "replace"`; stale rows are removed only after the final
   page completes successfully.

The Worker fails rather than guessing on empty snapshots, changed totals,
missing or ambiguous organization membership, malformed manager references,
ambiguous or duplicate work emails, mismatched contact responses, duplicate
page records, relations above 100 managers, and snapshots above 100 pages or
10,000 employees. A top-level organization may have a present chain entry with
no manager; missing chain data is not treated as “no manager.”

One Workday client, OAuth token provider, and four-request-per-second pacer are
shared per runtime. OAuth and work-contact requests have a 60-second deadline;
`Get_Workers` page 1 has no client timeout because Workday builds its paging
cache there. Responses are bounded at 64 KiB for OAuth and 5 MiB for SOAP.
Optional Workday external correlation headers identify attempts without
including employee data.

Pagination state contains pinned times, counts, page number, a version, and a
source-contract fingerprint. People state also packs a truncated HMAC of each
nonempty normalized work email already seen in that snapshot so cross-page
identity collisions fail closed; raw emails are never stored. The HMAC is keyed
by the Workday client secret, and the contract fingerprint stores only a derived
key version. At the 10,000-person ceiling, packed email state is at most 160,000
characters. A changed endpoint, WWS version, time zone, API client ID, client
secret, page size, parser/output contract, or key strategy invalidates in-flight
state and requires a paired reset.

### Freshness and consistency

The databases are separate full-snapshot syncs and are not atomic. These are
operator objectives, not platform guarantees:

| Measure            | Objective                                                    | If missed                                                   |
| ------------------ | ------------------------------------------------------------ | ----------------------------------------------------------- |
| Freshness          | Both syncs complete successfully within two hours.           | Treat the directory as stale and investigate.               |
| Pair consistency   | Latest successful runs are no more than one hour apart.      | Treat relations and membership as potentially inconsistent. |
| Removal lag        | A Workday removal disappears after the next successful pair. | Restrict access if continued visibility creates risk.       |
| Relation integrity | Every manager and organization target resolves in Notion.    | Do not present the result as a complete employee directory. |

Assign an operator and alert on failed or missed runs, either database exceeding
the two-hour freshness objective, pair skew above one hour, unresolved
relations, or an unapproved count delta. This recipe surfaces failures but does
not provision an alert destination.

At the 10,000-employee ceiling, one hourly pair can make up to 300 SOAP calls:
100 organization `Get_Workers` pages, 100 People `Get_Workers` pages, and 100
batched work-contact calls. Confirm this full-scan capacity with the Workday
integration owner. A successful People run does not make a failed or older
Organizations run current.

### Configuration reference

| Variable                          | Required | Secret | Description                                                                 |
| --------------------------------- | -------- | ------ | --------------------------------------------------------------------------- |
| `WORKDAY_API_URL`                 | Yes      | No     | Exact tenant Human Resources SOAP URL; version must match the setting below |
| `WORKDAY_API_VERSION`             | No       | No     | Pinned `vN.N` WWS version; defaults to tested `v46.1`                       |
| `WORKDAY_TOKEN_URL`               | Yes      | No     | Matching tenant OAuth token endpoint ending in `/token`                     |
| `WORKDAY_CLIENT_ID`               | Yes      | No     | Dedicated API Client for Integrations ID                                    |
| `WORKDAY_CLIENT_SECRET`           | Yes      | Yes    | Dedicated API client secret                                                 |
| `WORKDAY_REFRESH_TOKEN`           | Yes      | Yes    | Refresh token generated for the dedicated ISU                               |
| `WORKDAY_EFFECTIVE_TIME_ZONE`     | Yes      | No     | Owner-approved IANA zone for effective-dated records                        |
| `WORKDAY_EXTERNAL_APPLICATION_ID` | No       | No     | Non-sensitive Workday correlation label, at most 50 characters              |

Both URLs reject non-Workday hosts, nonstandard ports, embedded credentials,
query strings, and fragments. They must share an origin and tenant segment.
When the optional application ID is set, each SOAP attempt adds a unique
`wd-external-request-id`. Never put employee data or credentials in either
header.

### Operations and troubleshooting

Inspect capability state and recent runs with:

```sh
ntn workers sync status
ntn workers runs list
ntn workers runs logs <run-id>
```

On suspected overexposure, restrict both databases first, disable both syncs,
and investigate before restoring access. Do not rely on a later replace cycle
as the incident response.

For an intentional incompatible source, parser, key, schema, or paging change,
disable both capabilities, deploy, then reset both states:

```sh
ntn workers sync state reset organizationsSync
ntn workers sync state reset peopleSync
```

Repeat previews, approvals, real triggers, and enablement. A transient failure
under the same contract normally needs a retry; a Workday paging-cache expiry
requires the paired reset. Rotating the client secret also invalidates in-flight
state because it keys collision fingerprints; reset both syncs before resuming.
A refresh-token-only rotation does not change the source contract.

Common failures:

- **HTTP 401, 403, or Workday security fault:** verify the client, refresh token,
  ISU, operation access, contextual population, field security, and policy
  activation. Do not assign an administrator role to make the error disappear.
- **Missing or ambiguous work email:** no eligible address leaves Work Email and
  Notion Profile blank. Multiple, malformed, or over-200-character eligible
  addresses fail. Never substitute a home, `BUSINESS`, secondary, or guessed
  address.
- **Missing management chain or unclassifiable manager:** verify response-field
  security and source data. A contingent or WID-only manager is not silently
  presented as “no manager.”
- **No employees or incomplete contact response:** the run fails closed and
  preserves existing rows. Confirm the approved source population; do not
  bypass the guard to clear data.
- **Rows update but stale rows remain:** inspect the final page. Replace mode
  removes stale rows only after `hasMore: false`.
- **Repeated throttling or slow backfill:** keep the 100-record batch size,
  review tenant capacity, and let pacing and runtime retries protect Workday.

### Project structure

```text
src/
├── index.ts           — registers databases, schedules, and shared client
├── workday.ts         — OAuth, versioned SOAP operations, parsing, and joins
├── sync.ts            — fixed-snapshot state and replace-sync execution
├── people.ts          — People schema and allowlisted transform
├── organizations.ts   — supervisory-organization schema and collapse
├── keys.ts            — domain-separated opaque directory keys
└── validation.ts      — shared page, date, and work-email validation
test.ts                — offline privacy, parser, paging, and failure tests
```

### Adapting the schema

Treat a new field or population as a privacy, product, security, and API change.
Verify universal employee visibility, use the narrowest versioned source,
allowlist one parser path and destination property, test nearby sensitive-field
exclusion, update this inventory, and repeat approval. Do not serialize an
upstream object or broaden `Personal_Data` for one field.

An incompatible change requires bumping
`DIRECTORY_SYNC_CONTRACT_VERSION` and following the paired state-reset
procedure. Adding inactive employees, contingent workers, matrix managers, or
parent organization hierarchy should be a separately reviewed dataset.

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

Offline tests verify optional fallback fields, native People references, and
cross-page duplicate-email rejection. They cannot prove tenant security,
Workday `Public` semantics, that production data satisfies the contract,
cross-page hosted relation resolution, Notion sharing, or hosted
Notion-profile resolution. Those remain deployment-gate checks.

## Learn more

- [Notion Workers overview](https://developers.notion.com/workers/get-started/overview)
- [Notion Workers sync guide](https://developers.notion.com/workers/guides/syncs)
- [Notion schema and builders](https://developers.notion.com/workers/reference/schema)
- [Workday `Get_Workers` guide](https://developer.workday.com/documentation/GUID-1f289b82-801e-434e-9e5a-aef66bc35179/GetWorkers)
- [Workday `Get_Change_Work_Contact_Information` v46.1](https://community.workday.com/sites/default/files/file-hosting/productionapi/Human_Resources/v46.1/Get_Change_Work_Contact_Information.html)
- [Workday response-filter guidance](https://developer.workday.com/documentation/jas1383238226367/ConceptWorkdayWebServicesResponseFilterElement)
- [Workday integration and web service limits](https://developer.workday.com/documentation/dan1370797408285/ReferenceIntegrationsandWebServiceLimits)
- [Workday SOAP authentication](https://developer.workday.com/documentation/GUID-4c354bdb-06cd-461d-a632-ea8303beaedb-enHYPHENus/SOAPAPIAuthenticationandSecurity)
- [Contributing guide](../../CONTRIBUTING.md)
