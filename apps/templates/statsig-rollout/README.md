# Statsig Rollout

A Notion App that adds IDs to a Statsig
[ID List segment](https://docs.statsig.com/segments) from a Notion database.
Use it to roll a feature gate out to specific spaces, users, or other UUID-keyed
entities without giving everyone who manages the rollout access to Statsig.

> [!WARNING]
>
> Notion Apps and the Apps SDK are early alpha features and can introduce
> breaking changes.

## How it works

Add a row to **Rollout** with the ID as its title. The `addToSegment` workflow
then:

1. Normalizes the ID (trims it, lowercases it, and converts the 32-character
   compact form to dashed UUID form).
2. Sets **Status** to `invalid` with an explanation in **Error** if it isn't a
   UUID.
3. Otherwise sets `adding`, calls
   `PATCH https://statsigapi.net/console/v1/segments/<STATSIG_SEGMENT_ID>/id_list`,
   and sets `success` or `fail` (with the Statsig error).

Statsig requests are retried up to 3 times for network, 409, 429, and 5xx
errors. Adding an ID that is already in the segment succeeds. The App only adds
IDs; deleting a row does not remove its ID from the segment.

**Re-runs:** only rows at `pending` are processed. To retry an `invalid` or
`fail` row, fix the ID if needed and set Status back to `pending`. The workflow
never writes `pending` itself, so the trigger events caused by its own status
writes are skipped.

## Prerequisites

- Node.js 26 or newer and the `ntn` CLI.
- A Statsig **Console API** key with write access. A server secret key does not
  work with the Console API.
- An existing Statsig segment of type **ID List**. Its ID is shown in the
  segment's URL in the Statsig console.

## Setup

```shell
cd apps/templates/statsig-rollout
npm install
npm run check
npm test
npm run build

ntn experiments enable apps
ntn login
ntn apps deploy --name "Statsig Rollout"   # omit --name on later deploys
ntn workers env set STATSIG_CONSOLE_API_KEY=<key>
ntn workers env set STATSIG_SEGMENT_ID=<segment-id>
```

After deploying, open the workflow in Notion and save it to activate the page
triggers. The App's home page embeds the **Rollout** table.

For local execution, copy `.env.example` to `.env` and fill in the values.
Never commit `.env`.

## Manual debugging

The workflow also has a manual trigger that takes an ID, validates it, and adds
it to the segment without reading or writing the database. If this succeeds but
a database row fails, the problem is in the trigger or row handling rather than
the validation or Statsig call:

```shell
ntn apps workflows trigger addToSegment --data '{"id":"<uuid>"}'
ntn apps workflows runs --help   # inspect the run's result
```

An invalid ID or a Statsig error fails the run with the error message.

## Code map

```text
APP.md                         Home page: embedded Rollout table
src/workflows/addToSegment.ts  Triggers, status flow, and retries
src/workflows/lib/notion.ts    Rollout database and table view
src/workflows/lib/uuid.ts      UUID normalization (tested)
src/workflows/lib/statsig.ts   Statsig Console API client
```

## Extension points

- **Non-UUID IDs:** Statsig ID lists accept any string. To roll out by email or
  another key, replace `normalizeUuid` in `addToSegment.ts` with your own
  validation.
- **Several segments:** add a select property to the database and map each
  option to a segment ID instead of reading `STATSIG_SEGMENT_ID`.
- **Removal:** Statsig's `DELETE .../id_list` endpoint takes the same body. Add
  a `remove` status option and call it from the workflow.

## Verification

`npm test` covers UUID normalization and page ID parsing offline. To check the
live flow, add a known UUID to **Rollout** and confirm that the row reaches
`success` and the ID appears in the segment in the Statsig console.
