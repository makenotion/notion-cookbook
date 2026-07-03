# Worker sync: Workday employee directory

Bring active Workday employees and their current supervisory organizations into
two connected Notion databases. Employees can find colleagues, follow manager
and direct-report relationships, browse organization membership, and open a
native Notion People profile when the employee's work email matches a Notion
account.

The worker refreshes both databases daily, making it easier to answer everyday
“who works where?” questions without opening Workday.

> **Recommendation:** Only sync information that everyone in your organization
> is allowed to see.

## Quickstart

You need Node.js 22+, npm 10.9.2+, Notion Workers deployment access, and a
dedicated Workday integration user and API client. Start with a non-production
tenant and review [Workday access and sharing](#workday-access-and-sharing)
before sharing the result.

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
the databases to the people who should have access.

Set the tenant values provided by your Workday integration owner:

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

Optionally preview Organizations and then People to check the connection and a
sample page. Previews print employee data without writing the databases, so
protect terminal output.

```sh
ntn workers sync trigger organizationsSync --preview
ntn workers sync trigger peopleSync --preview
```

Run the complete initial syncs while both databases are still restricted:

```sh
ntn workers sync trigger organizationsSync
ntn workers sync status organizationsSync
```

Watch until Organizations succeeds, then press Ctrl-C and run People:

```sh
ntn workers sync trigger peopleSync
ntn workers sync status peopleSync
```

Watch until People succeeds, then press Ctrl-C.

Review the complete private databases and confirm that:

- they contain only the expected employees and details;
- manager, direct-report, organization, and member links point to the expected
  people and organizations;
- Name remains, and Work Email remains when Workday supplies a public primary
  work email, even when Notion Profile is empty; and
- an active Notion member, an email with no Notion account, and guest,
  deactivated, alias, and case-variant examples behave as expected.

Share the databases only with the approved audience, then start the daily
schedules:

```sh
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

| Notion property          | Workday field or meaning                           | Type                      |
| ------------------------ | -------------------------------------------------- | ------------------------- |
| Name                     | Explicit `Worker_Descriptor`                       | title                     |
| Work Email               | Public, primary `WORK` email, when present         | email                     |
| Notion Profile           | People resolution requested by Work Email          | people                    |
| Supervisory Organization | Current supervisory organization                   | relation to Organizations |
| Supervisory Managers     | Manager(s) of the current supervisory organization | self-relation             |
| Direct Reports           | Reciprocal of Supervisory Managers                 | reciprocal relation       |
| Directory Key            | Stable internal ID converted to an opaque key      | rich text, primary key    |

`Notion Profile` uses the Workers-native `Schema.people()` and
`Builder.people(workEmail)` primitives. The worker requests resolution using
only the normalized Work Email; it does not guess from a name or search the
Notion member list. Name and Work Email are separate properties, so they are
still shown when the People value is empty. If Workday has no eligible email,
Name remains while Work Email and Notion Profile are blank.

Seeing a profile here does not guarantee the person is still an active Notion
member. Test emails with no account, plus guest, deactivated, alias, and
case-variant addresses before sharing the directory.

#### Workday Supervisory Organizations

| Notion property      | Workday field or meaning                      | Type                   |
| -------------------- | --------------------------------------------- | ---------------------- |
| Name                 | Supervisory organization name                 | title                  |
| Organization Members | Reciprocal of each employee's organization    | reciprocal relation    |
| Directory Key        | Stable internal ID converted to an opaque key | rich text, primary key |

This database contains supervisory organizations, not Workday Teams,
Workteams, Flex Teams, cost centers, companies, or custom organizations. It
does not include empty organizations, parent hierarchy, or matrix management.

The worker converts Workday's internal IDs into stable Directory Keys so pages
and links continue to match across refreshes. The original IDs are not added to
Notion. Hide Directory Key in employee-facing views for a cleaner presentation;
hiding it does not change who can access the database. If two organizations
have the same name, add another detail employees are allowed to see or accept
that they will look identical.

### Project structure

```text
src/
├── index.ts           — registers databases, schedules, and shared client
├── workday.ts         — OAuth, versioned SOAP operations, parsing, and joins
├── sync.ts            — fixed-snapshot state and replace-sync execution
├── people.ts          — People schema and selected-field transform
├── organizations.ts   — supervisory-organization schema and collapse
├── keys.ts            — deterministic opaque directory keys
└── validation.ts      — shared page, date, and work-email validation
test.ts                — offline privacy, parser, paging, and failure tests
```

### How it works

1. Each run fixes one Workday entry timestamp and tenant-local effective date
   across every page.
2. `Get_Workers` reads active employees in pages of 100, excluding contingent
   workers and unrelated HR sections.
3. People pages batch their Workday IDs into one
   `Get_Change_Work_Contact_Information` request and match each response to the
   correct employee.
4. The parser accepts only an email whose same usage record is `Public=true`,
   `Primary=true`, and `Communication_Usage_Type_ID=WORK`. It never substitutes
   home, private, secondary, `BUSINESS`, or guessed addresses.
5. The management-chain entry for the employee's current supervisory
   organization supplies direct managers or co-managers. Higher-level and matrix
   reporting lines are not published.
6. Stable Directory Keys connect People to Organizations and other People
   without adding raw Workday identifiers to Notion.
7. Both syncs use `mode: "replace"`. Stale rows are removed only after the final
   page succeeds, so a partial failure preserves the previous complete result.

The worker keeps the current directory if Workday returns no employees, page
totals change during a run, an employee appears twice, contact results do not
line up, or organization, email, or manager data conflicts. It also stops above
100 manager links or 100 pages (10,000 employees). Paging state never stores
raw Workday IDs or email addresses.

The two databases update separately, so one can finish before the other. Run
Organizations before People for initial loads and immediate refreshes. At the
10,000-person limit, one daily refresh can make up to 300 SOAP calls; confirm
that capacity with the Workday integration owner. Manual triggers are useful
for immediate refreshes, but manual-only schedules would leave missed removals
and moves stale indefinitely.

Monitor both daily runs. A failed run leaves the last complete snapshot in
Notion, where it can become stale until the next successful run.

### Workday access and sharing

Before sharing the databases, check that everyone who can open them is allowed
to see the names, work emails, organizations, and reporting lines they contain.
Being able to fetch a field from Workday does not necessarily mean every
employee can see it.

| Check                 | What this recipe does                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| People included       | Active employees returned by the Workday service account; inactive and contingent workers are left out                        |
| Details shown         | Display name, optional public primary work email, and current supervisory organization name                                   |
| Links created         | Notion Profile, Supervisory Managers, Direct Reports, Organization Members, and employee-to-organization links                |
| Details left out      | Employee IDs, Workday internal IDs, job and location data, compensation, demographics, other contact fields, and page content |
| Where to make changes | Update people and organizations in Workday; this worker only reads from Workday                                               |

Use this directory to find coworkers, not to make HR, compliance, headcount,
provisioning, or access decisions. Use the systems your company has chosen for
those decisions.

Workday's `Public` email flag is one useful signal, but your company still
decides who may see that email. The worker also creates reverse views such as
Direct Reports and Organization Members, so check those views for the same
audience. Once the data is in Notion, the database's sharing settings determine
who can see it.

The Workday APIs used here may return more than the worker adds to Notion:

- `Get_Workers` may temporarily include internal IDs, additional organization
  details, and higher-level or matrix reporting lines.
- `Get_Change_Work_Contact_Information` may temporarily include other work
  addresses, phone numbers, instant-messenger handles, and web addresses.

The worker ignores those extra fields. If your company does not allow the
worker to receive them at all, ask the Workday team for a custom source that
returns only the approved directory details.

To keep Workday access narrow:

1. Create a dedicated Workday Integration System User (service account) and
   security group. Do not reuse an administrator or employee account.
2. Grant read access only for `Get_Workers` and
   `Get_Change_Work_Contact_Information`; do not grant write (`Put`) access or
   access to compensation, personal, home-contact, or private worker data.
3. Limit the integration's read (`Integration GET`) access to the expected
   employees and the name, supervisory-organization, manager, and work-contact
   fields used here.
4. Register a dedicated API Client for Integrations, activate pending security
   changes, inspect effective access, and test as the integration user.

Before sharing, check the complete private databases for examples such as
multi-job employees, international assignments, top-level managers,
co-managers, confidential employees, missing emails, and duplicate names.
Workday setup differs by company, so verify what the service account can read
instead of copying security-role names from another tenant.

### Configuration reference

| Variable                          | Required | Secret | Description                                                        |
| --------------------------------- | -------- | ------ | ------------------------------------------------------------------ |
| `WORKDAY_API_URL`                 | Yes      | No     | Versioned tenant Human Resources SOAP URL                          |
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

Deployments preserve paging state. If you intentionally change the Workday
source, schema, keys, parser, or paging logic, pause both syncs, deploy, and
reset both states:

```sh
ntn workers sync pause organizationsSync
ntn workers sync pause peopleSync
ntn workers sync state reset organizationsSync
ntn workers sync state reset peopleSync
```

Preview and trigger Organizations before People, then resume both schedules.
Changing the client secret also changes how duplicate employees and emails are
tracked, so reset both syncs. An expired Workday paging cache needs the same
reset; changing only the refresh token does not.

If the directory shows something it should not, restrict both databases and
pause both syncs before investigating. If links are missing, inspect both runs:
a successful People run does not make an older or failed Organizations run
current.

### Adapting the schema

Before adding a field or a new group of employees:

1. Confirm everyone who can open the Notion database may see the value.
2. Request only the needed Workday field and map it explicitly.
3. Add the Notion property and tests for present, missing, and nearby excluded
   values.
4. Update the property tables above, then preview and review sharing again.

For a change that cannot safely resume an existing run, bump
`DIRECTORY_SYNC_CONTRACT_VERSION` and reset both syncs.
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

Tests cover schemas, transforms, Workday request construction, selected-field
parsing, pagination, state, authentication, pacing, and failure behavior.
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
