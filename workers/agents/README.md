# Canonical worker agent files

This directory is the single source of truth for the agent files that worker
templates ship in their `.agents/` directory.

Each subdirectory here mirrors the `.agents/` contents for one group of
templates:

| Directory        | Copied into                                                       |
| ---------------- | ----------------------------------------------------------------- |
| `custom-blocks/` | every recipe in `catalog.json` with `kind: "worker-custom-block"` |

## Editing agent files

1. Edit the files here — never the per-template copies under
   `workers/*/.agents/`. Those copies are generated.
2. Run `npm run agents:sync` (the pre-commit hook also runs it) to regenerate
   the per-template copies.
3. Commit the canonical change and the regenerated copies. For large changes,
   put the regenerated copies in a separate stacked PR to keep review easy.

CI runs `npm run agents:check` and fails when any per-template copy drifts from
this directory.

## Adding a template group

Add a subdirectory here, then map it to a `catalog.json` `kind` in
`scripts/sync-agents.mjs`.
