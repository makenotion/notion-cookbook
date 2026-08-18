---
name: sync
description: Scaffold a new sync capability with guided setup — asks about data source, mode, pagination, and cursor design, then generates working code
user-invocable: true
disable-model-invocation: true
allowed-tools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "Agent"]
---

## Instructions

You are helping the user create a new sync capability for their Notion Worker. Walk through each step, asking questions and making recommendations. Generate working code at the end.

Before you begin, read these reference files to understand sync patterns:

- `.agents/skills/sync-guide/SKILL.md` — concepts, modes, patterns, common mistakes
- `.agents/skills/sync-guide/api-pagination-patterns.md` — real-world API strategies
- `.agents/skills/sync-guide/examples/` — working code templates

Also read the current `src/index.ts` to understand what already exists.

### Step 1: Understand the Data Source

Ask the user:

- What data are you syncing? (e.g., "Jira issues", "Stripe customers", "ServiceNow tickets")

If they name a well-known API, look up its pagination mechanism and change-tracking capabilities (does it have `updated_at`? an events endpoint? cursor-based pagination?).

### Step 2: Determine the Right Architecture

Based on what you know about the data source, recommend one of two architectures:

#### Simple replace sync

Use when: the source is small (<1k records) OR the API has no change tracking
(no `updated_at`, no event feed).

One sync, replace mode. Re-fetches everything each cycle. The runtime
auto-deletes records that disappear from the source. Simplest option.

#### Backfill + delta pair

Use when: the API supports change tracking (`updated_at`, events, changelog) —
this covers most enterprise APIs (Salesforce, Stripe, Linear, GitHub, HubSpot).

Two separate syncs writing to the **same database**:

- **Backfill sync** (replace mode, `schedule: "manual"`): Paginates the full
  dataset. Triggered manually via CLI when a full re-import is needed. Replace
  mode's mark-and-sweep automatically cleans up records deleted from the source.
- **Delta sync** (incremental mode, `schedule: "5m"` or similar): Fetches only
  recently changed records. Runs on a timer for low-latency updates.

Advantages over a single bi-modal sync:

- No phase discrimination in state — each sync has simple, focused state
- No backfill-to-delta transition logic
- Backfill and delta run independently — re-backfill anytime without disrupting delta
- Easier to reason about and debug

**Change tracking drives the decision, not dataset size.** A Linear workspace
may only have a few thousand issues, but its API supports the queries needed
for delta sync, so backfill+delta is the right choice. Conversely, a website
listing local pickleball courts has no `updated_since` endpoint regardless of
how many records it has.

Recommend an architecture with a brief explanation. Let the user override if
they disagree.

### Step 3: Design the Schema

Based on the API's response shape, propose a schema. Look up what fields the
API returns and map the most useful ones to Schema types. Don't ask the user
to enumerate fields — propose a sensible default and let them adjust.

For example, if syncing Jira issues, propose:

```ts
const issuesDb = worker.database("issuesDb", {
  type: "managed",
  initialTitle: "Jira Issues",
  primaryKeyProperty: "Issue Key",
  schema: {
    properties: {
      "Issue Key": Schema.richText(),    // primaryKeyProperty — the unique ID
      "Summary": Schema.title(),         // the main display field
      "Status": Schema.select([...]),    // mapped from Jira statuses
      "Assignee": Schema.richText(),     // or Schema.people() if email available
      "Updated": Schema.date(),
    },
  },
});
```

Guidelines:

- Declare the database with `worker.database()` and reference the handle in `worker.sync()`
- Every schema needs exactly one `Schema.title()` — pick the most descriptive field
- Use `Schema.richText()` for the primary key property (the unique ID)
- Treat property order as product design, not API order. Put the title first,
  followed by the five properties that best help an end user recognize,
  evaluate, or act on the record.
- Keep opaque IDs, sync keys, timestamps used only for cursors, and other
  implementation metadata out of the first six properties. Include a user-facing
  identifier such as an order number or issue key early only when users genuinely
  rely on it.
- Use `Schema.url()`, `Schema.email()`, `Schema.date()`, `Schema.number()`,
  `Schema.checkbox()`, `Schema.select()` where the data type fits
- Use `Schema.relation("otherDatabaseKey")` for relations to another managed database
- Start with 10-20 properties — be generous, include most useful fields from the API
- See the full type list in `.agents/skills/sync-guide/SKILL.md` under "Schema Reference"

Present the proposed schema to the user and ask if they want to add, remove,
or change any fields before generating code.

### Step 4: Design the State Machine

Research the API to determine its pagination and change-tracking mechanisms.
Do NOT ask the user about pagination details — figure it out from the API docs,
your knowledge of the API, or by looking up the API. The user shouldn't need
to know whether their API uses opaque cursors vs page numbers.

You need to determine:

1. **How the API paginates list results** (opaque cursor, page number, offset, keyset)
2. **Whether the API has change tracking** (updated_at field, events endpoint, changelog)
3. **Whether the API has deletion signals** (archived filter, audit log, delete events)

Then design the state accordingly:

**For simple replace syncs:** State is just within-cycle pagination.

- Opaque cursor: `{ cursor: string | null }`
- Page number: `{ page: number }`

**For backfill + delta pairs:** Each sync has its own simple state — no
bi-modal discriminated union needed.

- **Backfill state:** Just pagination cursor for walking the full dataset.
  Depends on how the API paginates its list endpoint:
  - Opaque cursor: `{ cursor: string | null }`
  - Page number: `{ page: number }`
  - Keyset: `{ cursorTimestamp: string | null; cursorId: string | null }`

- **Delta state:** Change-tracking cursor for fetching recent modifications.
  Depends on how the API exposes changes:
  - Opaque cursor (API sorted by updated_at): `{ cursor: string | null }`
  - Timestamp keyset: `{ cursorTimestamp: string; cursorId: string }`
  - Event ID: `{ eventCursor: string }`

**Consistency buffer (delta syncs only):** In incremental mode the cursor
never resets, so if you advance past a record that hasn't been indexed yet,
it's lost permanently. Apply a consistency buffer: never advance the cursor
closer than 10-15 seconds to "now". This is especially important for APIs
with eventual consistency (Stripe, Salesforce, etc.).

**Deletion handling:**
There are three cases to consider:

1. **API supports delta deletes** (e.g., Stripe events with `*.deleted` types,
   APIs that return `deleted: true` in change feeds): Emit
   `{ type: "delete", key }` in the delta sync. This is the cleanest approach.
2. **Deletes are rare or irrelevant** for the use case: No action needed.
   Stale records remain in Notion but don't cause problems.
3. **Deletes matter but the API has no delete signal**: The backfill sync's
   replace mode handles this automatically — its mark-and-sweep deletes any
   records not seen during the full cycle. Trigger a backfill periodically
   to clean up stale records.

If the API has no change tracking at all, go back and recommend a simple
replace sync instead.

Present your state design to the user as a brief summary (e.g., "This API uses
cursor-based pagination and has an `updated_at` field, so I'll use a
backfill+delta pair with opaque cursor for backfill and timestamp keyset for
delta"). Let them confirm or adjust before generating code.

### Step 5: Set Up Authentication

Before generating code, determine what auth the API needs and set it up so
you can test locally.

There are two patterns:

**Pattern A: Static API token/key**
For APIs where the user has a personal token or API key (e.g., Jira API token,
GitHub PAT, simple API keys).

Prefer a brokered credential when the token is only used in outbound request
headers to known domains. Follow `.agents/skills/auth-guide/SKILL.md` to declare
it with `worker.credential()`.

If the worker needs the plaintext token — for example, for signing or a request
body — tell the user which variables are needed and have them add the values
directly to `.env` themselves. Never ask them to send the values in chat:

```
JIRA_API_TOKEN=...
JIRA_EMAIL=user@example.com
```

If `.env` doesn't exist, create it. The `.env` file is automatically loaded
during local execution (`--local` flag).

**Pattern B: OAuth**
For APIs that require OAuth (e.g., Google, Salesforce, HubSpot). This has
two parts:

1. **Client credentials** — the OAuth app's client ID and secret. These go in `.env`:

   ```
   MY_OAUTH_CLIENT_ID=...
   MY_OAUTH_CLIENT_SECRET=...
   ```

2. **User token** — obtained through the OAuth flow _after_ deploying. This is
   handled by the runtime automatically via `worker.oauth()` and `.accessToken()`.

For OAuth syncs, you'll add a `worker.oauth()` call in the generated code.
Always use `UserManagedOAuthConfiguration` (the shape with explicit endpoints and
client credentials) rather than the `{ provider: "..." }` shorthand, as
Notion-managed OAuth is in alpha and the user likely does not have access.

```ts
const myAuth = worker.oauth("myAuth", {
  name: "my-provider",
  authorizationEndpoint: "https://provider.example.com/oauth/authorize",
  tokenEndpoint: "https://provider.example.com/oauth/token",
  scope: "read write",
  clientId: process.env.MY_OAUTH_CLIENT_ID ?? "",
  clientSecret: process.env.MY_OAUTH_CLIENT_SECRET ?? "",
})
```

Then use `await myAuth.accessToken()` in the execute function instead of
reading a static token from `process.env`.

Note: OAuth syncs can't be fully tested locally since the OAuth flow requires
a deployed worker. Local testing will fail at the `.accessToken()` call. This
is fine — proceed to deploy and test via preview (Step 8).

### Step 6: Generate the Code

Write the sync into `src/index.ts`. Use the closest example from `.agents/skills/sync-guide/examples/` as a starting point:

- `replace-simple.ts` — static data, no API
- `replace-paginated.ts` — paginated replace mode (also used for backfill syncs)
- `incremental-basic.ts` — delta sync with opaque cursor
- `incremental-bimodal.ts` — full backfill + delta pair example
- `incremental-events.ts` — delta sync with event feed

Include in the generated code:

- Proper imports (`Worker`, `Builder`, `Schema`)
- Database declaration via `worker.database()` with schema and `primaryKeyProperty`
- A pacer for the upstream API via `worker.pacer()` — and `await pacer.wait()` before every API request
- The state type(s) — simple types, one per sync (no discriminated unions needed)
- The `worker.sync()` call(s) referencing the database handle
- For backfill+delta: two syncs targeting the same database, backfill with `schedule: "manual"`, delta with a timed schedule
- A consistency buffer for delta syncs (if the API is eventually consistent)
- Inline comments explaining _why_ each design choice was made
- API calls using `fetch` with auth from a brokered credential or `process.env`

**Code generation checklist:**

- [ ] Database declared with `worker.database()` and referenced by handle
- [ ] Pacer declared with `worker.pacer()` for the upstream API
- [ ] `await pacer.wait()` called before every `fetch` to the upstream API
- [ ] State types are simple (no bi-modal discriminated unions)
- [ ] Backfill sync uses `mode: "replace"` and `schedule: "manual"` (if applicable)
- [ ] Delta sync uses `mode: "incremental"` with a timed schedule (if applicable)
- [ ] Consistency buffer applied to delta cursor advancement (if applicable)
- [ ] Deletion handling matches one of the three cases from Step 4

### Step 7: Test Locally

Test the sync before deploying. This catches bugs early without a deploy cycle.

**For syncs using static API tokens (Pattern A):**

Brokered credentials must be tested after deploy in Step 8. For tokens read
from `process.env`, test locally:

1. Run `npm run check` to verify TypeScript types compile. Fix any errors.

2. Run `ntn workers exec <key> --local` to execute the sync locally.
   This runs the execute function on your machine with `.env` loaded.
   - Check: does it return data? Are properties populated correctly?
   - Check: does `hasMore` look right? Does the cursor advance?

3. If it returns `hasMore: true`, test the next page:
   `ntn workers exec <key> --local -d '<nextState from previous output>'`

4. If there are errors (auth failures, wrong field mappings, crashes):
   fix the code and re-run — no deploy needed, iteration is fast.

5. For backfill+delta pairs, test each sync independently:
   - Test the backfill sync: `ntn workers exec <backfillKey> --local`
   - Test the delta sync: `ntn workers exec <deltaKey> --local`
   - Verify they both return well-formed data with the correct properties.

6. Write a test file (`test.ts`) that exercises the sync. Import the worker
   directly and call its `.run()` method.

   If the user has API credentials in `.env`, write a test that hits the real
   API — this is the most valuable test because it validates actual field
   mappings, pagination behavior, and auth against the real service. If
   credentials aren't available, stub the HTTP calls instead.

   **Integration test (preferred when credentials are available):**

   ```ts
   import "dotenv/config" // load .env
   import worker from "./src/index.ts"
   import assert from "node:assert"

   async function test() {
     // First page (backfill start, no prior state)
     const page1 = await worker.run("mySync", undefined, {
       concreteOutput: true,
     })
     console.log(
       `Page 1: ${page1.changes.length} records, hasMore: ${page1.hasMore}`
     )
     assert(page1.changes.length > 0, "Should return records")

     // Verify fields are populated
     const first = page1.changes[0]
     assert(first.key, "Record should have a key")
     console.log("Sample record:", JSON.stringify(first, null, 2))

     // Test pagination
     if (page1.hasMore) {
       const page2 = await worker.run("mySync", page1.nextState, {
         concreteOutput: true,
       })
       console.log(
         `Page 2: ${page2.changes.length} records, hasMore: ${page2.hasMore}`
       )
       assert(page2.changes.length > 0, "Second page should return records")
     }

     console.log("All tests passed!")
   }

   test().catch((err) => {
     console.error(err)
     process.exit(1)
   })
   ```

   Run with `npx tsx test.ts`. Adapt to the specific sync: use the actual
   capability key, add assertions for specific field values, verify both
   backfill and delta syncs for backfill+delta pairs, etc.

**For syncs using OAuth (Pattern B):**
Local execution won't work because `.accessToken()` requires a deployed worker
with a completed OAuth flow. Skip to Step 8 (deploy + preview) instead.
You can still run `npm run check` to verify types compile.

### Step 8: Deploy and Validate with Preview

Once local testing passes (or immediately for OAuth syncs), deploy and test remotely.

If secrets need to be available at deploy time (e.g., OAuth `clientSecret` read
from `process.env` during capability registration), create the worker and push
secrets first:

1. `ntn workers create --name <name>` — create the worker without deploying
2. `ntn workers env push` — push `.env` secrets to remote
3. `ntn workers deploy` — now deploy with secrets available

Otherwise, the simpler flow:

1. `ntn workers deploy` — build and publish
2. `ntn workers env push` — push `.env` secrets to remote
3. If the sync uses OAuth, complete the OAuth flow before previewing.
   **Important:** `env push` must happen before `oauth start` — the deployed worker needs the client secret to exchange the authorization code for tokens.
   - `ntn workers oauth show-redirect-url` — get the redirect URL
   - Tell the user to configure this URL in their OAuth provider's app settings
   - `ntn workers oauth start <oauthKey>` — opens browser to complete the OAuth flow
4. `ntn workers sync trigger <syncKey> --preview` — execute remotely without writing to Notion
   - Inspect the output: record count, property values, hasMore status
   - If `hasMore: true`, continue: `ntn workers sync trigger <syncKey> --preview --context '<nextState>'`
5. If the preview shows issues, fix the code and redeploy (go back to step 1)

For backfill+delta pairs, preview both syncs:

- `ntn workers sync trigger <backfillKey> --preview`
- `ntn workers sync trigger <deltaKey> --preview`

### Step 9: Go Live

When the preview looks good:

1. `ntn workers sync trigger <key>` — trigger a real sync
2. `ntn workers sync status` — check that the sync is running and progressing
3. `ntn workers runs list` then `ntn workers runs logs <runId>` — check for errors
4. Run `ntn workers sync status` again to confirm progress (record count increasing, no errors)

For backfill+delta pairs, trigger the backfill first to load all data, then
let the delta sync's schedule handle ongoing changes:

1. `ntn workers sync trigger <backfillKey>` — start the full dataset load
2. Monitor with `ntn workers sync status` until the backfill completes
3. The delta sync will run automatically on its configured schedule

Tell the user: the first sync run is the backfill, which may take a while
depending on dataset size. They should periodically run `ntn workers sync status`
to monitor progress until the initial backfill completes. After that, the delta
sync runs automatically on its configured schedule. To re-backfill later:
`ntn workers sync state reset <backfillKey> && ntn workers sync trigger <backfillKey>`
