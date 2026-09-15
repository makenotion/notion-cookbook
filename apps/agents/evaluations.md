# App skill evaluation scenarios

Run these requests against a copied App template with the generated skills.
Inspect code and compile against the intended SDK version. Do not deploy or
use live credentials.

Ask for a workflow, a Notion as Code resource, a sync, and a custom block.
Verify examples use `import * as Notion from "@notionhq/apps"` and the short
creation names. The root has only `page`, `database`, `teamspace`, `customAgent`,
`sync`, `workflow`, and `customBlock`. Reject old `create*` capability calls,
a standalone `Notion.dataSource`, and root imports of builders, types,
connections, triggers, or browser runtime clients. Keep these helpers on their
existing subpaths. Compile the examples against an SDK release with these
exports; report a version mismatch rather than falling back to old names.

For Notion as Code, ask the agent to declare an Issues database and sync records
into it. Verify that the sync uses a data source handle with
`Notion.sync`, retains stable resource IDs, omits the primary-key
property from upserts, and emits provisioning metadata on build. Ask for a
relation property and verify it recognizes the current adapter limitation.
Ensure it distinguishes a successful build from live provisioning.

When both Notion as Code and other setup can meet a request, verify the agent chooses
Notion as Code by default. An explicit request to attach an existing database should
retain that database rather than provision a replacement. The sync skill should
explain that existing-database attachment is outside its Notion as Code recipe
and clarify the next step, not switch to legacy sync guidance.

Also place a page declaration in an imported `src/lib/` module and another
in an unimported module. Verify only the imported page appears in provisioning
output. Check that it does not expect Notion as Code imports used only by custom blocks
to be recorded. Ask about workspace creation and standalone Notion as Code apply: it
should identify the Apps workspace restriction and the different artifact
and attachment flows.

| Request                                                      | Expected observable outcome                                                                                                                                                                                     |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a paginated issue sync                                   | Direct default export in src/syncs; Notion as Code data source for an App-created database; primary key on sync and omitted from upsert properties; stable keys; cursor survives empty pages with a next cursor |
| Migrate a Worker tool and auth interceptor                   | Explains that Apps lacks those registration APIs; does not invent equivalent APIs or assume sync has workflow connections                                                                                       |
| Read records through a provider connection                   | Declares the provider connection; uses its typed client inside steps; follows the method's input and result types; handles partial errors                                                                       |
| Retry an uncertain provider write                            | Reconciles existing successful writes before retrying; uses idempotency only when supported by the method                                                                                                       |
| Listen for Slack messages through a named support connection | Declares a Slack connection and binds its key using the typed trigger callback; rejects undeclared or wrong-provider keys and duplicate trigger/key pairs; distinguishes connection keys from step keys         |
| Add an interactive issue board                               | Uses Notion.customBlock, Apps React imports, root-owned dependencies, and separate browser tsconfig; schema declaration is distinguished from binding                                                           |
| Review a workflow with mutable step-local state              | Reports replay hazard with file, line, impact, and fix; returns needed values from steps; narrows trigger events                                                                                                |
