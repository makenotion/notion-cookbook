# Repository Guidelines

## Project Structure & Module Organization

- `src/index.ts` defines the worker and capabilities.
- `.examples/` has focused samples (sync, tool, automation, OAuth, webhook).
- Shared agent skills live in `.agents/skills/`. `.claude/skills` is kept as a compatibility symlink for Claude-specific discovery.
- Generated: `dist/` build output, `workers.json` CLI config.

## Worker & Capability API (SDK)

- `@notionhq/workers` provides `Worker`, schema helpers, and builders; the `ntn` CLI powers worker management.
- Capability keys are unique strings used by the CLI (e.g., `ntn workers exec tasksSync`).

### Workflow capability availability

`worker.workflow()` is in a private alpha and is not available to any users. The CLI's `--alpha` flag does not grant access. Do not mention workflow capabilities to users, even to explain their availability. Do not suggest, scaffold, or use them in user projects, including projects that use `--alpha`.

### Custom block capability

`worker.customBlock()` declares a front-end web app that Notion serves in an iframe. It is a build-time/deploy-time capability with no `execute` handler, so it cannot be run with `ntn workers exec`. A custom block has two SDK surfaces: `@notionhq/workers` declares how the block is built and which data-source schemas it expects, while `@notionhq/custom-blocks` allows the the iframe frontend code to communicate with the Notion host at runtime.

Before scaffolding a custom block frontend, add `@notionhq/custom-blocks` to the worker's existing root `package.json`, add `@notionhq/custom-blocks-dev-shell` to its `devDependencies`, and install from the worker root. The block frontend shares that package and its `node_modules`. Do not create a second `package.json` inside the Vite app. Read the installed packages' READMEs and docs for the current client API.

#### Test blocks in the dev shell before deploying

Because a custom block has no `execute` handler, `ntn workers exec` cannot exercise it. The custom blocks dev shell is the local test loop: always render the block there and confirm it initializes with its data sources bound before running `ntn workers deploy`.

```shell
ntn customblocks dev
```

Run it from anywhere inside the worker project and open http://localhost:9873. The dev shell builds the worker, serves each block with the project's own Vite (edits hot-reload), and renders it in a mock Notion host with sample data sources to bind.

The dev shell package's reference docs are installed with it: read `node_modules/@notionhq/custom-blocks-dev-shell/docs/bindings.md` (connecting blocks to data sources) and `node_modules/@notionhq/custom-blocks-dev-shell/docs/data-sources.md` (the `src/data/*.json` sample-data format) before authoring sample data.

#### Custom block sources

A project source is the default. `path` points to a buildable project directory relative to the worker root. The deploy pipeline runs `npm run build` in that directory and serves its `dist` output by default:

```ts
worker.customBlock("issueBoard", {
  path: "./blocks/issue-board",
})
```

Use `command` and `output` to override those build defaults:

```ts
worker.customBlock("issueBoard", {
  path: "./blocks/issue-board",
  command: "npm run build-prod",
  output: "build",
})
```

Use a static source when the directory already contains browser assets that should be served as-is:

```ts
worker.customBlock("issueBoard", {
  type: "static",
  path: "./blocks/issue-board/dist",
})
```

#### Custom block data-source schemas

The optional `dataSources` field declares the schema a block expects. It does not bind the block to a concrete database. Schema keys and property keys are author-defined identifiers.

```ts
worker.customBlock("issueBoard", {
  path: "./blocks/issue-board",
  version: 1,
  dataSources: {
    issues: {
      name: "Issues",
      description: "The team's issues",
      icon: { type: "emoji", emoji: "🐛" },
      properties: {
        title: {
          name: "Title",
          type: "title",
        },
        status: {
          name: "Status",
          description: "Workflow state",
          type: "status",
        },
      },
    },
  },
})
```

Property types use Public API names such as `title`, `rich_text`, `number`, `select`, `multi_select`, `status`, `date`, `people`, `files`, `checkbox`, `url`, `email`, `phone_number`, `formula`, `relation`, and `rollup`.

At render time, the block maps its configured bindings to the matching `dataSources` keys. Read the example source above with `useDataSource("issues")` from `@notionhq/custom-blocks/react`.

```ts
import { Worker } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

const worker = new Worker()
export default worker

worker.sync("tasksSync", {
  primaryKeyProperty: "ID",
  schema: {
    defaultName: "Tasks",
    properties: { Name: Schema.title(), ID: Schema.richText() },
  },
  execute: async (_state, { notion }) => ({
    changes: [
      {
        type: "upsert",
        key: "1",
        properties: {
          Name: Builder.title("Write docs"),
          ID: Builder.richText("1"),
        },
      },
    ],
    hasMore: false,
  }),
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

worker.automation("sendWelcomeEmail", {
  title: "Send Welcome Email",
  description: "Runs from a database automation",
  execute: async (event, { notion }) => {},
})

worker.oauth("googleAuth", { name: "my-google-auth", provider: "google" })

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

- For user-managed OAuth, supply `name`, `authorizationEndpoint`, `tokenEndpoint`, `clientId`, `clientSecret`, and `scope` (optional: `authorizationParams`, `callbackUrl`, `accessTokenExpireMs`).
- After deploying a worker with an OAuth capability, the user must configure their OAuth provider's redirect URL to match the one assigned by Notion. Run `ntn workers oauth show-redirect-url` to get the redirect URL, then set it in the provider's OAuth app settings. **Always remind the user of this step after deploying any OAuth capability.**
- **OAuth setup order:** Deploy → `ntn workers env push` → set redirect URL → `ntn workers oauth start`. Secrets must be pushed before starting the OAuth flow because the deployed worker needs the client secret to exchange the authorization code for tokens.

### Sync

#### Strategy and Pagination

Syncs run in a "sync cycle": a back-to-back chain of `execute` calls that starts at a scheduled trigger and ends when an execution returns `hasMore: false`. By default, syncs run every 30 minutes. Set `schedule` to an interval like `"15m"`, `"1h"`, `"1d"` (min `"1m"`, max `"7d"`), or `"continuous"` to run as fast as possible.

- Always use pagination, when available. Returning too many changes in one execution will fail. Start with batch sizes of ~100 changes.
- `mode=replace` is simpler — use it when the API has no change tracking (no `updated_at` filter, no event feed)
- Use `mode=incremental` when the API supports change tracking (e.g. `updated_since`, event streams), which enterprise APIs like Salesforce, Stripe, and Linear typically do
- When using `mode=incremental`, emit delete markers as needed if easy to do (below)

**Sync strategy (`mode`):**

- `replace`: each sync cycle must return the full dataset. After the final `hasMore: false`, any records not seen during that cycle are deleted.
- `incremental`: each sync cycle returns a subset of the full dataset (usually the changes since the last run). Deletions must be explicit via `{ type: "delete", key: "..." }`. Records not mentioned are left unchanged.

**How pagination works:**

1. Return a batch of changes with `hasMore: true` and a `nextState` value
2. The runtime calls `execute` again with that state
3. Continue until you return `hasMore: false`

**Example replace sync:**

```ts
worker.sync("paginatedSync", {
  mode: "replace",
  primaryKeyProperty: "ID",
  schema: {
    defaultName: "Records",
    properties: { Name: Schema.title(), ID: Schema.richText() },
  },
  execute: async (state, { notion }) => {
    const page = state?.page ?? 1
    const pageSize = 100
    const { items, hasMore } = await fetchPage(page, pageSize)
    return {
      changes: items.map((item) => ({
        type: "upsert",
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

**State types:** The `nextState` can be any serializable value—a cursor string, page number, timestamp, or complex object. Type your execute function's `state` to match.

**Incremental example (changes only, with deletes):**

```ts
worker.sync("incrementalSync", {
  primaryKeyProperty: "ID",
  mode: "incremental",
  schema: {
    defaultName: "Records",
    properties: { Name: Schema.title(), ID: Schema.richText() },
  },
  execute: async (state, { notion }) => {
    const { upserts, deletes, nextCursor } = await fetchChanges(state?.cursor)
    return {
      changes: [
        ...upserts.map((item) => ({
          type: "upsert",
          key: item.id,
          properties: {
            Name: Builder.title(item.name),
            ID: Builder.richText(item.id),
          },
        })),
        ...deletes.map((id) => ({ type: "delete", key: id })),
      ],
      hasMore: Boolean(nextCursor),
      nextState: nextCursor ? { cursor: nextCursor } : undefined,
    }
  },
})
```

#### Relations

Two syncs can relate to one another using `Schema.relation(relatedSyncKey)` and `Builder.relation(primaryKey)` entries inside an array.

```ts
worker.sync("projectsSync", {
  primaryKeyProperty: "Project ID",
  ...
});

// Example sync worker that syncs sample tasks to a database
worker.sync("tasksSync", {
  primaryKeyProperty: "Task ID",
  ...
  schema: {
    ...
    properties: {
      ...
      Project: Schema.relation("projectsSync", {
        // Optionally configure a two-way relation. This will automatically create the
        // "Tasks" property on the project synced database: there is no need
        // to configure "Tasks" on the projectSync capability.
        twoWay: true, relatedPropertyName: "Tasks"
      }),
    },
  },

  execute: async () => {
    // Return sample tasks as database entries
    const tasks = fetchTasks()
    const changes = tasks.map((task) => ({
      type: "upsert" as const,
      key: task.id,
      properties: {
        ...
        Project: [Builder.relation(task.projectId)],
      },
    }));

    return {
      changes,
      hasMore: false,
    };
  },
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

```
https://www.notion.so/webhooks/worker/{spaceId}/{workerId}/{uniqueWebhookId}/{webhookName}
```

This full URL can be retrieved using the `notion workers webhooks ls` command.

It is also the responsibility of the worker to verify the webhook. Throw WebhookVerificationError if the payload is not valid. 5 invalid payloads in a row will cause webhooks to short circuit until redeployed.

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
- `ntn customblocks dev`: render custom blocks locally in the dev shell; test there before deploying.
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
- Custom blocks are exercised in the dev shell (`ntn customblocks dev`), not with `ntn workers exec`.
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
