# Canonical worker agent files

This directory is the single source of truth for the agent files that worker
templates ship in their `.agents/` directory.

Every `catalog.json` recipe with a `worker-` kind gets the `default/` set. A
kind listed in `OVERRIDE_GROUPS` in `scripts/sync-agent-files.mjs` gets that
directory instead. A new kind therefore inherits the default set, rather than
being silently skipped.

| Directory        | Applies to                                 |
| ---------------- | ------------------------------------------ |
| `default/`       | every `worker-` recipe with no override    |
| `custom-blocks/` | recipes with `kind: "worker-custom-block"` |

Each template also gets an `AGENTS.md` and a `CLAUDE.md` symlink pointing at
`.agents/INSTRUCTIONS.md`, so both discovery conventions resolve to one file.

## Editing agent files

1. Edit the files here — never the per-template copies under
   `workers/*/.agents/`. Those copies are generated.
2. Run `npm run agents:sync` (the pre-commit hook also runs it) to regenerate
   the per-template copies.
3. Commit the canonical change and the regenerated copies.

The sync deletes each template's `.agents/` and copies the set back, so a
renamed or removed canonical file leaves nothing behind.

CI enforces that all worker templates have the latest versions of these files copied with no differences.

## Adding an override

Some templates need special agent instructions or skills (e.g. for an unreleased feature that is still in alpha); an override can provide an alternative set of instructions or skills.

Add a subdirectory here, then map a `catalog.json` kind to it in
`OVERRIDE_GROUPS` in `scripts/sync-agent-files.mjs`:

```js
const OVERRIDE_GROUPS = {
  "worker-custom-block": { instructions: `${CANONICAL_ROOT}/custom-blocks` },
}
```

A group is an object, not a bare path, so it can carry more than instructions
later. `DEFAULT_GROUP` has the same shape.

The sync fails when an override names a kind that no recipe uses, and when a
group has no `instructions`. Dead or malformed entries surface immediately.
