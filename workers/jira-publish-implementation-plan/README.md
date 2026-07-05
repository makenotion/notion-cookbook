# Publish a Notion implementation plan to Jira

Turn a reviewed Notion implementation plan into one Jira epic and a bounded set
of child work items. A Notion Agent resolves current Jira choices, shows an
exact preview, publishes only after confirmation, and can inspect the result.

## Try asking

- “Is this implementation plan ready for Jira? Flag missing owners, unclear
  deliverables, and circular blockers. Don’t publish anything.”
- “Turn this plan into one epic and child stories. Preserve owners, estimates,
  acceptance criteria, and blockers, then show me the exact Jira preview.”
- “Prepare this checkout migration for Jira. Assign API work to Priya and show
  me choices if Jira has more than one matching person.”
- “Publish the exact Jira plan we just reviewed.”
- “The Jira publish timed out. Check what exists for this page before creating
  anything else.”
- “Show me the Jira work created from this page, grouped under its epic.”

The Agent should read and understand the Notion page. The Worker validates the
structured plan supplied by the Agent against live Jira metadata; it does not
semantically parse the page itself.

## Quickstart

You need:

- Node.js 22 and npm 10.9.2 or newer;
- the [Notion CLI](https://developers.notion.com/docs/workers);
- one Jira Cloud project;
- a dedicated Jira account and API token.

Give the Jira account only the project permissions it needs: browse the
project, create work items, link work items, and assign work when owners are
used. User lookup may require Jira's browse-users permission.

Use a scoped Jira API token and the Atlassian Cloud ID for the configured site.

Deploy the Worker:

```zsh
npm install --global ntn
cd workers/jira-publish-implementation-plan
npm install
ntn login
ntn workers deploy --name jira-publish-implementation-plan

ntn workers env set JIRA_CLOUD_ID=00000000-0000-0000-0000-000000000000
ntn workers env set JIRA_SITE_URL=https://example.atlassian.net
ntn workers env set JIRA_EMAIL=jira-automation@example.com
ntn workers env set JIRA_API_TOKEN=...
ntn workers env set JIRA_PROJECT_ID=10000
ntn workers env set JIRA_PROJECT_KEY=ENG
ntn workers env set JIRA_BLOCKS_LINK_TYPE_ID=10000
```

Set `JIRA_ESTIMATE_FIELD_ID` to a numeric Jira custom field only when the plan
should include estimates.

In Notion, add the deployed Worker to a Custom Agent under **Tools and access →
Add connection** and enable all three tools.

## Tools

| Tool              | Purpose                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `prepareJiraPlan` | Resolve readable Jira names, validate the bounded graph, inspect existing markers, and preview. |
| `publishJiraPlan` | Revalidate and create the exact prepared epic, children, and dependency links.                  |
| `inspectJiraPlan` | Read the Jira work associated with one Notion page for verification or recovery.                |

Only `publishJiraPlan` writes to Jira. None of the tools writes to Notion.

Preparation accepts names such as `Epic`, `Story`, `Priya Shah`, and `Q3
Launch`. It returns immutable Jira IDs inside the prepared plan. Missing or
ambiguous Jira values return at most five candidates. Assignees always require
an explicit candidate choice because Jira's assignable-user search cannot prove
that a display name is unique. The Agent re-runs preparation with the returned
candidate ID; the user never has to find or type an opaque Jira ID.

## How it works

1. The Agent reads the Notion page and proposes one epic, direct child work
   items, and any `blocks` relationships.
2. `prepareJiraPlan` checks the current Notion page-object edit time and current
   Jira project, issue types, create fields, people, fix versions, and link
   direction. It performs no writes.
3. The Agent shows the destination, issue count, hierarchy, summaries,
   requested owners, estimates, dependencies, warnings, and items without a
   requested owner.
4. After the user explicitly confirms that preview, `publishJiraPlan`
   revalidates it and creates the epic, children, and links in that order.
5. Each Jira item receives a visible Notion backlink, a deterministic source
   label, and a small Jira issue property used for exact readback.
6. `inspectJiraPlan` reads those markers to report the observed Jira graph.

The Notion `last_edited_time` is a useful stale-page guard, not a transaction
lock or a proof that every descendant block is unchanged. The Agent remains
responsible for showing the prepared graph and receiving confirmation.

Null optional values mean “do not request this field.” Jira may apply a project
default, such as automatic assignment. The preview distinguishes requested
values from omitted ones; it does not claim that omitted fields will be empty.

## Supported plan

- one configured Jira Cloud site and project per deployment;
- one Notion source page;
- one epic and 1–10 direct stories or tasks;
- 0–10 acyclic `blocks` relationships among child items;
- summary, description, acceptance criteria, assignee, up to five labels,
  optional estimate, and optional selectable fix version;
- current epic-level and standard-level Jira issue types only.

This recipe handles initial publication. It does not create subtasks, span
projects, transition work, comment, attach files, delete work, or synchronize
later plan changes into existing Jira items. It accepts no arbitrary Jira URL,
JQL, REST method, headers, or field object.

## Confirmation, authority, and recovery

Confirmation is a user-experience safeguard, not provider authorization. The
configured Jira account is the acting identity. Every person who can invoke
this Worker can exercise that account's permissions in the configured project,
so attach it only to an Agent whose audience is authorized to create that work.

Creating Jira work may trigger normal Jira notifications and automation. Jira's
create endpoint does not provide a per-request notification suppression option.

This Worker is intentionally stateless and does not claim exactly-once
publication:

- a changed Notion page-object edit time, required Jira capability, or
  dependency-link meaning stops before writes and requires a new preview;
- exact existing markers produce a no-op instead of an intentional duplicate;
- definite partial results identify created, existing, rejected, and
  not-attempted work;
- an uncertain Jira response returns `status: "ambiguous"` and `changed: null`,
  then stops all later writes;
- after an uncertain response, call `inspectJiraPlan` and do not blindly repeat
  publication;
- Jira's enhanced search can lag, so `not_observed` is not proof that a timed-out
  create failed;
- concurrent publication of the same page is unsupported;
- the Worker never deletes Jira work to compensate for a partial result.

Jira labels and issue properties are inspection markers, not an authorization
boundary. The fixed project and the Jira account's permissions are the real
provider boundary.

## Run locally

Offline checks need no Jira or Notion credentials:

```zsh
npm run format:check
npm run check
npm test
npm run build
```

Use a disposable Jira project for live testing. Run preparation first and
review the preview carefully: publication creates real Jira work and may run
project automation.

## Project structure

```text
src/
  index.ts   — tool contracts and compact result mapping
  config.ts  — fixed Jira project and credential configuration
  types.ts   — plan and result types
  plan.ts    — bounds, graph validation, ordering, and plan versions
  notion.ts  — retrieve-only source-page stale guard
  jira.ts    — bounded Jira discovery, inspection, writes, and readback

test/
  worker-contract.test.ts
  config-plan.test.ts
  notion.test.ts
  jira.test.ts
```

## Adapt it

- Add one Jira field at a time, including live metadata validation, bounded
  inputs, create handling, readback, and offline tests.
- Lower the item or dependency limits for stricter environments.
- Use caller-bound Jira OAuth before exposing the Worker to people who do not
  already share the service account's authority.

For ongoing Jira visibility and field synchronization, use
[Notion's Jira connection](https://www.notion.com/help/jira). For general Jira
search, editing, transitions, or one-off creation, use Jira directly or the
[Atlassian Rovo MCP server](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/).

## Learn more

- [Notion Workers](https://developers.notion.com/docs/workers)
- [Jira issue APIs](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/)
- [Jira issue links](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-links/)
- [Contribute to this cookbook](../../CONTRIBUTING.md)
