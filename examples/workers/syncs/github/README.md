# Worker sync: GitHub

Syncs GitHub issues and pull requests from one or more repositories into
Notion databases that stay up to date automatically. Once deployed, the worker
creates three databases covering issues, all pull requests, and a focused view
of open PRs with review and CI status.

You don't need to create the Notion databases yourself. The worker declares the
schemas and Notion creates and manages each database for you (these are called
"managed databases").

## What you get

| Database | GitHub resource | Schedule |
| --- | --- | --- |
| **GitHub Issues** | Issues | Every 5 min |
| **GitHub Pull Requests** | Pull Requests (all states) | Every 5 min |
| **GitHub Open PRs** | Open PRs + reviews + CI | Every 2 min |

### GitHub Issues

| Notion property | GitHub field | Type |
| --- | --- | --- |
| Title | `title` | title |
| Issue Key | `owner/repo#number` | richText |
| Issue Link | `html_url` | url |
| State | `state` | select |
| State Reason | `state_reason` | select |
| Author | `user.login` | richText |
| Assignees | `assignees[].login` | multiSelect |
| Labels | `labels[].name` | multiSelect |
| Milestone | `milestone.title` | richText |
| Comments | `comments` | number |
| Reactions | `reactions.total_count` | number |
| Repository | `owner/repo` | richText |
| Created | `created_at` | date |
| Updated | `updated_at` | date |
| Closed | `closed_at` | date |

Each page body contains the issue body (markdown).

### GitHub Pull Requests (all states)

| Notion property | GitHub field | Type |
| --- | --- | --- |
| Title | `title` | title |
| PR Key | `owner/repo#number` | richText |
| PR Link | `html_url` | url |
| State | Open / Closed / Merged | select |
| Draft | `draft` | checkbox |
| Author | `user.login` | richText |
| Assignees | `assignees[].login` | multiSelect |
| Reviewers | `requested_reviewers[].login` | multiSelect |
| Labels | `labels[].name` | multiSelect |
| Milestone | `milestone.title` | richText |
| Base Branch | `base.ref` | richText |
| Head Branch | `head.ref` | richText |
| Repository | `owner/repo` | richText |
| Created | `created_at` | date |
| Updated | `updated_at` | date |
| Closed | `closed_at` | date |
| Merged | `merged_at` | date |
| Merged By | `merged_by.login` | richText |

Each page body contains the PR description (markdown). State is "Merged" when
`merged_at` is set, regardless of the `state` field.

### GitHub Open PRs

A focused view of currently open pull requests, enriched with review decisions
and CI status from per-PR API calls. Because only open PRs are fetched, the
extra calls stay well within rate limits.

| Notion property | GitHub field | Type |
| --- | --- | --- |
| Title | `title` | title |
| PR Key | `owner/repo#number` | richText |
| PR Link | `html_url` | url |
| Draft | `draft` | checkbox |
| Review State | Aggregate of PR reviews | select |
| CI Status | Aggregate of check runs | select |
| Author | `user.login` | richText |
| Assignees | `assignees[].login` | multiSelect |
| Reviewers | `requested_reviewers[].login` | multiSelect |
| Labels | `labels[].name` | multiSelect |
| Milestone | `milestone.title` | richText |
| Base Branch | `base.ref` | richText |
| Head Branch | `head.ref` | richText |
| Repository | `owner/repo` | richText |
| Created | `created_at` | date |
| Updated | `updated_at` | date |

**Review State** is computed from individual review decisions. Each reviewer's
latest non-comment review is used: if any reviewer has requested changes, the
state is "Changes Requested"; if all actionable reviews are approvals, it's
"Approved". Dismissed reviews are excluded.

**CI Status** is computed from check runs on the PR's head commit: "Success"
when all checks pass, "Failure" if any check fails, "Pending" if any are still
running.

## Project structure

```text
src/
├── index.ts              — registers all databases and syncs
├── github.ts             — API client (auth, pagination, types)
├── issues.ts             — issue schema + transform
├── pull-requests.ts      — all-PRs schema + transform
├── open-pull-requests.ts — open-PRs schema + transform (reviews, CI)
└── helpers.ts            — shared utilities (dateOnly)
```

## How it works

1. The worker runs three syncs across all repositories listed in `GITHUB_REPOS`:
   - **Issues** and **All PRs** use the list endpoints (1 API call per 100
     records) and sync every 5 minutes.
   - **Open PRs** fetches only open pull requests, then makes two additional
     API calls per PR (reviews and check runs) to get review state and CI
     status. It syncs every 2 minutes.
2. Each record is converted to an `upsert` keyed by `owner/repo#number`, so
   the same issue or PR is never duplicated — even across multiple repos.
3. All three syncs share a single rate-limit pacer (4800 requests/hour) to
   stay within GitHub's 5000/hour limit.
4. Because all syncs use `mode: "replace"`, records deleted or closed in
   GitHub are automatically removed from the corresponding database.

## Prerequisites

- Node >= 22, npm >= 10.9.2
- A GitHub account with access to the repositories you want to sync
- The `ntn` CLI installed and authenticated (`ntn auth login`)

### Getting a GitHub token

1. Go to **Settings > Developer settings > Personal access tokens**
2. Create a **fine-grained token** with read access to the repos you want
   to sync (Issues and Pull Requests permissions), or a **classic token**
   with the `repo` scope
3. Copy the token — you'll need it for `GITHUB_TOKEN`

> **Production use:** For higher rate limits (15 000+ requests/hour) and
> org-level permissions, consider using a
> [GitHub App](https://docs.github.com/en/apps) instead of a personal token.

## Environment variables

### Required

| Variable | Description |
| --- | --- |
| `GITHUB_TOKEN` | Personal access token with read access to your repos |
| `GITHUB_REPOS` | Comma-separated list of repos in `owner/repo` format |

No `NOTION_API_TOKEN` is needed — the platform handles Notion credentials
automatically.

## Setup and deploy

1. Install the Notion Workers CLI:

   ```sh
   npm install -g @notionhq/ntn
   ```

2. Clone and install:

   ```sh
   cd examples/workers/syncs/github
   npm install
   ```

3. Typecheck and test:

   ```sh
   npm run check
   npm test
   ```

4. Log in to Notion:

   ```sh
   ntn auth login
   ```

5. Deploy the worker:

   ```sh
   ntn workers deploy
   ```

6. Set environment variables on the deployed worker:

   ```sh
   ntn workers env set GITHUB_TOKEN=ghp_your-token-here
   ntn workers env set GITHUB_REPOS=acme/widgets,acme/api
   ```

7. Preview a sync without writing to Notion:

   ```sh
   ntn workers sync trigger issuesSync --preview
   ntn workers sync trigger openPullRequestsSync --preview
   ```

8. Run a real sync:

   ```sh
   ntn workers sync trigger issuesSync
   ntn workers sync trigger allPullRequestsSync
   ntn workers sync trigger openPullRequestsSync
   ```

Once deployed, all three syncs run automatically. Three databases will appear
in your Notion workspace after the first run.

## Adapting the schema

Each resource has its own file with a schema and transform function:

| Resource | File |
| --- | --- |
| Issues | `src/issues.ts` |
| All Pull Requests | `src/pull-requests.ts` |
| Open Pull Requests | `src/open-pull-requests.ts` |

To add a new GitHub field:

1. Add the field to the resource's type in `src/github.ts`
2. Add a property to the schema with the appropriate `Schema.*` type
3. Add a `Builder.*` call in the transform function

## Local testing

Run offline tests (no GitHub connection needed):

```sh
npm test
```

Test a sync locally against real GitHub repos:

```sh
ntn workers exec issuesSync --local
```

## Learn more

- [Notion Workers documentation](https://developers.notion.com/docs/workers)
- [GitHub REST API — Issues](https://docs.github.com/en/rest/issues/issues)
- [GitHub REST API — Pull Requests](https://docs.github.com/en/rest/pulls/pulls)
- [GitHub REST API — Reviews](https://docs.github.com/en/rest/pulls/reviews)
- [GitHub REST API — Check Runs](https://docs.github.com/en/rest/checks/runs)
- [Contributing guide](../../../../CONTRIBUTING.md)
