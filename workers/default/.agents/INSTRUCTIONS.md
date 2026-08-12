# Repository Guidelines

Overall workers documentation lives at https://developers.notion.com/workers/get-started/overview.md.

## Project Structure & Module Organization

- `src/index.ts` defines the worker and capabilities.
- `.examples/` has focused samples (sync, tool, automation, OAuth, webhook).
- Shared agent skills live in `.agents/skills/`. `.claude/skills` is kept as a compatibility symlink for Claude-specific discovery.
- Generated: `dist/` build output, `workers.json` CLI config.

## Worker & Capability API (SDK)

- `@notionhq/workers` provides `Worker`, schema helpers, and builders; the `ntn` CLI powers worker management.
- Capability keys are unique strings used by the CLI (e.g., `ntn workers exec tasksSync`).

### Workflow capability availability

`worker.workflow()` is in a private alpha and is not available to any users. Do not mention workflow capabilities to users, even to explain their availability. Do not suggest, scaffold, or use them in user projects.

### Custom block capability availability

`worker.customBlock()` is in a private alpha and is not available to most users. It may be present in the installed SDK, but its presence does not grant access. Do not suggest, scaffold, or use custom blocks in user projects. Do not add the `@notionhq/custom-blocks` dependency or custom block frontend code.

```ts
import { Worker } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

const worker = new Worker()
export default worker

// Declare a sync target database (only written to by syncs — not for general-purpose storage)
const tasks = worker.database("tasks", {
  type: "managed",
  initialTitle: "Tasks",
  primaryKeyProperty: "ID",
  schema: { properties: { Name: Schema.title(), ID: Schema.richText() } },
})

// Declare a pacer for the upstream API
const myApi = worker.pacer("myApi", { allowedRequests: 10, intervalMs: 1000 })

// Declare a sync that writes to the database
worker.sync("tasksSync", {
  database: tasks,
  execute: async (state) => {
    await myApi.wait()
    const items = await fetchItems(state?.page ?? 1)
    return {
      changes: items.map((i) => ({
        type: "upsert" as const,
        key: i.id,
        properties: { Name: Builder.title(i.name), ID: Builder.richText(i.id) },
      })),
      hasMore: false,
    }
  },
})

worker.tool("sayHello", {
  title: "Say Hello",
  description: "Return a greeting",
  schema: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  },
  execute: ({ name }, { notion }) => `Hello, ${name}`,
})

worker.oauth("googleAuth", {
  name: "my-google-auth",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  scope: "openid email",
  clientId: process.env.GOOGLE_CLIENT_ID ?? "",
  clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
})

worker.webhook("onGithubPush", {
  title: "GitHub Push Webhook",
  description: "Handles push events from GitHub",
  execute: async (events, { notion }) => {
    for (const event of events) {
      console.log("Push:", event.body)
    }
  },
})
```

### Notion API access (`context.notion`)

All `execute` handlers receive a `context.notion` object (a `@notionhq/client` SDK instance). You can use this to make API requests to Notion.

However, `context.notion` is only **pre-authenticated** when it's a tool capability invoked by a Custom Agent. In that case, the platform sets `NOTION_API_TOKEN` automatically, using the permissions of the Custom Agent — no setup required.

For all other capabilities (syncs, automations, webhooks), `context.notion` is **not** pre-authenticated. The user must set the `NOTION_API_TOKEN` environment variable themselves by:

1. Creating a connection at https://app.notion.com/developers/connections
2. Giving that connection access to the relevant pages and databases in Notion
3. Adding the token to `.env` locally, or pushing it with `ntn workers env push` for deployed workers

Before writing code that uses `context.notion` in a non-tool capability, check whether `NOTION_API_TOKEN` is configured: look for it in `.env` (e.g. `grep -q '^NOTION_API_TOKEN=' .env`). If it is not set, prompt the user to create a connection at https://app.notion.com/developers/connections and add the token to `.env`.

- For user-managed OAuth (shown above), supply `name`, `authorizationEndpoint`, `tokenEndpoint`, `clientId`, `clientSecret`, and `scope` (optional: `authorizationParams`, `callbackUrl`, `accessTokenExpireMs`).
- **Note:** A Notion-managed OAuth shorthand (`{ provider: "google" }`) also exists but is in alpha and most users will not have access. Use the user-managed configuration above.
- After deploying a worker with an OAuth capability, the user must configure their OAuth provider's redirect URL to match the one assigned by Notion. Run `ntn workers oauth show-redirect-url` to get the redirect URL, then set it in the provider's OAuth app settings. **Always remind the user of this step after deploying any OAuth capability.**

### Sync

#### Databases, Pacers, and Syncs

`worker.database()` declares a sync target — a Notion database that syncs write into. **Databases are read-only from the worker's perspective: the only way to write to them is through syncs.** Do not use `worker.database()` to create general-purpose databases (e.g., for storing webhook payloads, tool results, or scratch data). For non-sync writes to Notion, use `context.notion` (the Notion SDK client) directly.

Databases are declared separately and referenced by handle:

```ts
// 1. Declare a database
const tasks = worker.database("tasks", {
  type: "managed",
  initialTitle: "Tasks",
  primaryKeyProperty: "Task ID",
  schema: {
    properties: {
      "Task Name": Schema.title(),
      "Task ID": Schema.richText(),
      Status: Schema.select([
        { name: "Open" },
        { name: "Done", color: "green" },
      ]),
    },
  },
})

// 2. Declare a pacer for the upstream API
const myApi = worker.pacer("myApi", { allowedRequests: 10, intervalMs: 1000 })

// 3. Declare a sync
worker.sync("tasksSync", {
  database: tasks,
  schedule: "30m",
  execute: async (state) => {
    await myApi.wait()
    const { items, hasMore } = await fetchTasks(state?.page ?? 1)
    return {
      changes: items.map((item) => ({
        type: "upsert" as const,
        key: item.id,
        properties: {
          "Task Name": Builder.title(item.name),
          "Task ID": Builder.richText(item.id),
          Status: Builder.select(item.status),
        },
      })),
      hasMore,
      nextState: hasMore ? { page: (state?.page ?? 1) + 1 } : undefined,
    }
  },
})
```

Multiple syncs can write to the same database. Multiple syncs can share a pacer — the server apportions the budget evenly across all syncs that use it.

#### Pacers (Rate Limiting)

**Always declare a pacer** for any sync that calls an external API. Research the API's rate limits before implementing. If the limits are variable (e.g. Salesforce, where you can purchase more API calls), ask the user what budget to allocate.

- Call `await pacer.wait()` before **every** API request inside `execute`.
- The pacer ensures requests are evenly spaced over the interval window.
- If 4 syncs share a pacer with `allowedRequests: 100, intervalMs: 60_000`, each sync gets ~25 requests/minute.

```ts
const myApi = worker.pacer("myApi", { allowedRequests: 10, intervalMs: 1000 })

// Inside execute:
await myApi.wait()
const data = await fetchFromApi()
```

#### Choosing a Sync Strategy

**Simple replace sync** — For truly small data sources (<1k records) or APIs with no change-tracking support. One sync, replace mode. Every cycle returns the full dataset; records not returned are deleted via mark-and-sweep.

**Backfill + delta pair** — For everything else (recommended for most real integrations). Two syncs writing to the same database:

- **Backfill** (replace mode, `schedule: "manual"`): Paginates the entire upstream dataset. Triggered manually via CLI. Cleans up drift, backfills new schema properties, catches deletes the delta can't detect.
- **Delta** (incremental mode, frequent schedule like `"5m"` or `"30m"`): Fetches only recent changes via `updated_since`, change feeds, etc. Keeps Notion current with minimal API usage.

Use backfill + delta whenever the upstream API supports any form of change tracking (`updated_since`, `modified_after`, change feeds, webhooks). Most enterprise APIs do (Salesforce, Jira, Linear, Stripe, GitHub, etc.).

##### Delete handling

- **API supports delta deletes** (returns deleted records in change feed): Emit `{ type: "delete", key }` in the delta sync.
- **API doesn't, but deletes are rare or irrelevant** (e.g. Stripe subscriptions are canceled not deleted, Jira issues are closed not deleted): No action needed — the upstream record still exists, just in a different state.
- **API doesn't, and deletes matter**: The backfill sync handles this. Its replace-mode mark-and-sweep deletes records no longer present upstream.

#### Simple Replace Sync Example

```ts
const records = worker.database("records", {
  type: "managed",
  initialTitle: "Records",
  primaryKeyProperty: "ID",
  schema: { properties: { Name: Schema.title(), ID: Schema.richText() } },
})

const myApi = worker.pacer("myApi", { allowedRequests: 10, intervalMs: 1000 })

worker.sync("recordsSync", {
  database: records,
  mode: "replace",
  schedule: "1h",
  execute: async (state) => {
    const page = state?.page ?? 1
    await myApi.wait()
    const { items, hasMore } = await fetchPage(page, 100)
    return {
      changes: items.map((item) => ({
        type: "upsert" as const,
        key: item.id,
        properties: {
          Name: Builder.title(item.name),
          ID: Builder.richText(item.id),
        },
      })),
      hasMore,
      nextState: hasMore ? { page: page + 1 } : undefined,
    }
  },
})
```

#### Backfill + Delta Example

```ts
const tasks = worker.database("tasks", {
  type: "managed",
  initialTitle: "Tasks",
  primaryKeyProperty: "Task ID",
  schema: {
    properties: {
      "Task Name": Schema.title(),
      "Task ID": Schema.richText(),
      Status: Schema.select([
        { name: "Open" },
        { name: "Done", color: "green" },
      ]),
    },
  },
})

const taskApi = worker.pacer("taskApi", {
  allowedRequests: 10,
  intervalMs: 1000,
})

// Backfill: paginates full dataset, runs manually.
// To re-backfill: ntn workers sync state reset tasksBackfill && ntn workers sync trigger tasksBackfill
worker.sync("tasksBackfill", {
  database: tasks,
  mode: "replace",
  schedule: "manual",
  execute: async (state) => {
    const page = state?.page ?? 1
    await taskApi.wait()
    const { items, hasMore } = await fetchAllTasks(page, 100)
    return {
      changes: items.map((item) => ({
        type: "upsert" as const,
        key: item.id,
        properties: {
          "Task Name": Builder.title(item.name),
          "Task ID": Builder.richText(item.id),
          Status: Builder.select(item.status),
        },
      })),
      hasMore,
      nextState: hasMore ? { page: page + 1 } : undefined,
    }
  },
})

// Delta: fetches recent changes, runs every 5 minutes.
worker.sync("tasksDelta", {
  database: tasks,
  mode: "incremental",
  schedule: "5m",
  execute: async (state) => {
    const cursor = state?.cursor
    await taskApi.wait()
    const { items, nextCursor } = await fetchTaskChanges(cursor)
    return {
      changes: items.map((item) => ({
        type: "upsert" as const,
        key: item.id,
        properties: {
          "Task Name": Builder.title(item.name),
          "Task ID": Builder.richText(item.id),
          Status: Builder.select(item.status),
        },
      })),
      hasMore: Boolean(nextCursor),
      nextState: nextCursor ? { cursor: nextCursor } : undefined,
    }
  },
})
```

#### Pagination

Syncs run in a "sync cycle": a back-to-back chain of `execute` calls that starts at a scheduled trigger and ends when an execution returns `hasMore: false`.

- Always paginate. Returning too many changes in one execution will fail. Start with batch sizes of ~100.
- Return `hasMore: true` and `nextState` to continue; `hasMore: false` to finish.
- `nextState` can be any serializable value: cursor string, page number, timestamp, or complex object.

#### Schedule

Set `schedule` on a sync to control how often it runs:

- `"continuous"`: run as fast as possible
- `"manual"`: only via CLI trigger
- Interval string: `"5m"`, `"30m"`, `"1h"`, `"1d"` (min `"1m"`, max `"7d"`)
- Default: `"30m"`

#### Relations

Two databases can relate to one another using `Schema.relation(syncKey)` and `Builder.relation(primaryKey)`:

```ts
const projects = worker.database("projects", {
 type: "managed",
 initialTitle: "Projects",
 primaryKeyProperty: "Project ID",
 schema: { properties: { "Project Name": Schema.title(), "Project ID": Schema.richText() } },
});

const tasks = worker.database("tasks", {
 type: "managed",
 initialTitle: "Tasks",
 primaryKeyProperty: "Task ID",
 schema: {
  properties: {
   "Task Name": Schema.title(),
   "Task ID": Schema.richText(),
   // Reference the sync key that populates the related database
   Project: Schema.relation("projectsSync", { twoWay: true, relatedPropertyName: "Tasks" }),
  },
 },
});

worker.sync("projectsSync", { database: projects, execute: async () => { ... } });
worker.sync("tasksSync", {
 database: tasks,
 execute: async () => ({
  changes: [{
   type: "upsert" as const,
   key: "task-1",
   properties: {
    "Task Name": Builder.title("Write docs"),
    "Task ID": Builder.richText("task-1"),
    Project: [Builder.relation("proj-1")], // array of relation refs
   },
  }],
  hasMore: false,
 }),
});
```

### Webhooks

Webhooks expose HTTP endpoints that external services can call. After deploying, the CLI prints the webhook URL. Use `ntn workers webhooks list` to see URLs at any time.

The execute handler receives an array of `WebhookEvent` objects. Each event contains `deliveryId` (stable idempotency key across retries), `body` (parsed JSON), `rawBody` (string, for signature verification), `headers`, and `method`.

```ts
worker.webhook("onExternalEvent", {
  title: "External Event Handler",
  description: "Processes incoming webhook requests",
  execute: async (events, { notion }) => {
    for (const event of events) {
      console.log("Method:", event.method)
      console.log("Body:", JSON.stringify(event.body))
      // Use event.headers to access request headers
    }
  },
})
```

**Security:** Each webhook gets a unique ID in the URL path that acts as a shared secret. The URL format is:

```text
https://www.notion.so/webhooks/worker/{spaceId}/{workerId}/{uniqueWebhookId}/{webhookName}
```

This full URL can be retrieved using the `ntn workers webhooks list` command.

It is also the responsibility of the worker to verify the webhook. Throw `WebhookVerificationError` if the payload is not valid. 5 invalid payloads in a row will cause webhooks to short circuit until redeployed.

### Sync Management (CLI)

**Monitor sync status:**

```shell
ntn workers sync status              # live-updating watch mode (polls every 5s)
ntn workers sync status <key>        # filter to a specific sync capability
ntn workers sync status --no-watch   # print once and exit
ntn workers sync status --interval 10 # custom poll interval in seconds
```

Status labels:

- **HEALTHY** — last run succeeded
- **INITIALIZING** — deployed but hasn't succeeded yet
- **WARNING** — 1–2 consecutive failures
- **ERROR** — 3+ consecutive failures
- **DISABLED** — capability is disabled

**Preview a sync (inspect output without writing):**

```shell
ntn workers sync trigger <key> --preview                   # run execute, show objects, don't write to the database
ntn workers sync trigger <key> --preview --context '{"page":2}'  # resume from a previous preview's nextContext
```

Preview calls your sync's `execute` function and shows the objects it would produce, but **does not write anything to the Notion database**. Use it to verify your sync logic and inspect the data before committing to a real run. When piped, outputs raw JSON.

**Trigger a sync (write immediately, bypass schedule):**

```shell
ntn workers sync trigger <key>
```

Trigger starts a **real** sync cycle that writes to the database, bypassing the normal schedule. Use it to push changes immediately rather than waiting for the next scheduled run.

**Reset sync state (restart from scratch):**

```shell
ntn workers sync state reset <key>
```

Clears the cursor and stats so the next run starts from the beginning.

**Enable / disable a sync:**

```shell
ntn workers capabilities list            # show all capabilities
ntn workers capabilities disable <key>   # pause a sync
ntn workers capabilities enable <key>    # resume a sync
```

> **Note:** `ntn workers deploy` does **not** reset sync state. Syncs resume from their last cursor position after a deploy. Use `ntn workers sync state reset <key>` to explicitly restart from scratch.

### Querying a database

Use `ntn datasources query <data-source-id>` to list pages in a database. **The argument is a data source ID, not a database ID** — a database in Notion is a container for one or more data sources, and the public API queries data sources directly.

If you only have a database ID, run `ntn datasources resolve <database-id>` first to list the data sources it contains:

```shell
ntn datasources resolve <database-id>
```

If exactly one data source is returned, retry the query with that ID. If multiple are returned, pick the one whose name matches what you want.

When `ntn datasources query <id>` returns 404 or "Could not find data source", the ID is most likely a database ID — run `resolve` against it and retry with one of the data source IDs it lists.

## Build, Test, and Development Commands

- Node >= 22 and npm >= 10.9.2 (see `package.json` engines).
- `npm run build`: compile TypeScript to `dist/`.
- `npm run check`: type-check only (no emit).
- `ntn login`: connect to a Notion workspace.
- `ntn workers deploy`: build and publish capabilities. Does not reset sync state.
- `ntn workers exec <capability>`: run a sync or tool.
- `ntn workers sync status`: monitor sync health (live-updating).
- `ntn workers sync trigger <key> --preview`: preview sync output without writing to the database.
- `ntn workers sync trigger <key>`: trigger a real sync immediately (writes to the database).

## Debugging & Monitoring Runs

Use `ntn workers runs` to inspect run history and logs.

**List recent runs:**

```shell
ntn workers runs list
```

**Get logs for a specific run:**

```shell
ntn workers runs logs <runId>
```

**Get logs for the latest run (any capability):**

```shell
ntn workers runs list --plain | head -n1 | cut -f1 | xargs -I{} ntn workers runs logs {}
```

**Get logs for the latest run of a specific capability:**

```shell
ntn workers runs list --plain | grep tasksSync | head -n1 | cut -f1 | xargs -I{} ntn workers runs logs {}
```

The `--plain` flag outputs tab-separated values without formatting, making it easy to pipe to other commands.

### Debugging Syncs

**Check sync health:**

```shell
ntn workers sync status
```

Look at failure counts, error messages, and last succeeded times.

**Sync not running?** Check if the capability is disabled:

```shell
ntn workers capabilities list
```

**Preview what a sync would produce (without writing):**

```shell
ntn workers sync trigger <key> --preview
```

**Retry a failed sync (writes to the database):**

```shell
ntn workers sync trigger <key>
```

**Sync in a bad state?** Reset the cursor and restart:

```shell
ntn workers sync state reset <key>
```

## Coding Style & Naming Conventions

- TypeScript with `strict` enabled; keep types explicit when shaping I/O.
- Use tabs for indentation; capability keys in lowerCamelCase.

## Testing Guidelines

- No test runner configured; validate with `npm run check` and end-to-end testing via `ntn workers exec`.
- Write a test script that exercises each tool capability using `ntn workers exec`. This can be a bash script (`test.sh`) or a TypeScript script (`test.ts`, run via `npx tsx test.ts`). Use the `--local` flag for local execution or omit it to run against the deployed worker.

**Local execution** runs your worker code directly on your machine. Any `.env` file in the project root is automatically loaded, so secrets and config values are available via `process.env`.

**Remote execution** (without `--local`) runs against the deployed worker. Any required secrets must be pushed to the remote environment first using `ntn workers env push`.

**Example bash test script (`test.sh`):**

```shell
#!/usr/bin/env bash
set -euo pipefail

# Run locally (uses .env automatically):
ntn workers exec sayHello --local -d '{"name": "World"}'

# Or run against the deployed worker (requires `ntn workers deploy` and `ntn workers env push` first):
# ntn workers exec sayHello -d '{"name": "World"}'
```

**Example TypeScript test script (`test.ts`, run with `npx tsx test.ts`):**

```ts
import { execSync } from "child_process"

function exec(capability: string, input: Record<string, unknown>) {
  const result = execSync(
    `ntn workers exec ${capability} --local -d '${JSON.stringify(input)}'`,
    { encoding: "utf-8" }
  )
  console.log(result)
}

exec("sayHello", { name: "World" })
```

Use this pattern to build up a suite of exec calls that covers each tool with representative inputs.

## Commit & Pull Request Guidelines

- Messages typically use `feat(scope): ...`, `TASK-123: ...`, or version bumps.
- PRs should describe changes, list commands run, and update examples if behavior changes.
