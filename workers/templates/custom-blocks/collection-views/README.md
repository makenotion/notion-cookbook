# Collection views

Five independently selectable custom blocks in one Notion Worker: **Table**, **Board**,
**Gallery**, **List**, and **Feed**. Map the same project database into each block to
get familiar layouts with editable properties, creation, host filtering and sorting,
and page navigation. Custom blocks require private-alpha access.

Use this recipe as a starting point for your own database interface. Everything is
standalone: public published SDKs, React, plain CSS with the Notion CSS variables
stylesheet and `NotionTokenScope`, TanStack Virtual, and dnd-kit. No internal Notion
components, Tailwind, service credentials, or page-body APIs are used.

## Run locally

Requires Node.js 22.12+ and npm 10.9.2+. No authentication is needed for the preview.
From this directory:

```sh
npm install
npm run check
npm test
npm run build
npm run dev
```

Open the shell URL printed by the command (normally http://localhost:9873).
Select `table`, `board`, `gallery`, `list`, or `feed` in the sidebar. Under **Viewport**,
choose **Full page** for a wide view; use **Inline** to check a page-width embed.
The shell supplies the actual SDK handshake, bound schemas, subscriptions, and
peek responses. Its data is simulated, with no customer workspace access.
The published shell does not connect seeded query rows to its writable page store:
edits of these rows return `page not found`, and created pages are not returned by
the seed query. Verify successful mutations against a local Notion instance.

`npm run dev` seeds 36 useful project rows once, then launches the pinned published
`custom-blocks-dev-shell` binary. The shell reads this JSON seed at startup. To deliberately reset the local sample or
exercise a large source, stop the shell first:

```sh
npm run seed -- --count=1200 --overwrite
npm run dev
```

Use `--count=0` for an empty database. Seeding never writes to Notion. The generated
`data/worker_items.json` and shell state are ignored by Git. Existing seed data is
preserved unless `--overwrite` is supplied.

The public SDK `0.2.24` and dev shell `0.1.104` are pinned as a compatible pair.
Dev shell `0.1.105` requires bridge protocol 6 and rejects this SDK's protocol 5.
Update and verify both packages together. `npm run dev` invokes the installed shell
directly because some `ntn` versions fetch the latest shell instead of the local pin.

## Bind a database

All capabilities declare one reusable `items` data source, named **Projects**.
Create a database with these properties, or map matching properties in the host:

| Key       | Suggested property | Type   | Purpose                                  |
| --------- | ------------------ | ------ | ---------------------------------------- |
| `name`    | Name               | Title  | Openable title, search, sorting, editing |
| `stage`   | Stage              | Select | Board columns, Stage filter, moves       |
| `summary` | Summary            | Text   | Editable project description             |
| `due`     | Due                | Date   | Date display, sorting, editing           |
| `owner`   | Owner              | People | Display assignees                        |
| `image`   | Image              | Files  | Optional image value for gallery cards   |
| `rating`  | Rating             | Number | Rating display, sorting, editing         |

Every declared property must be mapped before initialization, even when its values
are empty. Add empty properties of the right type if your database does not have
them yet, or remove declarations and their UI controls when adapting this recipe.
The sample editor treats Rating as a 0–5 integer score; adjust its bounds for
another numeric domain. Owners and Image are read-only in this example; edit those properties in Notion.

For the sample, create Select options **Backlog**, **In progress**, and **Done**.
Existing option names work too: columns come from the host schema and loaded rows,
including empty columns and **No stage**. Moves use existing options; they do not
create options or change their definitions. To use a **Status** property instead,
change `stage.type` to `"status"` in `src/schema.ts` and the seed schema, then rebuild
and rebind. The shared query and write helpers support both types. There is no
single declaration that accepts both property types.

The SDK supplies dates as calendar date values; this recipe preserves their
`start_date` without timezone conversion. The editor handles date-only values;
it does not expose date ranges or times. People names come from cached `users.get` requests for the distinct
authors and assignees referenced by loaded rows, with at most four requests at a
time. Invalid or inaccessible IDs retain an explicit `Person <ID prefix>` label
and an error notice. Feed uses the built-in creator and creation timestamp for
its author byline; the mapped Due property controls its chronological default sort.

Gallery defaults to **Card preview → None**. Choose **Image** in View options to
use the mapped Files property. Query snapshots flatten external file names and
omit uploaded Files entirely, so a blank query value does not establish that a
page has no image. Image mode performs a cached `pages.get` for visible cards only;
None and other views make no image metadata requests. The cache invalidates when
the query value or page's last edit changes. **Retry image** requests fresh metadata
for expired URLs. Empty Files values produce an empty preview area.

The production sandbox allows bundled and approved Notion-hosted media, plus
workspace-approved external origins. Other external URLs can fail even when they
work in the dev shell. Failures show an explicit retry. This recipe does not widen
the sandbox's network policy.
Feed's page-content preview is explicitly a placeholder. Summary is a database
property, not a fetched page body. Open the page to read its content.

## Behavior and limits

- Queries use `useDataSource("items", options)`. Name search and Stage filtering
  execute in the host before the limit; Name, Due, and Rating sorting use supported
  property sorts. Changing the query resets the requested limit to 100.
- **Load more** increases the query limit by 100, replacing the snapshot, up to the
  SDK maximum of 999. `hasMore` drives the incomplete-results notice. At the cap,
  narrow the search or Stage filter to reach other records. This works with sources
  larger than 999; it does not claim to load the whole database.
- Board counts explicitly describe **loaded** cards. Dropping a card changes its
  Stage through `row.update`. The **Move to** select provides a keyboard and touch
  alternative. Dnd-kit uses `@dnd-kit/react`'s current `DragDropProvider`,
  `useDraggable`, and `useDroppable` APIs; there is no manual reorder persistence.
- TanStack Virtual bounds Table, List, Feed, and Gallery rows and every Board
  column. Gallery groups responsive card rows. Dragging never disables Board
  virtualization. Scroll regions are focusable and support native keyboard scrolling.
- The title, view pill, icon toolbar, property headers, 37px Table rows, 130px
  Board/Gallery cards, and 32px List spacing follow Classic Notion. Table headers
  resize with a pointer or Left/Right arrows; View options toggles properties.
  These preferences are local to the mounted block.
- **Edit properties** opens a native modal dialog. Name, Stage, Summary, Due, and Rating can
  be changed; **New project** calls `pages.create` with semantic property keys.
  Writes are serialized and wait for success. Failed writes leave the source
  snapshot untouched and keep an edit draft available, with an explicit error.
  Creation may put a row outside the current filter or loaded window.
- Feed defaults to Due date descending, using the mapped date column. Other views
  default to Name ascending.
- Title buttons call `pages.open` with the selected `side_peek` or `center_peek`
  mode. A successful SDK result means the host accepted the request; it does not prove
  that the destination finished loading. The UI does not show bridge diagnostics. The dev shell accepts requests without
  rendering a real Notion peek. A real Notion surface may fall back to full-page
  navigation; opening a new peek can unmount the block and lose local state.
- Loading, query errors, write errors, initialization failures, unbound sources,
  empty results, missing values, light/dark appearance, and narrow embeds have
  explicit handling. The host owns binding controls; map properties there to retry.

## Code map and customization

| File                                                   | Responsibility                                              |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| `src/index.ts`                                         | Register five separate capabilities and build paths         |
| `src/schema.ts`                                        | One schema shared by every capability                       |
| `blocks/{table,board,gallery,list,feed}/src/index.tsx` | Independent view entrypoints                                |
| `blocks/shared/Collection.tsx`                         | Subscription, toolbar, writes, and navigation               |
| `blocks/shared/model.ts`                               | Typed property reads, filters, sorts, and write payloads    |
| `blocks/shared/Properties.tsx`                         | Shared property displays and explicit page-body placeholder |
| `blocks/shared/views/`                                 | Virtualized row layouts and Board drag/drop                 |
| `blocks/shared/Editor.tsx`                             | Accessible property editor                                  |
| `blocks/shared/styles.css`                             | Plain CSS using SDK Notion design tokens                    |
| `scripts/seed.ts`                                      | Deterministic preview data, including high row counts       |

For example, `Rating` in `Properties.tsx` renders a Number property as a number.
To show stars, render `"★".repeat(Math.round(value))` for a bounded 0–5 score;
keep `rating` as a Number in the schema and SDK payloads. Add a new display by
reading its semantic key in `readItem`, then composing it into the relevant view.
Keep supported server-side sorts in `queryOptions`; do not sort only the loaded
subset while implying a database-wide order.

Fixed row/card heights keep virtualization predictable. Summary remains editable
in the property dialog; use the editor or open the page for longer text. If you make rows variable height,
use TanStack Virtual's measurement API and verify scrolling with long content.

## Verification

```sh
npm run check
npm test
npm run build
# With system Google Chrome and ffmpeg available:
npx playwright install ffmpeg
# Start npm run dev separately, using the 1200-row seed above.
npm run test:browser
```

`test:browser` drives system Chrome through the running published dev shell. It
asserts all five views, host filtering/sorting, bounded scrolling, the 999-row cap,
and retained drafts after real seeded-row write rejections. It deliberately does
not claim successful mutations on seeded rows. It saves screenshots and a JSON
report to `/tmp/collection-views-evidence` by default; set `EVIDENCE_DIR` or
`DEV_SHELL_URL` to override. Failures throw and retain evidence. Automated browser
checks are not manual testing.

### Verify against local Notion

Successful writes and loaded peek destinations require a local Notion server with
custom blocks enabled, a local Worker deploy, and all five blocks bound to the same
fixture database. The public dev shell cannot verify these paths. Do not point this
check at shared or customer environments.

Prepare a JSON receipt with `origin` (localhost only), `email` (the local fixture
identity), `spaceId`, `propertyIds.stage` (the raw Stage property ID), and `views`
containing `{ "pageId": "..." }` for each of the five view names. Seed enough rows
to include a Backlog card and In progress/Done options. Seed the page body sentence
`This is seeded local page content for verifying that navigation reaches a real Notion page.`
for the peek destination assertion. The fixture identity must have edit permission.

```sh
LOCAL_NOTION_FIXTURE=/tmp/local-collection-views.json npm run test:local
```

The check uses the actual nested custom-block iframe, public SDK calls, authenticated
server record reads, and reloads. It verifies create/edit, unchanged unrelated
properties, pointer Board drop, keyboard Move to, both loaded peek destinations,
and all five light/dark/narrow layouts. It records an interaction video and reports
browser errors. It restores the edited title and moved card; the newly created
verification page remains in the local fixture. It never replaces the SDK transport.
The server, relay, CLI authentication, and fixture are environment prerequisites,
not production dependencies of this recipe. Production permissions, multi-user
updates, and production-host deployment still need separate validation.

For secondary deterministic UI checks only, a development block URL can use
`?mock=1` with `theme=dark`, `empty`, `loading`, `unbound`, `error`, or `failwrites`.
This separate in-memory source has an explicit simulated-preview banner and is
excluded from production bundles. It is not evidence of SDK or host writes.

## Deploy when ready

Only deploy after intentionally choosing a test workspace with custom blocks
enabled. Install the Workers CLI, authenticate, and deploy:

```sh
npm install --global ntn
ntn login
ntn workers deploy --name collection-views
```

Insert the relevant `/collection-table`, `/collection-board`, `/collection-gallery`,
`/collection-list`, or `/collection-feed` block in a page, then bind **Projects**
and every declared property. Each capability is selectable independently; it does
not require the other four blocks to be present.
