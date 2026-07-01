# Worker sync: HubSpot

Bring HubSpot contacts, deals, and companies into Notion so sales, customer
success, and leadership can review the pipeline and customer context alongside
the rest of their work. The worker creates and maintains three connected
databases and refreshes them every five minutes.

## Quickstart

You need Node.js 22+, a HubSpot account with super-admin access, your
[portal ID](#finding-your-portal-id), and a
[private app token](#getting-a-hubspot-access-token) with these read scopes:
`crm.objects.contacts.read`, `crm.objects.deals.read`,
`crm.objects.companies.read`, and `crm.objects.owners.read`.

From the repository root:

```sh
npm install --global ntn
cd workers/hubspot-sync
npm install
ntn login
ntn workers deploy --name hubspot-sync
ntn workers env set HUBSPOT_ACCESS_TOKEN=pat-na1-your-token-here
ntn workers env set HUBSPOT_PORTAL_ID=12345678
```

Preview the contacts sync without writing to Notion:

```sh
ntn workers sync trigger contactsSync --preview
```

Then create and populate all three databases immediately:

```sh
ntn workers sync trigger contactsSync
ntn workers sync trigger companiesSync
ntn workers sync trigger dealsSync
```

The deal database relates each deal to its synced contacts and companies, so
you can navigate the customer context directly in Notion.

All contacts, companies, and deals visible to the private-app token are copied,
including contact details. Review the three databases' Notion sharing settings
before giving a broader audience access.

## What you can answer

| Managed database      | Questions it helps answer                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **HubSpot Contacts**  | Which leads need attention based on lifecycle stage, lead status, and last activity? Who owns them, and which contacts have deal value? |
| **HubSpot Deals**     | What is in each pipeline stage, who owns it, and when should it close? How do forecast and closed-won amounts break down by customer?   |
| **HubSpot Companies** | Which companies have open deals or the most revenue? How does the account base break down by owner, industry, lifecycle, and location?  |

## Reference

### Synced databases and schedules

| Database              | HubSpot resource | Schedule    |
| --------------------- | ---------------- | ----------- |
| **HubSpot Contacts**  | Contacts         | Every 5 min |
| **HubSpot Deals**     | Deals            | Every 5 min |
| **HubSpot Companies** | Companies        | Every 5 min |

#### HubSpot Contacts

| Notion property    | HubSpot field                 | Type        |
| ------------------ | ----------------------------- | ----------- |
| Name               | `firstname` + `lastname`      | title       |
| Lifecycle Stage    | `lifecyclestage`              | select      |
| Lead Status        | `hs_lead_status`              | select      |
| Email              | `email`                       | email       |
| Company            | `company`                     | richText    |
| Last Activity      | `notes_last_updated`          | date        |
| Job Title          | `jobtitle`                    | richText    |
| Owner              | `hubspot_owner_id` (resolved) | richText    |
| Phone              | `phone`                       | phoneNumber |
| Associated Deals   | `num_associated_deals`        | number      |
| Recent Deal Amount | `recent_deal_amount`          | number      |
| Updated            | HubSpot record `updatedAt`    | date        |
| Created            | `createdate`                  | date        |
| Contact Link       | link to HubSpot record        | url         |
| Contact ID         | `hs_object_id`                | richText    |

#### HubSpot Deals

| Notion property   | HubSpot field                 | Type     |
| ----------------- | ----------------------------- | -------- |
| Deal Name         | `dealname`                    | title    |
| Stage             | `dealstage`                   | select   |
| Amount            | `amount`                      | number   |
| Close Date        | `closedate`                   | date     |
| Pipeline          | `pipeline` (resolved)         | richText |
| Owner             | `hubspot_owner_id` (resolved) | richText |
| Company           | associated company IDs        | relation |
| Contact           | associated contact IDs        | relation |
| Forecast Amount   | `hs_forecast_amount`          | number   |
| Forecast Category | `hs_forecast_category`        | select   |
| Closed Won        | `hs_is_closed_won`            | checkbox |
| Deal Type         | `dealtype`                    | select   |
| Updated           | HubSpot record `updatedAt`    | date     |
| Created           | `createdate`                  | date     |
| Deal Link         | link to HubSpot record        | url      |
| Stage ID          | `dealstage`                   | richText |
| Pipeline ID       | `pipeline`                    | richText |
| Deal ID           | `hs_object_id`                | richText |

Each deal page body contains the HubSpot deal description. Company and contact
associations are Notion relations, so multiple associated records are retained
and renames stay in sync with the related managed database.

#### HubSpot Companies

| Notion property     | HubSpot field                 | Type        |
| ------------------- | ----------------------------- | ----------- |
| Name                | `name`                        | title       |
| Industry            | `industry`                    | select      |
| Domain              | `domain`                      | url         |
| Annual Revenue      | `annualrevenue`               | number      |
| Number of Employees | `numberofemployees`           | number      |
| Owner               | `hubspot_owner_id` (resolved) | richText    |
| Open Deals          | `hs_num_open_deals`           | number      |
| Total Revenue       | `total_revenue`               | number      |
| Lifecycle Stage     | `lifecyclestage`              | select      |
| Type                | `type`                        | select      |
| City                | `city`                        | richText    |
| Country             | `country`                     | richText    |
| Phone               | `phone`                       | phoneNumber |
| Updated             | HubSpot record `updatedAt`    | date        |
| Created             | `createdate`                  | date        |
| Company Link        | link to HubSpot record        | url         |
| Company ID          | `hs_object_id`                | richText    |

Each company page body contains the HubSpot company description. Owner IDs are
resolved to names by fetching active and deactivated HubSpot owners once per
sync cycle — no extra API call per record.

### Project structure

```text
src/
├── index.ts       — registers all databases and syncs
├── hubspot.ts     — API client (auth, pacing, pagination, owner resolution)
├── contacts.ts    — contact schema + transform
├── deals.ts       — deal schema + transform
├── companies.ts   — company schema + transform
└── helpers.ts     — shared utilities (dateOnly)
```

### How it works

1. Every 5 minutes, the worker fetches each CRM object type using HubSpot's
   list endpoint with cursor-based pagination (100 records per page).
2. Owner IDs are resolved to names by fetching active and deactivated owners.
   Deal pipeline and stage IDs are resolved from HubSpot's pipeline definitions.
3. Deal association IDs are batch-read and followed through each per-deal
   association cursor before becoming relations to the managed contacts and
   companies databases. This preserves every associated record without extra
   name lookups.
4. Each record is converted to an `upsert` keyed by HubSpot's record ID, so
   records are never duplicated.
5. Every HubSpot request uses a shared rate-limit pacer (90 requests per 10
   seconds) to stay within HubSpot's 100/10s limit on Free/Starter plans.
6. Because all syncs use `mode: "replace"`, records deleted in HubSpot are
   automatically removed from the Notion database on the next full sync.

### HubSpot access and credentials

#### Getting a HubSpot access token

1. In HubSpot, go to **Development > Legacy apps**
2. Click **Create legacy app**, then select **Private**
3. Under **Scopes**, add:
   - `crm.objects.contacts.read`
   - `crm.objects.deals.read`
   - `crm.objects.companies.read`
   - `crm.objects.owners.read`
4. Click **Create app** and copy the access token

#### Finding your portal ID

Your portal ID is visible in **Settings > Account Management**, or in the URL
when logged into HubSpot: `app.hubspot.com/contacts/{portalId}`.

### Configuration reference

#### Required

| Variable               | Description                                   |
| ---------------------- | --------------------------------------------- |
| `HUBSPOT_ACCESS_TOKEN` | Private app access token with CRM read scopes |
| `HUBSPOT_PORTAL_ID`    | Your HubSpot account (portal) ID              |

No `NOTION_API_TOKEN` is needed — the platform handles Notion credentials
automatically.

### Adapting the schema

Each resource has its own file with a schema and transform function:

| Resource  | File               |
| --------- | ------------------ |
| Contacts  | `src/contacts.ts`  |
| Deals     | `src/deals.ts`     |
| Companies | `src/companies.ts` |

To add a new HubSpot property:

1. Add the property name to the properties list in `src/hubspot.ts`
2. Add the field to the resource's type in `src/hubspot.ts`
3. Add a property to the schema with the appropriate `Schema.*` type
4. Add a `Builder.*` call in the transform function

HubSpot only returns properties you explicitly request — adding a field to the
type without adding it to the properties list will return null.

### Local testing

Run offline tests (no HubSpot connection needed):

```sh
npm test
```

Test a sync locally against a real HubSpot account:

```sh
ntn workers exec contactsSync --local
```

## Learn more

- [Notion Workers documentation](https://developers.notion.com/workers/get-started/overview)
- [HubSpot CRM API — Contacts](https://developers.hubspot.com/docs/api-reference/latest/crm/objects/contacts/guide)
- [HubSpot CRM API — Deals](https://developers.hubspot.com/docs/api-reference/latest/crm/objects/deals/guide)
- [HubSpot CRM API — Companies](https://developers.hubspot.com/docs/api-reference/latest/crm/objects/companies/guide)
- [HubSpot Private Apps](https://developers.hubspot.com/docs/apps/legacy-apps/private-apps/overview)
- [Contributing guide](../../CONTRIBUTING.md)
