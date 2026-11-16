# Bind custom block data sources and pages

Use these commands after the binding API deploys and the corresponding CLI release
is installed. Run `ntn workers customblocks bind --help` to check availability.
Older SDK instructions that say arrays replace whole binding lists predate this
intentional private-alpha change.

Page binding targets must be regular Notion pages (internal type `page`), including
database row pages. Custom pages, inline custom blocks, full-page databases, and
meeting-note pages cannot be page targets. A custom page or inline custom block
can still own bindings: for example, bind a custom-page dashboard instance to a
regular Settings page, not to another custom-page dashboard. This restriction
applies to declared page bindings, not generic SDK current-page operations.

## Create an instance

```sh
ntn workers customblocks make --key issueBoard --data-sources @data-sources.json --pages @pages.json --json
```

`make --target <page-or-block-id-or-url>` selects the destination. Without it,
`make` creates a private custom page. `--definition <id>` selects a definition
without a local Worker project and conflicts with `--key`. With neither selector,
`make` selects the configured Worker's sole custom block. Keep the returned URL.
`--bindings` is a deprecated alias for `--data-sources`; do not supply both.
Existing configured instances cannot switch definitions.

## Update defaults or overrides

```sh
ntn workers customblocks bind --key issueBoard --data-sources @data-sources.json --pages @pages.json --json
ntn workers customblocks bind --definition aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa --pages @pages.json --json
ntn workers customblocks bind --target bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb --data-sources @data-sources.json --json
```

`bind` and `unbind` require exactly one selector. `--key` resolves a capability
through the configured deployed Worker. `--definition` edits definition defaults.
`--target` edits an existing custom block or custom page's overrides. Direct IDs
use normal CLI auth and workspace configuration without a local Worker project.
Unlike `make --target`, binding commands never create content at a destination.

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

Use declared binding and property keys. Resolve a database ID with
`ntn datasources resolve <database-id>` before binding a data source. Never use
`ntn workers databases attach` for custom block bindings.

Omit a category to preserve it. Nonempty arrays merge by key and preserve
unmentioned keys. A same-key data-source upsert replaces its entire property map.
A null `data_source_id` or `page_id` removes that key. `[]` or a null category
clears it. Duplicate keys and removals with property maps are invalid. Both
categories are validated and committed in one request. Do not read, merge, and
replace bindings in a script.

## Remove bindings

```sh
ntn workers customblocks unbind --key issueBoard --data-source tasks --page settings --json
ntn workers customblocks unbind --target bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb --all --json
```

When the user names keys, remove only those keys with `--data-source <key>` and
`--page <key>`. Repeat each flag for more keys. Reserve all flags for an explicit
request to clear a whole category or all bindings. Use
`--all-data-sources`, `--all-pages`, or `--all` to clear categories. The two category
all flags can be combined. A category all flag conflicts with its individual
keys. `--all` conflicts with every other removal flag.

Definition unbind clears defaults. Instance unbind removes overrides and restores
inheritance from definition defaults. It never suppresses inherited bindings.
Removing an absent key is idempotent. Older `make --bindings '[]'` scripts still
clear overrides, but older nonempty arrays now merge instead of replacing lists.
Custom database view bindings remain unsupported.
