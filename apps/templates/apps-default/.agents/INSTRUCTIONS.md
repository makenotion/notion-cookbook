# Apps template guidance

Apps are a private alpha. Check the installed `@notionhq/apps` exports and
declarations before using a capability; SDK support does not establish that a
provider is enabled on the server.

## Design the App before implementation

First establish what the complete App should do: its outcome, source data,
triggers, external services, and every Notion resource it needs. Recommend a
workflow for most automations; use a sync when the goal is to mirror an external
collection into a Notion database. An App may contain both.

Before proposing the design, read only enough of this guidance and the
top-level descriptions of the relevant capability skills (workflow, sync,
connections, and Notion as Code) to describe concrete options for open
decisions. Do not read full skill instructions, generated declarations
(`*.generated.d.ts`), full provider API surfaces, or other implementation
details until the user agrees on a direction. Verify those details against the
selected option during implementation.

Present the proposed design concisely and get the user's agreement before
implementing. Always include an App home page that explains what the App does
and links to all of its Notion resources. The proposal should include:

- Every Notion resource the App will create, including the home page, databases,
  other pages, and custom agents; state each resource's purpose and which
  capabilities use it.
- Every sync, including its external source, destination database, and
  synchronization behavior.
- Every workflow, including its trigger, main actions, resources it reads or
  changes, and external connections.
- Open decisions and required access.

Adapt the format to the App. For example:

### Example App design

**Outcome:** Bring support tickets into Notion and escalate urgent tickets to
the support team.

**Notion resources**

| Kind         | Name              | Purpose                                             | Used by                          |
| ------------ | ----------------- | --------------------------------------------------- | -------------------------------- |
| Page         | Support app home  | Explain the App and link to its resources           | Team members                     |
| Database     | Support tickets   | Store synchronized tickets and triage status        | Ticket sync, escalation workflow |
| Page         | Support dashboard | Give the team an operational home and database view | Team members                     |
| Custom agent | Ticket triage     | Classify urgency and summarize a ticket             | Escalation workflow              |

**Syncs and workflows**

| Kind     | Name                   | Source or trigger                       | Behavior                                              | Dependencies                                                        |
| -------- | ---------------------- | --------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| Sync     | Ticket sync            | Support-system tickets                  | Upsert by stable external ID                          | Support-system connection, Support tickets database                 |
| Workflow | Escalate urgent ticket | Support tickets page created or updated | Run triage, update status, and notify support channel | Ticket triage agent, Support tickets database, messaging connection |

**Open questions:** Which support system and messaging channel should the App use?

Ask the user to confirm or revise the design. Do not begin implementation
until they agree. If implementation reveals a material resource or capability
not covered by the agreed design, update the proposal and confirm the change
before adding it.

## SDK imports

Import the creation helpers you use directly from the package root:

```ts
import { database, sync } from "@notionhq/apps"
```

The root exports only `page`, `database`, `teamspace`,
`customAgent`, `sync`, `workflow`, and `customBlock`.
`sync` takes a Notion as Code data source handle. There is no standalone
`dataSource`; declare data sources inside `database`.

Keep all other imports on their existing subpaths: `Builder` from
`@notionhq/apps/builder`, value helpers and types from their own modules,
`connections` from `@notionhq/apps/workflow`, and `triggers` from
`@notionhq/apps/triggers` (or use the workflow's typed trigger callback).
Browser runtime and React APIs also keep their subpaths. The package root does not export these
utilities or types.

Check that the installed SDK supports these exports before building.

## Capability layout

After the user agrees on the design, compare it with the complete scaffold.
Remove template workflows, syncs, custom blocks, Notion resource declarations,
sample assets, and supporting code that the App does not need. Do not leave
example or placeholder capabilities in discovered capability directories: the
build can include and deploy them. Preserve shared configuration and
infrastructure required by the selected capabilities.

Each direct TypeScript file in these directories default-exports a declaration.
Its filename supplies the capability key. Put capability-specific helpers in
`src/workflows/lib/` (or the matching capability directory's `lib/`) and shared
helpers in `src/lib/`. Discovery only reads direct children, so these helpers
are not treated as capabilities.

| Directory           | Declaration        | Guidance                                |
| ------------------- | ------------------ | --------------------------------------- |
| `src/workflows/`    | `workflow(...)`    | `.agents/skills/workflow/SKILL.md`      |
| `src/syncs/`        | `sync(...)`        | `.agents/skills/sync/SKILL.md`          |
| `src/customBlocks/` | `customBlock(...)` | `.agents/skills/custom-blocks/SKILL.md` |

Read the matching skill before implementing a capability. Workflows that use
connections also need `.agents/skills/connections/SKILL.md`.

For resources declared with the App, read
`.agents/skills/notion-as-code/SKILL.md`. Notion as Code declarations belong in
modules imported by workflows or syncs; they are not a separate discovered
capability directory. Syncs can use their declared data source handles.

Prefer Notion as Code over other methods for equivalent supported resource
setup. Use another method when the user explicitly requests it, an existing
resource must be attached, or the required operation is not supported by Apps
Notion as Code. Runtime operations on changing data still use the appropriate API.

Apps do not expose Worker-style tool or webhook registration, Worker fetch
interceptors, or Worker managed-database configuration. Do not translate those
APIs by changing package names. Sync contexts have `notion`, but no workflow
`step` or `connections` client.

## Runtime and credentials

Use Node.js 26 or newer and install from the app root. Use `context.notion`
for Notion API access. Deployed apps receive Notion credentials automatically;
local execution needs `NOTION_API_TOKEN` in `.env` before making API requests.
Never commit tokens or generated `dist/` and `.notion/` state.

## Verification and deployment

Run `npm run check` and `npm run build` from the app root after changes.
Add offline tests for pagination, transforms, and retry-sensitive behavior.
Building does not verify server availability, published connection setup, or
browser interactions. State separately which live checks actually ran.

For a requested deployment, enable `ntn experiments enable apps`, authenticate,
and use `ntn apps deploy --json` with any required arguments. On the first
deployment, pass `--name <name>`; omit `--name` for updates. Use the JSON fields
`worker_url`, `setup_url`, and `is_update` in the handoff. For a first
deployment (`is_update` is false), show the `setup_url` and tell the user to
open it to finish setup. For an update (`is_update` is true), show both URLs
with clear labels: `worker_url` opens the deployed App and `setup_url` revisits
onboarding. Use the URLs returned by the CLI; do not construct or guess them.
Read the installed CLI help for other commands.
