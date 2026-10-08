# Apps template guidance

Apps are a private alpha. Check the installed `@notionhq/apps` exports and
declarations before using a capability; SDK support does not establish that a
provider is enabled on the server.

## Design the App before implementation

First establish what the complete App should do: its outcome, source data,
triggers, external services, and every Notion resource it needs. Recommend a
workflow for most automations; use a sync when the goal is to mirror an external
collection into a Notion database. An App may contain both.

Follow `.agents/skills/sketch/SKILL.md` to propose the design as a
sketch the user can review. Sketch from the user's description; do not read
full skill instructions, generated declarations (`*.generated.d.ts`), or
provider API surfaces until the user agrees on a direction. Alongside the
sketch link, briefly state what the sketch does not show:

- `APP.md`, the primary views it will embed, and the resources it will link to.
- Every sync, including its external source, destination database, and
  synchronization behavior.
- Open decisions and required access.

Do not begin implementation until the user agrees. If implementation reveals a
material resource or capability not covered by the agreed design, update the
sketch and confirm the change before adding it.

## App home page (APP.md)

The app root includes `APP.md`. This file is the App's home page and, as much
as the App needs one, its user interface. Design it as the place people come
to use the App. Update it when the App's behavior or resources change.
The Apps SDK provisions the page in the
installation workspace when the file exists. Its page title is the deployed
App's name, not `APP.md`; do not put a second copy of the title in its body.

Use the installed SDK's `skills/notion-as-code/markdown.md` reference for
Notion Markdown in `APP.md`, page content, and custom-agent instructions.
Use resource IDs in mentions and database tags. An optional YAML frontmatter
`icon` sets the app page icon; the build removes frontmatter from the body.

Use this basic structure, adapting the sections to the App:

1. **Brief description:** Explain what the App does and who it helps in a few
   sentences.
2. **Primary views:** Embed the most important databases or specific views,
   including custom views, in the order people need them. For a CRM, this
   might be Contacts and a pipeline view; for a meeting App, a next-meeting
   card and upcoming meetings. Give each view a clear heading and only the
   explanation needed to use it.
3. **Common actions:** Explain what to open, add, or change and what happens
   next. Include views or controls for those actions when available, along
   with useful status indicators and automatic update behavior.
4. **Supporting resources:** Link to other pages and databases people may
   need without embedding every resource on the home page.

Embed linked database views with declared data source or view resource IDs,
including custom view resource IDs. For example, after declaring the view:

```text
<database inline="true" data-source-url="{{contacts-view}}">Contacts</database>
```

Use a Notion as Code resource reference, such as
`<mention url="resource-id">Resource name</mention>`, to link to
another page declared by the App. Keep the resource ID in sync with the
corresponding declaration. Use only declared resources in actual embeds and
links; keep illustrative placeholders in code fences. Do not create a separate
home page. Keep developer setup, deployment commands, and implementation
details in the README.

## SDK imports

Import the creation helpers you use directly from the package root:

```ts
import { database, sync } from "@notionhq/apps"
```

The root exports `page`, `database`, `teamspace`, `customAgent`, `view`,
`sync`, `workflow`, and `customBlock`. Workflow helpers `access`, `input`,
and `events`, plus workflow types such as `WorkflowContext`, are also available
from the root.
`sync` takes a Notion as Code data source handle. There is no standalone
`dataSource`; declare data sources inside `database`.

Keep other imports on their existing subpaths: `Builder` from
`@notionhq/apps/builder`, value helpers and types from their own modules,
`connections` from `@notionhq/apps/workflow`, and `events` from
`@notionhq/apps/events` (or use the workflow's typed trigger callback).
Provider input and result types come from `@notionhq/apps/connections/<provider>`.
Browser runtime and React APIs also keep their subpaths.

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

The App template's `.agents/skills/` files point to the full SDK skills
installed under `./node_modules/@notionhq/apps/skills/`. For every area you
implement, follow the template pointer and read the corresponding installed
SDK skill listed in this table. If the installed SDK skill is missing, install
the App's dependencies; if it remains missing, update `@notionhq/apps` to a
release that includes it. Do not continue without the full SDK guidance.

| Area           | Where used                                                   | Template pointer                         | Full SDK skill                                               |
| -------------- | ------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------ |
| Workflow       | `src/workflows/`                                             | `.agents/skills/workflow/SKILL.md`       | `node_modules/@notionhq/apps/skills/workflow/SKILL.md`       |
| Connections    | Workflow provider clients and triggers                       | `.agents/skills/connections/SKILL.md`    | `node_modules/@notionhq/apps/skills/connections/SKILL.md`    |
| Database sync  | `src/syncs/`                                                 | `.agents/skills/sync/SKILL.md`           | `node_modules/@notionhq/apps/skills/sync/SKILL.md`           |
| Custom blocks  | `src/customBlocks/`                                          | `.agents/skills/custom-blocks/SKILL.md`  | `node_modules/@notionhq/apps/skills/custom-blocks/SKILL.md`  |
| Notion as Code | Resources declared in modules imported by workflows or syncs | `.agents/skills/notion-as-code/SKILL.md` | `node_modules/@notionhq/apps/skills/notion-as-code/SKILL.md` |
| Sketch         | Design proposals before implementation                       | `.agents/skills/sketch/SKILL.md`         | `node_modules/@notionhq/apps/skills/sketch/SKILL.md`         |

Notion as Code declarations are not a separate discovered capability
directory. Syncs can use their declared data source handles.

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
