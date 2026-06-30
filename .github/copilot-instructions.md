# GitHub Copilot instructions

Follow the repository-wide instructions in [`AGENTS.md`](../AGENTS.md). They are
the canonical source for project layout, recipe selection, implementation,
safety, and validation.

Before changing code:

1. Use [`catalog.json`](../catalog.json) to select the closest runnable recipe.
2. Read that project's README, `package.json`, and catalog entrypoints.
3. Work from its directory and use only its declared commands.

The current layout is flat:

- `examples/<task>/` contains local Notion API examples.
- `workers/<integration>-<capability>/` contains Worker syncs, agent tools, and
  webhooks.
- `skills/` and `docs/` are not runnable catalog recipes.

Keep projects self-contained, update their documentation and catalog metadata
with behavior changes, prefer offline verification before live calls, and
never commit credentials, `.env`, dependency/build output, or generated Worker
state. Run the changed project's checks before finishing. On a fresh checkout,
run `npm install` and then root `npm run verify:all`.
