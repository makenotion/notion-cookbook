# Create instances and manage bindings

Use these commands after the binding and Views APIs deploy and the matching CLI
release is installed. Check the installed command's `--help` before using a new
operation. Inline custom blocks, custom pages, and custom database views share
the same binding rules.

Page-binding targets must be regular Notion pages, including database rows.
Custom pages, inline blocks, full-page databases, and meeting-note pages are
unsupported targets. Custom pages and custom views can still own bindings.

## Create or connect an instance

```sh
instance_id=$(ntn workers customblocks make --key issueBoard --json | jq -r '.block_id')
ntn workers customblocks bind --target "$instance_id" --data-sources @data-sources.json --pages @pages.json --json
```

Without a destination, `make` creates a private custom page.
`make --target <page-or-block-id-or-url>` selects placement or an existing
instance. Use `--definition <id>` to select a definition without a local Worker
project; it conflicts with `--key`. With neither selector, the configured
Worker must have exactly one custom-block capability.

Use the created instance's returned ID for binding commands, not its containing
page's ID. Existing connected instances cannot switch definitions.
Create with `make`, then use `bind` to configure instance overrides.

For custom views, distinguish creation location from the exact setup target:
a database or existing-view location creates a new view, while
`make --target <existing-custom-view-id-or-url>` configures that exact view.
A view URL may identify the view in its `v` query parameter.
When a database has multiple data sources, select the intended source explicitly.

```sh
# Create a sibling; leave the existing view unchanged.
ntn workers customblocks make --definition 22222222-2222-4222-8222-222222222222 --database "<existing-view-id-or-url>" --json
# Connect the exact existing view used by the setup agent.
ntn workers customblocks make --definition 22222222-2222-4222-8222-222222222222 --target "<existing-custom-view-id-or-url>" --json
```

Legacy `make --bindings <JSON|@path>` is deprecated and available only for inline
blocks and custom pages. It warns on stderr while preserving JSON stdout.
Do not use it for views. Use `make`, then `bind --target <view-id>`.

## Set defaults or overrides

```sh
ntn workers customblocks bind --key issueBoard --data-sources @data-sources.json --pages @pages.json --json
ntn workers customblocks bind --definition aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa --pages @pages.json --json
ntn workers customblocks bind --target bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb --data-sources @data-sources.json --json
```

`bind`, `unbind`, and `bindings` require exactly one selector.
`--key` resolves a deployed capability through the configured Worker.
`--definition` selects shared definition defaults. `--target` selects an existing
inline block, custom page, or custom view. Direct IDs use normal CLI auth and
workspace configuration without requiring a local Worker project.
Binding commands never create an instance at a destination.

`bind` requires at least one category. Both flags accept inline JSON or `@path`:

```json
[
  {
    "key": "tasks",
    "data_source_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "property_ids_by_key": { "title": "title" }
  }
]
```

```json
[{ "key": "settings", "page_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }]
```

Use declared binding and property keys. Data-source IDs are distinct from
database IDs: resolve a database with `ntn datasources resolve <database-id>`.
Never use `ntn workers databases attach` for custom-block bindings.

Supplied bindings merge by key; unmentioned keys and categories remain unchanged.
Updating a data-source key replaces that key's whole property mapping.
Both categories validate and commit atomically. Do not read, merge, and replace
binding lists in a script. Use `unbind` for removals and clears; do not send null
IDs or empty arrays to make a PATCH delete bindings.

## Remove bindings

```sh
ntn workers customblocks unbind --key issueBoard --data-source tasks --page settings --json
ntn workers customblocks unbind --target bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb --page settings --json
ntn workers customblocks unbind --target bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb --all --json
```

When the user names keys, remove only those keys with repeatable
`--data-source <key>` and `--page <key>` flags.
Use `--all-data-sources`, `--all-pages`, or `--all` only when the user asks to
clear those categories. Category-clear flags conflict with named keys in that
category; `--all` conflicts with every other removal flag.

Definition unbind removes defaults. Instance unbind removes overrides and
restores inheritance from definition defaults; it never suppresses inheritance.
Removing an absent saved key is idempotent and does not delete the referenced
resource. The CLI uses explicit binding-deletion operations, not a destructive
PATCH payload.

## Inspect effective bindings

```sh
ntn workers customblocks bindings --key issueBoard --json
ntn workers customblocks bindings --definition aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa --json
ntn workers customblocks bindings --target bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb --json
```

Definition reads show saved defaults. Instance reads show effective
`data_sources` and `pages`; each entry carries
`source: "definition" | "instance"`. A same-key instance override wins over the
definition default. These are resolved values, not raw override lists.
Do not copy inherited entries back onto the instance merely to preserve them.
Unreadable targets are filtered after resolving overrides; a hidden override
does not fall back to the definition's default.
