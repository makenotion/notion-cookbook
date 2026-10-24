# Sentry to PagerDuty incident tools

Find a production Sentry issue, review its latest occurrence, and declare a
prioritized PagerDuty incident from a Notion Custom Agent.

The Worker connects one configured Sentry project and environment to one
PagerDuty service. People choose issues by recognizable titles, short IDs, or
URLs; the Agent carries provider IDs between tools. No supporting Notion
database or Redis is required.

> This Worker uses shared Sentry and PagerDuty identities. Add it only to an
> Agent used by people who may read the configured Sentry project and declare
> incidents for the configured PagerDuty service.

## Try asking

- “Find unresolved checkout issues in production from the last hour.”
- “Are any payment failures regressing in production?”
- “Inspect `CHECKOUT-431` and show me where it would be routed.”
- “Declare that occurrence as SEV-1.”
- “Retry the declaration and reuse the matching incident if PagerDuty has it.”

The Agent finds and inspects the occurrence, shows any existing incident or the
configured PagerDuty destination, asks for confirmation, then declares it.

## Quickstart

You need Node.js 22+, npm 10.9.2+, access to deploy Notion Workers, a Sentry
token with `event:read`, and a PagerDuty API identity that can read services,
priorities, on-call coverage, and incidents and can create incidents.
The optional ID lookup commands below also use `curl` and `jq`.

In PagerDuty:

1. Choose the service this Worker may page. Its ID appears in the Service
   Directory URL and the Services API.
2. Enable incident priorities and record the IDs for the three priorities that
   map to SEV-1, SEV-2, and SEV-3. The List Priorities API returns both IDs and
   display names.
3. Optionally configure an Incident Workflow for incidents created on this
   service. A configured workflow may run independently; this Worker does not
   verify its execution.
4. Use a team-owned API identity whose permissions are limited to the intended
   PagerDuty scope. `PAGERDUTY_FROM_EMAIL` must be the email address of a valid
   user on the PagerDuty account.

With the PagerDuty token in your shell, these read-only calls make the required
IDs easy to copy. Use `https://api.eu.pagerduty.com` for an EU account.

```sh
curl -fsS -H "Authorization: Token token=$PAGERDUTY_API_TOKEN" \
  -H "Accept: application/vnd.pagerduty+json;version=2" \
  'https://api.pagerduty.com/services?query=Checkout&limit=100' |
  jq '.services[] | {id, name}'

curl -fsS -H "Authorization: Token token=$PAGERDUTY_API_TOKEN" \
  -H "Accept: application/vnd.pagerduty+json;version=2" \
  'https://api.pagerduty.com/priorities?limit=100' |
  jq '.priorities[] | {id, name}'
```

Deploy the Worker and configure its fixed source and destination:

```sh
npm install --global ntn
cd workers/templates/sentry-pagerduty-incident-tools
npm install
ntn login
ntn workers deploy --name sentry-pagerduty-incident-tools

ntn workers env set SENTRY_AUTH_TOKEN=your-sentry-token
ntn workers env set SENTRY_ORG_SLUG=acme
ntn workers env set SENTRY_PROJECT_SLUG=checkout-api
ntn workers env set SENTRY_ENVIRONMENT=production

ntn workers env set PAGERDUTY_API_TOKEN=your-pagerduty-token
ntn workers env set PAGERDUTY_FROM_EMAIL=incident-bot@example.com
ntn workers env set PAGERDUTY_SERVICE_ID=your-service-id
ntn workers env set \
  'PAGERDUTY_PRIORITY_IDS_JSON={"sev1":"your-p1-id","sev2":"your-p2-id","sev3":"your-p3-id"}'
```

`SENTRY_BASE_URL` can point to a Sentry regional API origin or a self-hosted
HTTPS origin. `PAGERDUTY_REGION=eu` selects PagerDuty's EU REST API.

In Notion, add the deployed Worker to a Custom Agent under **Tools and access >
Add connection**, and keep confirmation enabled for
`declareProductionIncident`.

## How it works

The Worker exposes three tools:

| Tool                        | What it does                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `searchSentryIssues`        | Returns up to 10 unresolved issues from the configured project, environment, and time window.                       |
| `inspectSentryIssue`        | Shows the exact latest occurrence, any matching incident, and the destination and priorities for a new declaration. |
| `declareProductionIncident` | Reuses a matching PagerDuty incident or validates the destination and re-reads Sentry before one creation request.  |

The Agent passes the issue and event IDs from inspection into declaration.
Search and inspection are read-only; Notion asks for confirmation before
declaration.

Before creating, the Worker looks for the same event-based PagerDuty key. A
match—even a resolved incident—returns as a no-op without depending on current
Sentry status or on-call coverage.

For a new incident, it validates the PagerDuty destination and coverage, then
rechecks the exact Sentry occurrence immediately before one creation request.
It stops if the issue resolved, the occurrence no longer matches the configured
project and environment, or too little time remains to reconcile the result.

Identical retries can reuse incidents PagerDuty returns; later occurrences get
separate keys. PagerDuty rejects duplicate keys only while a matching incident
is open, so this stateless recipe cannot guarantee exactly-once creation after
resolution or during concurrent requests.

The Agent should never choose between ambiguous search results or infer
severity from urgent language. A person selects the issue and severity.

## Authentication and safety

The Agent uses configured shared identities instead of each caller's personal
Sentry and PagerDuty permissions.

The recipe keeps that shared authority narrow:

- Sentry organization, project, and environment are fixed in configuration.
- PagerDuty service and allowed priority IDs are fixed in configuration.
- Search returns at most 10 results; outputs omit stack traces, request data,
  users, and raw provider responses.
- Text read from providers is treated as data, never as instructions.
- Declaration uses the inspected issue and event, sends at most one creation
  request, and returns `changed: false` for a matching incident or
  `changed: null` when the result cannot be confirmed.

Use a separate Agent and PagerDuty destination for restricted incident types,
such as security incidents.

## Run locally

Copy `.env.example` to `.env` and use non-customer data in a test Sentry
project. Search and inspect without changing PagerDuty:

```sh
ntn workers exec searchSentryIssues --local \
  -d '{"query":"checkout","timeRange":"1h"}'

ntn workers exec inspectSentryIssue --local \
  -d '{"issueReference":"CHECKOUT-431"}'
```

To exercise declaration, copy the opaque values returned by inspection:

```sh
ntn workers exec declareProductionIncident --local \
  -d '{"issueId":"12345","eventId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","severity":"sev1"}'
```

The last command can create a real PagerDuty incident. Use a test service with
harmless responders and workflow actions.

Offline checks require no provider credentials:

```sh
npm run check
npm test
npm run build
```

## Extend it

Possible extensions include routing several fixed Sentry projects to separate
services, a PagerDuty incident sync for browsing, and separate update or
resolution tools.

## Project map

```text
src/index.ts         Worker and tool registration
src/config.ts        Fixed Sentry and PagerDuty configuration
src/api-requests.ts  Bounded API requests, deadlines, and one-shot writes
src/sentry.ts        Issue search, reference resolution, and event inspection
src/pagerduty.ts     Service, priority, incident lookup, and creation
src/incident.ts      Inspection guards and declaration flow
```

## Learn more

- [Tools for Notion Agents](https://developers.notion.com/workers/guides/tools)
- [Sentry issue APIs](https://docs.sentry.io/api/events/)
- [Sentry short-ID resolver](https://docs.sentry.io/api/organizations/resolve-a-short-id/)
- [PagerDuty REST API schema](https://github.com/PagerDuty/api-schema/blob/main/reference/REST/openapiv3.json)
- [PagerDuty incident priorities](https://support.pagerduty.com/main/docs/incident-priority)
- [PagerDuty Incident Workflows](https://support.pagerduty.com/main/docs/incident-workflows)
- [Contribute to this cookbook](../../CONTRIBUTING.md)
