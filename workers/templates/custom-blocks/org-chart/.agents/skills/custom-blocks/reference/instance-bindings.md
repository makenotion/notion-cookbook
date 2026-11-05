# Instance bindings

Use this reference when preparing `make --bindings` input, configuring an instance
through the REST API, or updating existing bindings.

## Binding array

Write `bindings.json` as an array:

```json
[
  {
    "key": "issues",
    "data_source_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "property_ids_by_key": { "title": "title" }
  }
]
```

Replace the example ID and mappings with values from the target data source's
schema. Match the definition's declared data source and property keys. Do not use
property names as IDs or invent a mapping. Pass schema property IDs unchanged.
The API resolves encoding and rejects unknown IDs or incompatible declared types.

Binding arrays replace the stored overrides. Include every binding that must
remain. An empty instance array clears overrides so definition defaults apply.

## Set definition defaults

To share bindings across instances, put the binding array in a top-level
`data_sources` field in `defaults.json`, then update the definition:

```shell
ntn api v1/custom_block_definitions/<definition-id> -X PATCH -d @defaults.json
```

This replaces all definition defaults and affects instances that inherit them.
Use instance bindings when configuring only one placement.

## Configure through the API

If `make --help` does not list `--bindings`, create or select the instance without
that flag, then configure the returned instance ID through `ntn api`. Use the same
requests for later binding edits. Manual UI connection is not required when the
API can complete the configuration.

For an inline block, put the binding array inside `custom_block.data_sources` in
`update.json`:

```json
{
  "custom_block": {
    "data_sources": [
      {
        "key": "issues",
        "data_source_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "property_ids_by_key": { "title": "title" }
      }
    ]
  }
}
```

```shell
ntn api v1/blocks/<instance-id> -X PATCH -d @update.json
```

For a custom page, use `custom_page` instead of `custom_block` in the file and
`v1/pages/<instance-id>` as the endpoint. Omit `definition_id` for a bindings-only
edit. A different definition cannot replace the instance's existing definition.

## Legacy property IDs

Legacy saved mappings may contain percent-encoded property IDs. The host resolves
these IDs without rewriting stored bindings. Do not decode an ID just because it
contains `%`.
