# App skill evaluation scenarios

Run these requests against a copied App template with the generated skills.
Inspect code and compile against the intended SDK version. Do not deploy or
use live credentials.

Ask for a workflow, a Notion as Code resource, a sync, and a custom block.
Verify examples directly import the creation helpers they use, such as
`import { database, sync } from "@notionhq/apps"`. The root exports `page`,
`database`, `teamspace`, `customAgent`, `view`, `sync`, `workflow`, `customBlock`,
`access`, `input`, `events`, and workflow types. Data sources belong inside
`database`. Builders, provider types, connections, and browser runtime clients
use their own subpaths. Compile against the installed Apps SDK; report any
version mismatch.

For Calendar, ask for upcoming meetings from calendars chosen during setup.
Verify one Calendar connection with reusable named targets, explicit permissions
and cardinality, and a target on every read. Missing selections must fail rather
than falling back to every approved calendar. For a write to a multiple target,
verify it lists the target and passes one returned calendar object per write.

For page content, custom-agent instructions, and `APP.md`, verify the agent
follows the installed SDK's Notion Markdown reference. Resource mentions use
`<mention url="resource-id">`; linked views use database tags. An `APP.md` icon
belongs in YAML frontmatter, not in a repeated page title.

For Notion as Code, ask the agent to declare an Issues database and sync records
into it. Verify that the sync uses a data source handle with
`sync`, retains stable resource IDs, omits the primary-key
property from upserts, and emits provisioning metadata on build. Ask for a
relation property and verify it recognizes the current adapter limitation.
Ensure it distinguishes a successful build from live provisioning.

When both Notion as Code and other setup can meet a request, verify the agent chooses
Notion as Code by default. An explicit request to attach an existing database should
retain that database rather than provision a replacement. The sync skill should
explain that existing-database attachment is outside its Notion as Code recipe
and clarify the next step.

Also place a page declaration in an imported `src/lib/` module and another
in an unimported module. Verify only the imported page appears in provisioning
output. Check that it does not expect Notion as Code imports used only by custom blocks
to be recorded. Ask about workspace creation and standalone Notion as Code apply: it
should identify the Apps workspace restriction and the different artifact
and attachment flows.

Ask for a new App from a short description. Verify the agent writes a sketch
with the SDK sketch skill, shares its viewer link, and lists `APP.md` and any
syncs separately because the sketch format does not show them. It should not
read SDK declarations or write capability code until the user agrees.

| Request                                                      | Expected observable outcome                                                                                                                                                                                     |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a paginated issue sync                                   | Direct default export in src/syncs; Notion as Code data source for an App-created database; primary key on sync and omitted from upsert properties; stable keys; cursor survives empty pages with a next cursor |
| Migrate a Worker tool and auth interceptor                   | Explains that Apps lacks those registration APIs; does not invent equivalent APIs or assume sync has workflow connections                                                                                       |
| Read records through a provider connection                   | Declares the provider connection; uses its typed client inside steps; follows the method's input and result types; handles partial errors                                                                       |
| Retry an uncertain provider write                            | Reconciles existing successful writes before retrying; uses idempotency only when supported by the method                                                                                                       |
| Listen for Slack messages through a named support connection | Declares a Slack connection and binds its key using the typed trigger callback; rejects undeclared or wrong-provider keys and duplicate trigger/key pairs; distinguishes connection keys from step keys         |
| Add an interactive issue board                               | Uses customBlock, Apps React imports, root-owned dependencies, and separate browser tsconfig; schema declaration is distinguished from binding                                                                  |
| Review a workflow with mutable step-local state              | Reports replay hazard with file, line, impact, and fix; returns needed values from steps; narrows trigger events                                                                                                |
| Propose a new App before building                            | Writes a checked sketch from the SDK sketch skill; shares its link; notes APP.md and syncs outside the sketch; waits for agreement before code                                                                  |
