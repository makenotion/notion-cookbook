# Worker sync: HubSpot

Syncs HubSpot CRM contacts, deals, and companies into Notion databases that
stay up to date automatically. Once deployed, the worker checks HubSpot every
5 minutes and creates or updates a Notion page for each record.

You don't need to create the Notion databases yourself. The worker declares the
schemas and Notion creates and manages each database for you (these are called
"managed databases").

## What you get

| Database | HubSpot resource | Schedule |
| --- | --- | --- |
| **HubSpot Contacts** | Contacts | Every 5 min |
| **HubSpot Deals** | Deals | Every 5 min |
| **HubSpot Companies** | Companies | Every 5 min |

### HubSpot Contacts

| Notion property | HubSpot field | Type |
| --- | --- | --- |
| Name | `firstname` + `lastname` | title |
| Lifecycle Stage | `lifecyclestage` | select |
| Lead Status | `hs_lead_status` | select |
| Email | `email` | email |
| Company | `company` | richText |
| Last Activity | `notes_last_updated` | date |
| Owner | `hubspot_owner_id` (resolved) | richText |
| Job Title | `jobtitle` | richText |
| Phone | `phone` | richText |
| Created | `createdate` | date |
| Contact Link | link to HubSpot record | url |
| Contact ID | `hs_object_id` | richText |

### HubSpot Deals

| Notion property | HubSpot field | Type |
| --- | --- | --- |
| Deal Name | `dealname` | title |
| Stage | `dealstage` | select |
| Amount | `amount` | number |
| Close Date | `closedate` | date |
| Owner | `hubspot_owner_id` (resolved) | richText |
| Deal Link | link to HubSpot record | url |
| Pipeline | `pipeline` | richText |
| Deal Type | `dealtype` | select |
| Created | `createdate` | date |
| Deal ID | `hs_object_id` | richText |

### HubSpot Companies

| Notion property | HubSpot field | Type |
| --- | --- | --- |
| Name | `name` | title |
| Industry | `industry` | select |
| Domain | `domain` | url |
| Annual Revenue | `annualrevenue` | number |
| Number of Employees | `numberofemployees` | number |
| Owner | `hubspot_owner_id` (resolved) | richText |
| Type | `type` | select |
| City | `city` | richText |
| Country | `country` | richText |
| Phone | `phone` | richText |
| Created | `createdate` | date |
| Company Link | link to HubSpot record | url |
| Company ID | `hs_object_id` | richText |

Owner IDs are resolved to names by fetching all HubSpot owners once per sync
cycle — no extra API call per record.

## Project structure

```text
src/
├── index.ts       — registers all databases and syncs
├── hubspot.ts     — API client (auth, pagination, types, owner resolution)
├── contacts.ts    — contact schema + transform
├── deals.ts       — deal schema + transform
├── companies.ts   — company schema + transform
└── helpers.ts     — shared utilities (dateOnly)
```

## How it works

1. Every 5 minutes, the worker fetches each CRM object type using HubSpot's
   list endpoint with cursor-based pagination (100 records per page).
2. Owner IDs are resolved to names by fetching all owners once at the start
   of each sync cycle and building a lookup map.
3. Each record is converted to an `upsert` keyed by HubSpot's record ID, so
   records are never duplicated.
4. All three syncs share a single rate-limit pacer (90 requests per 10 seconds)
   to stay within HubSpot's 100/10s limit on Free/Starter plans.
5. Because all syncs use `mode: "replace"`, records deleted in HubSpot are
   automatically removed from the Notion database on the next full sync.

## Prerequisites

- Node >= 22, npm >= 10.9.2
- A HubSpot account with CRM data
- The `ntn` CLI installed and authenticated (`ntn auth login`)

### Getting a HubSpot access token

1. Go to **Settings > Integrations > Private Apps**
2. Click **Create a private app**
3. Under **Scopes**, add:
   - `crm.objects.contacts.read`
   - `crm.objects.deals.read`
   - `crm.objects.companies.read`
   - `crm.objects.owners.read`
4. Click **Create app** and copy the access token

### Finding your portal ID

Your portal ID is visible in **Settings > Account Management**, or in the URL
when logged into HubSpot: `app.hubspot.com/contacts/{portalId}`.

## Environment variables

### Required

| Variable | Description |
| --- | --- |
| `HUBSPOT_ACCESS_TOKEN` | Private app access token with CRM read scopes |
| `HUBSPOT_PORTAL_ID` | Your HubSpot account (portal) ID |

No `NOTION_API_TOKEN` is needed — the platform handles Notion credentials
automatically.

## Setup and deploy

1. Install the Notion Workers CLI:

   ```sh
   npm install -g @notionhq/ntn
   ```

2. Clone and install:

   ```sh
   cd examples/workers/syncs/hubspot
   npm install
   ```

3. Typecheck and test:

   ```sh
   npm run check
   npm test
   ```

4. Log in to Notion:

   ```sh
   ntn auth login
   ```

5. Deploy the worker:

   ```sh
   ntn workers deploy
   ```

6. Set environment variables on the deployed worker:

   ```sh
   ntn workers env set HUBSPOT_ACCESS_TOKEN=pat-na1-your-token-here
   ntn workers env set HUBSPOT_PORTAL_ID=12345678
   ```

7. Preview a sync without writing to Notion:

   ```sh
   ntn workers sync trigger contactsSync --preview
   ntn workers sync trigger dealsSync --preview
   ntn workers sync trigger companiesSync --preview
   ```

8. Run a real sync:

   ```sh
   ntn workers sync trigger contactsSync
   ntn workers sync trigger dealsSync
   ntn workers sync trigger companiesSync
   ```

Once deployed, all three syncs run automatically every 5 minutes. Three
databases will appear in your Notion workspace after the first run.

## Adapting the schema

Each resource has its own file with a schema and transform function:

| Resource | File |
| --- | --- |
| Contacts | `src/contacts.ts` |
| Deals | `src/deals.ts` |
| Companies | `src/companies.ts` |

To add a new HubSpot property:

1. Add the property name to the properties list in `src/hubspot.ts`
2. Add the field to the resource's type in `src/hubspot.ts`
3. Add a property to the schema with the appropriate `Schema.*` type
4. Add a `Builder.*` call in the transform function

HubSpot only returns properties you explicitly request — adding a field to the
type without adding it to the properties list will return null.

## Local testing

Run offline tests (no HubSpot connection needed):

```sh
npm test
```

Test a sync locally against a real HubSpot account:

```sh
ntn workers exec contactsSync --local
```

## Learn more

- [Notion Workers documentation](https://developers.notion.com/docs/workers)
- [HubSpot CRM API — Contacts](https://developers.hubspot.com/docs/api/crm/contacts)
- [HubSpot CRM API — Deals](https://developers.hubspot.com/docs/api/crm/deals)
- [HubSpot CRM API — Companies](https://developers.hubspot.com/docs/api/crm/companies)
- [HubSpot Private Apps](https://developers.hubspot.com/docs/api/private-apps)
- [Contributing guide](../../../../CONTRIBUTING.md)
