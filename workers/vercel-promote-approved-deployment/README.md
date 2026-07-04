# Worker tool: Vercel release approvals

**TL;DR:** Let a Notion Agent promote or roll back one Vercel project after a
person approves the exact deployment in Notion. The worker checks the deployment,
Git SHA, production domains, Deployment Checks, rolling-release state, and health
endpoints before changing traffic.

Use this recipe for a straightforward release workflow that your team can adapt.
It keeps the decision and outcome together in Notion and uses live Vercel state
plus a page receipt to avoid repeating ordinary requests. It does not need a
separate database or coordination service.

## Quickstart

You need Node.js 22, npm 10.9.2 or newer, access to deploy Notion Workers, and a
Vercel project that uses staged production deployments. Create a dedicated
Vercel access token scoped to the team that owns the project.

1. Create a Notion database using the [approval schema](#approval-database).
   Share it with the people who can approve releases, and copy its data source or
   database ID.

2. From the repository root, install the worker and deploy it:

   ```sh
   npm install --global ntn
   cd workers/vercel-promote-approved-deployment
   npm install
   ntn login
   ntn workers deploy --name vercel-promote-approved-deployment
   ```

3. Add credentials and the fixed project policy. JSON values must remain quoted
   so your shell passes them as one value.

   ```sh
   ntn workers env set VERCEL_ACCESS_TOKEN=your-vercel-token
   ntn workers env set VERCEL_TEAM_ID=team_your_team
   ntn workers env set VERCEL_PROJECT_ID=prj_your_project
   ntn workers env set NOTION_VERCEL_APPROVAL_PARENT_ID=your-notion-data-source-id
   ntn workers env set 'VERCEL_PRODUCTION_DOMAINS_JSON=["app.example.com"]'
   ntn workers env set 'VERCEL_DEPLOYMENT_CHECK_IDS_JSON=["check_tests"]'
   ntn workers env set 'VERCEL_HEALTH_PATHS_JSON=["/healthz"]'
   ```

   If Deployment Protection applies to the deployment health URL, also set
   `VERCEL_PROTECTION_BYPASS_SECRET`.

4. In Notion, add the deployed worker to a Custom Agent under
   **Tools and access > Add connection**. Give the agent access to the approval
   database.

Create an approval row, set **Approval status** to `Approved`, and ask the agent
to run it.

## Try asking

- “Promote the deployment approved on this page.”
- “Check this release approval and promote it if every check passes.”
- “Roll back using the approved deployment on this page.”

The agent chooses `promoteApprovedDeployment` or `rollbackApprovedDeployment`
from the page's **Action** property. Each tool accepts only the approval page ID;
release details come from the page and fixed worker configuration.

## How it works

1. The worker reads the approval through the Notion client supplied by the
   Worker context and confirms that the page belongs to the configured database.
2. It checks that the page is approved for the selected action and matches the
   configured Vercel team and project.
3. It verifies the target deployment, Git SHA, current production deployment,
   exact production-domain set, rolling-release state, and configured Deployment
   Checks. The target's fixed health paths must pass before promotion or rollback.
4. Immediately before the Vercel request, it repeats the mutable Notion and
   Vercel checks and writes a canonical `request_started` receipt to the page.
5. It changes traffic with Vercel's documented promotion or rollback endpoint,
   then reads the project again. Every configured production domain must point to
   the target and pass the fixed health paths before the receipt is completed.
6. A later call with the same approval reconciles the receipt with live Vercel
   state and does not blindly send the request again.

Promotion and rollback share this flow in `src/transition.ts`. The action-specific
code is limited to target validation and the Vercel endpoint.

## Approval database

Property names are case-sensitive.

| Property                       | Type      | Value                                      |
| ------------------------------ | --------- | ------------------------------------------ |
| Approval status                | Status    | `Approved` when ready                      |
| Action                         | Select    | `Promote` or `Rollback`                    |
| Approval revision              | Rich text | A short release or rollback revision       |
| Vercel team ID                 | Rich text | Must match `VERCEL_TEAM_ID`                |
| Vercel project ID              | Rich text | Must match `VERCEL_PROJECT_ID`             |
| Target deployment ID           | Rich text | Exact `dpl_...` deployment to serve        |
| Expected current deployment ID | Rich text | Deployment expected to own production now  |
| Git SHA                        | Rich text | Full lowercase SHA expected on the target  |
| Worker receipt                 | Rich text | Leave empty; the worker owns this property |

For a rollback, the target should be a previously promoted deployment. Vercel
restores that existing build without rebuilding it, so later environment-variable
changes are not applied to the restored deployment.

## Safety boundaries

- The configured Notion database and its sharing permissions decide which pages
  can authorize a release. A page elsewhere in the workspace is rejected.
- Team, project, production domains, Deployment Check IDs, and health paths are
  fixed in worker configuration rather than accepted from an agent call.
- Rolling Releases are intentionally unsupported. The worker stops if they are
  configured or active, because their traffic lifecycle differs from a basic
  promotion.
- Redirects are never followed for Vercel API or health requests. Provider
  response sizes, collection sizes, retries, and timeouts are bounded.
- The worker rechecks Vercel immediately before each request. Another dashboard,
  CLI, or API call can still change production at the same time.

The Notion receipt stops the same approval from sending another request after a
call finishes. It cannot stop two calls that start at the same time, so this basic
recipe has three operating requirements:

- Use one approval page for each exact current-to-target transition.
- Never clear or edit **Worker receipt**.
- Do not invoke a transition concurrently or create a replacement approval while
  a `request_started` receipt is unresolved.

If your release automation needs parallel callers, wrap
`executeApprovedTransition` with a shared lock or job queue. The rest of the
recipe does not need to change.

## Results

Both tools return the same compact result:

- `completed`: the target owns every configured production domain and health
  checks passed.
- `no_op`: the target was already live, or a recorded request was reconciled
  without another traffic request.
- `blocked`: approval, configuration, identity, check, health, or rolling-release
  validation failed before a safe transition.
- `conflict`: production points to an unexpected or split set of deployments.
- `ambiguous`: a request may have been sent, but the target was not confirmed.

`nextStep` explains whether to correct the approval, inspect Vercel, or create a
new approval. The worker never automatically repeats an ambiguous request.

## Adapt it

The implementation keeps provider access, approval parsing, and the shared
release flow separate:

```text
src/
  index.ts       — registers the two agent tools
  transition.ts  — shared approval, preflight, request, and reconciliation flow
  notion.ts      — approval parsing and canonical receipt write/readback
  vercel.ts      — bounded Vercel REST API and health checks
  config.ts      — one-project policy and environment validation
  types.ts       — compact shared contracts
test/
  transition.test.ts  — offline workflow and replay tests
  vercel.test.ts      — offline HTTP boundary tests
```

Useful extension points are:

- Add organization-specific preflight checks in `verifyPreconditions`.
- Add another notification or audit sink after a completed receipt.
- Wrap `executeApprovedTransition` with durable coordination for concurrent calls.
- Deploy another worker instance for a second project, or replace the single
  project config with an allowlist when that complexity is genuinely needed.

Keep fixed policy on the server and continue rereading approval and provider
state immediately before any new mutation.

## Verify locally

Offline checks do not need Notion or Vercel credentials:

```sh
npm run check
npm test
npm run build
```

For a live check, create a disposable staged deployment and approval. Confirm the
result in both the Notion receipt and Vercel project before using the worker for a
production release.

## Learn more

- [Notion Workers](https://developers.notion.com/docs/workers)
- [Using the Notion API from a Worker](https://developers.notion.com/workers/guides/api-client)
- [Vercel promotion](https://vercel.com/docs/deployments/promoting-a-deployment)
- [Vercel rollback](https://vercel.com/docs/deployments/rollback-production-deployment)
- [Vercel REST API](https://vercel.com/docs/rest-api)
