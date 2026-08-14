# Canonical worker agent files

This directory is the single source of truth for the agent files that worker
templates ship in their `.agents/` directory.

Every `catalog.json` recipe with a `worker-` kind gets the `default/` set. A
kind listed in `OVERRIDE_GROUPS` in `scripts/sync-agents.mjs` gets that
directory instead. A new kind therefore inherits the default set, rather than
being silently skipped.

| Directory        | Applies to                                 |
| ---------------- | ------------------------------------------ |
| `default/`       | every `worker-` recipe with no override    |
| `custom-blocks/` | recipes with `kind: "worker-custom-block"` |

The default set tells agents that custom blocks are a private alpha and must
not be used. Custom-block templates need the opposite, so they override it.

Each template also gets an `AGENTS.md` and a `CLAUDE.md` symlink pointing at
`.agents/INSTRUCTIONS.md`, so both discovery conventions resolve to one file.

## Editing agent files

1. Edit the files here — never the per-template copies under
   `workers/*/.agents/`. Those copies are generated.
2. Run `npm run agents:sync` (the pre-commit hook also runs it) to regenerate
   the per-template copies.
3. Commit the canonical change and the regenerated copies. For large changes,
   put the regenerated copies in a separate stacked PR to keep review easy.

CI runs `npm run agents:check` and fails when any per-template copy drifts from
this directory. The check also fails on a stale file inside a generated
subdirectory, and on a missing or wrong entry symlink.

## Adding an override

Add a subdirectory here, then map a `catalog.json` kind to it in
`OVERRIDE_GROUPS` in `scripts/sync-agents.mjs`. The sync fails when an override
names a kind that no recipe uses, so dead entries surface immediately.
