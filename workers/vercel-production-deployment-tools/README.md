# Worker tool: Vercel production deployment tools

Inspect a Vercel release from a Notion Agent, then promote a staged Production
deployment or run Instant Rollback. The worker reads the target, current
deployment, domains, Git SHA, and Deployment Checks directly from Vercel before
it asks to change traffic. No supporting Notion database is required.

## Quickstart

You need Node.js 22+, npm 10.9.2+, the Vercel CLI, access to deploy Notion
Workers, and a Vercel project that uses staged Production deployments. Create a
team-scoped Vercel token whose principal can access the project and has **Full
Production Deployment** permission.

Create a staged candidate with `vercel deploy --prod --skip-domain`. The command
prints its URL; run `vercel inspect <deployment-url>` and copy the `dpl_` ID for
the inspection tool.

From the repository root:

```sh
npm install --global ntn vercel
cd workers/vercel-production-deployment-tools
npm install
ntn login
ntn workers deploy --name vercel-production-deployment-tools
ntn workers env set VERCEL_ACCESS_TOKEN=your-vercel-token
ntn workers env set VERCEL_TEAM_ID=team_your_team
ntn workers env set VERCEL_PROJECT_ID=prj_your_project
```

Run `vercel link` in the Vercel project to find `orgId` and `projectId` in
`.vercel/project.json`. In Notion, add the deployed worker to a custom agent
under **Tools and access > Add connection**. Limit access to people who are
allowed to operate this Vercel project, and keep confirmation enabled for the
two write tools. Confirmation records user intent; the agent's access and the
Vercel token's permissions determine what the worker can actually change.

## Try asking

- "Inspect `dpl_...` and tell me whether it is ready to promote."
- "Promote the staged Production deployment we just inspected."
- "Inspect `dpl_...` as an Instant Rollback target."
- "Roll back to the inspected deployment."

The agent uses three tools:

- `inspectProductionChange` reads live Vercel state and returns the exact target,
  current deployment, Git SHA, Production domains, Deployment Check result, and
  rollback warning.
- `promoteStagedProductionDeployment` promotes one `READY/STAGED` Production
  deployment without rebuilding it.
- `rollbackProductionDeployment` points Production back to an eligible deployment
  that served Production before.

The agent should always inspect first, summarize what will change, and copy the
returned target, current deployment, and Git SHA into the write tool. Notion
treats the last two tools as write operations and asks for confirmation by
default.

## How it works

1. The inspection tool reads the configured project, target deployment, current
   direct-serving Production domains, and provider-reported check state.
2. It confirms the target belongs to the configured team and project. Promotion
   requires `READY/STAGED`; rollback requires `READY/PROMOTED`.
3. The write tool compares the live current deployment and optional Git SHA with
   the values returned by inspection, then repeats the mutable checks immediately
   before sending one Vercel request.
4. After Vercel accepts the request, the worker waits briefly for every Production
   domain to point to the target. A target that is already live returns `no_op`.
5. Optional application health checks run against the target before the request
   and against Production after traffic moves.

Team and project are fixed in worker configuration. Production domains and
Deployment Check results come from Vercel, so adding a domain or changing checks
does not require duplicating that configuration in Notion. This basic recipe
supports up to 100 direct Production domains.

## Vercel behavior to know

- This recipe promotes staged **Production** deployments. Promoting Preview to
  Production is a different Vercel workflow that can rebuild with Production
  configuration.
- Vercel Deployment Checks are the release gate. When Vercel reports a check
  result that has not succeeded, promotion stops.
- Promotion stops when Rolling Releases are configured because that lifecycle
  uses Vercel's dedicated start and complete APIs. Instant Rollback remains
  available for an eligible target and can stop an active rollout.
- Instant Rollback reuses an older build. Later environment-variable changes are
  not applied, cron configuration can be restored from that build, and Vercel
  pauses automatic Production-domain assignment until a later promotion. Hobby
  plans can restore only the immediately previous Production deployment; Pro and
  Enterprise plans can select older eligible deployments.

The promotion and rollback endpoints do not expose a documented idempotency key
or atomic expected-current condition. The worker therefore sends at most one
traffic request per invocation. If the response is lost or Production does not
converge quickly, it returns `ambiguous`; inspect live state before considering
another write request.

## Optional health checks

Health checks are off by default. To enable them, configure up to three paths
that return a direct 2xx response. To keep request fan-out bounded, this option
supports projects with up to ten direct Production domains.

```sh
ntn workers env set 'VERCEL_HEALTH_PATHS_JSON=["/healthz"]'
```

If Deployment Protection covers the generated deployment URL, add its automation
bypass secret:

```sh
ntn workers env set VERCEL_PROTECTION_BYPASS_SECRET=your-bypass-secret
```

The bypass secret is sent only to the generated Vercel deployment hostname, not
to custom Production domains.

## Adapt it

- Add organization-specific checks before `requestTransition` when your release
  process has another source of truth.
- Add durable coordination only if callers can issue concurrent writes or need
  stronger guarantees than one request per tool invocation.

## Project structure

```text
src/
  index.ts    — defines the agent tools and their input and output schemas
  release.ts  — checks, performs, and verifies Production changes
  vercel.ts   — calls Vercel and validates its responses
  config.ts   — reads configuration and safety limits
  types.ts    — shared data contracts and errors
```

## Run locally

Copy `.env.example` to `.env`, add a token for a disposable Vercel project, then
inspect a deployment without changing traffic:

```sh
ntn workers exec inspectProductionChange --local \
  -d '{"action":"promote","targetDeploymentId":"dpl_..."}'
```

Offline checks do not need Vercel credentials:

```sh
npm run check
npm test
npm run build
```

## Learn more

- [Notion Workers agent tools](https://developers.notion.com/workers/guides/tools)
- [Vercel deployment promotion](https://vercel.com/docs/deployments/promoting-a-deployment)
- [Vercel Instant Rollback](https://vercel.com/docs/instant-rollback)
- [Vercel Deployment Checks](https://vercel.com/docs/deployment-checks)
- [Vercel Rolling Releases](https://vercel.com/docs/rolling-releases)
- [Vercel access roles](https://vercel.com/docs/rbac/access-roles)
- [Contribute to this cookbook](../../CONTRIBUTING.md)
