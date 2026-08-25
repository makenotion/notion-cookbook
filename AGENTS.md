# Agent instructions

This is the canonical repository guide for coding agents. Tool-specific files
should point here instead of restating these rules.

## Repository map

| Path                                            | Purpose                                                                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `catalog.json`                                  | Machine-readable index of every runnable recipe, including paths, entrypoints, integrations, and supported commands. |
| `examples/<task>/`                              | Self-contained TypeScript programs that call the Notion API and run locally with Node.js.                            |
| `apps/templates/<name>/`                        | Self-contained workflow Apps built with the `@notionhq/apps` SDK.                                                    |
| `workers/templates/<integration>-<capability>/` | Self-contained Notion Worker syncs, agent tools, and webhooks.                                                       |
| `skills/`                                       | Reusable instructions and evaluations for AI-assisted Notion workflows.                                              |
| `docs/`                                         | Longer developer guides that are not standalone runnable projects.                                                   |
| `scripts/`                                      | Repository-wide installation, validation, and maintenance commands.                                                  |

Do not infer a recipe's category from a path segment that no longer exists.
`examples/`, `apps/templates/`, and `workers/templates/` are flat collections;
`kind` in `catalog.json` is the authoritative classification.

## Find the right recipe

1. Translate the request into an outcome, integration, and recipe kind.
2. Search `catalog.json` before scanning the tree. For example:

   ```sh
   jq '.recipes[] | select(.integrations | index("linear"))' catalog.json
   jq '.recipes[] | select(.kind == "worker-tool") | {id, summary, path}' catalog.json
   ```

3. Read the selected recipe's README, `package.json`, and listed entrypoints.
4. Check nearby recipes only when they demonstrate a pattern the selected
   project does not cover.

Prefer the narrowest working recipe. For example, adapt `linear-sync` for a new
Linear field; do not start from a generic Worker if the integration already has
an implemented sync.

## Run a recipe

Recipes are independent projects. Run commands from the recipe directory and
install dependencies there. Never assume every project uses `npm start` or has
the same environment variables.

1. Use the commands declared for the recipe in `catalog.json`.
2. Read its README before creating `.env` or configuring an external service.
3. Copy the provided environment template when present. Never commit `.env`,
   tokens, service credentials, or generated Worker state.
4. Prefer offline checks before commands that call live APIs, mutate a Notion
   workspace, or deploy a Worker.
5. State clearly when a live check was not run because credentials or external
   access were unavailable.

For Workers, Node.js 22 and npm 10.9.2 or newer are required. Authenticate and
deploy only when the user asks for a live deployment. Treat generated
`workers.json` files as local state unless a tracked fixture explicitly says
otherwise.

For Apps, Node.js 26 or newer is required. Apps currently support workflow
capabilities only. Treat `.notion/` and `dist/` as generated local state, and
enable the `apps` experiment before using `ntn apps deploy`.

## Adapt an existing recipe

- Preserve the recipe's standalone install and run flow.
- Keep the change inside one recipe unless shared documentation or repository
  tooling genuinely needs to change.
- Keep Apps workflow-only and import from `@notionhq/apps` rather than the
  legacy `@notionhq/workers/alpha` paths.
- Follow the existing registration and data-flow patterns in `src/index.ts` or
  the listed entrypoint.
- Document new prerequisites, environment variables, external permissions,
  expected output, and extension points.
- Update or add offline tests for transforms, pagination, validation, signature
  handling, or query safety before relying on a live integration test.
- If behavior, entrypoints, integrations, or commands change, update the
  matching `catalog.json` entry in the same change.

Worker-specific safety rules:

- Sync records need deterministic keys and pagination that cannot silently skip
  records. Document replace versus incremental behavior.
- Agent-facing query tools must enforce read-only access, bound result sizes,
  and explain the real security boundary; a prompt instruction is not one.
- Webhooks must authenticate deliveries and defend against replay where the
  provider supports timestamps or delivery IDs.
- Use the Notion client supplied by the Worker context when the platform owns
  authentication. Do not introduce a Notion token unnecessarily.

## Add a recipe

Choose one project root:

- `examples/<task-name>/` for a local Notion API/SDK program.
- `apps/templates/<name>/` for a workflow App.
- `workers/templates/<integration>-<capability>/` for a deployed Worker. Put the
  integration first so related projects sort together, such as
  `zendesk-sync` and `zendesk-webhook`.

Every new recipe must include:

- A unique package name and a `package.json` with accurate scripts and engine
  requirements.
- A README covering the outcome, when to use it, prerequisites, setup, exact
  run or deploy commands, expected result, code map, extension points, and
  verification.
- A clear TypeScript entrypoint and `tsconfig.json`.
- `.env.example` when configuration is required, containing names and safe
  placeholders only.
- Deterministic offline checks for meaningful logic. New Workers should expose
  `build`, `check`, and `test` scripts.
- One complete `catalog.json` entry and links from the appropriate landing page
  and root README.

Do not add placeholder projects or catalog entries. Add a recipe only when its
code, setup instructions, and checks are runnable.

App-specific rules:

- Apps require Node.js 26 or newer and depend on `@notionhq/apps`.
- Put each workflow in a direct `src/workflows/*.ts` file that default-exports
  `createWorkflow(...)`; the filename becomes the workflow key.
- Use typed trigger creators from `@notionhq/apps/triggers`.
- Put non-deterministic work and external effects in awaited
  `context.step(...)` calls with stable names and idempotent writes.
- New Apps should expose `build` and `check` scripts.

## Validate changes

Use proportional validation and report exactly what ran.

For an API example:

```sh
cd examples/<task>
npm install
npx tsc --noEmit
# Run the catalog's `run` command only when its required configuration is safe.
```

For a Worker:

```sh
cd workers/templates/<integration>-<capability>
npm install
npm run check
npm test
npm run build
```

For an App:

```sh
cd apps/templates/<name>
npm install
npm run check
npm run build
```

Run only scripts that exist in that project's `package.json`. Then, from the
repository root, install the repository tooling and run:

```sh
npm install
npm run verify:all
```

Before finishing, confirm that:

- Documentation links and commands use the current flat paths.
- `catalog.json` matches every package-backed direct child of `examples/`,
  `apps/templates/`, and `workers/templates/`, with no placeholder entries.
- No secrets, build output, dependency directories, or local Worker state were
  added.
- A recipe README still describes the behavior implemented by its entrypoint.

## Documentation and skills

For documentation-only changes, validate links and run the root Markdown and
format checks. For skill changes, read [`skills/README.md`](skills/README.md)
and the provider-specific guide first; update evaluations when behavior
changes. Do not treat a skill as a runnable cookbook recipe or add it to
`catalog.json`.
