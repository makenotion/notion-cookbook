# Contributing

Thanks for contributing to the Notion cookbook. Runnable projects should be
easy for a person or coding agent to discover, install, understand, adapt, and
verify without relying on another project in this repository.

## Choose the right destination

- Add a local Notion API or SDK program at `examples/<task-name>/`.
- Add a deployed Notion Worker at
  `workers/<integration>-<capability>/`, such as `linear-sync`,
  `snowflake-query`, or `zendesk-webhook`.
- Add reusable AI workflows under the appropriate provider in `skills/`.
- Add longer conceptual or integration guides to `docs/`.

Keep runnable project roots flat. Language, runtime, integration, and Worker
kind belong in `catalog.json`; they do not need extra directory levels.

## Recipe contract

Every API example or Worker must be self-contained and include:

- `README.md` with prerequisites, setup, exact commands, expected result, code
  map, extension points, and verification instructions.
- `package.json` with a unique package name, accurate engine requirements, and
  scripts that work from that project directory.
- A clear TypeScript entrypoint and `tsconfig.json`.
- `.env.example` when configuration is required. Include variable names and
  safe placeholders only.
- Offline tests or checks for meaningful transformation, pagination,
  validation, authentication, or safety logic.
- A complete entry in the root `catalog.json`.
- Direct links from the relevant landing page (`examples/README.md` or
  `workers/README.md`) and the root `README.md`.

Recipes should be working, focused, and documented. Do not commit placeholder
directories, secrets, `.env` files, `node_modules`, build output, or generated
Worker state.

## Adding an API example

Create `examples/<task-name>/`. Name it for the user outcome rather than its
language or implementation detail.

At minimum, provide an install command, a documented run script, and a way to
type-check the project. Explain which Notion objects the user must share with
their integration and which API capabilities the example needs. If running the
example mutates a workspace, describe the expected changes before the command.

Use the official `@notionhq/client` when a JavaScript SDK is appropriate. Keep
the example independent so a user can copy its directory into another project.

## Adding a Worker

Create `workers/<integration>-<capability>/`, with the integration or domain
first so related capabilities sort together. Use one of these catalog kinds:

- `worker-sync` for an external-data sync into a managed Notion database.
- `worker-tool` for a capability callable by a Notion agent.
- `worker-webhook` for an externally triggered event handler.

New Workers should:

- Require Node.js 22 and npm 10.9.2 or newer.
- Declare `build`, `check`, and `test` scripts.
- Depend on `@notionhq/workers` and register capabilities from `src/index.ts`.
- Include deterministic offline tests that do not require production
  credentials.
- Document `ntn login`, the exact deploy command, every `ntn workers env set`
  value, and any manual setup in Notion or the external service.
- Explain how to connect an agent tool, trigger a sync, or configure a webhook
  after deployment.

Additional expectations by kind:

- **Syncs:** use stable record keys, handle pagination, document schedules and
  replace versus incremental behavior, and explain schema extension points.
- **Agent tools:** validate inputs, bound results and resource use, and enforce
  the promised security boundary in code. Database query tools must be
  read-only.
- **Webhooks:** verify the provider's signature or token, add replay protection
  where possible, and test malformed and unauthenticated deliveries.

Use the pre-authenticated Notion client supplied by the Worker context when the
platform owns authentication. Do not ask users for a separate Notion token
unless the implementation genuinely requires one.

## Catalog entry

Add one object to `catalog.json` with the project directory name as `id`. Keep
the summary outcome-oriented and list only commands that the project actually
supports.

Required fields are:

- `id`, `title`, `summary`, and `path`.
- `kind`: `api-example`, `worker-sync`, `worker-tool`, or `worker-webhook`.
- `status`, `language`, and `runtime`.
- Lowercase integration slugs and project-relative entrypoints.
- `commands.install` plus supported run, check, test, build, or deploy commands.

The catalog contains runnable package-backed projects only. Unimplemented
ideas, skills, and documentation do not belong in it.

## Documentation and skills

For Markdown:

- Use sentence case for headings.
- Prefer direct, task-oriented language.
- Keep commands copyable and links relative when they point within this
  repository.
- Update paths wherever a moved or renamed project is referenced.

For a skill contribution, follow [`skills/README.md`](skills/README.md) and the
provider-specific guide. Include or update evaluations whenever skill behavior
changes.

## Validate your change

From the changed project directory, install dependencies and use its declared
commands. For a new Worker, the baseline is:

```sh
npm install
npm run check
npm test
npm run build
```

For an API example without dedicated check and test scripts, run at least:

```sh
npm install
npx tsc --noEmit
```

Run a live API command or Worker deployment only with an appropriate test
workspace and credentials. Never expose secrets in output, fixtures, or a pull
request.

Finally, from the repository root install the repository tooling and run:

```sh
npm install
npm run verify:all
```

In the pull request, list the commands you ran and any live checks you did not
run.

## Pull request process

1. Create a focused branch with a descriptive name.
2. Keep the change to one recipe or one coherent repository improvement.
3. Verify the project, catalog, documentation links, and root checks.
4. Open a pull request that explains the use case, implementation, expected
   result, and test evidence.
5. Respond to review feedback and keep documentation aligned with code.

For questions, open an issue or ask in the
[Notion Developers Slack](https://join.slack.com/t/notiondevs/shared_invite/zt-20b5996xv-DzJdLiympy6jP0GGzu3AMg).
