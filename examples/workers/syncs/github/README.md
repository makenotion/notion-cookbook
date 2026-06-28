# Worker sync: GitHub

Syncs GitHub issues and pull requests from one or more repositories into
Notion databases that stay up to date automatically. Once deployed, the worker
checks GitHub every 5 minutes and creates or updates a Notion page for each
issue and PR.

You don't need to create the Notion databases yourself. The worker declares the
schemas and Notion creates and manages each database for you (these are called
"managed databases").

## What you get

| Database | GitHub resource | Schedule |
| --- | --- | --- |
| **GitHub Issues** | Issues | Every 5 min |
| **GitHub Pull Requests** | Pull Requests | Every 5 min |

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

### GitHub Pull Requests

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
| Additions | `additions` | number |
| Deletions | `deletions` | number |
| Comments | review + issue comments | number |
| Repository | `owner/repo` | richText |
| Created | `created_at` | date |
| Updated | `updated_at` | date |
| Merged | `merged_at` | date |

Each page body contains the PR description (markdown). State is "Merged" when
`merged_at` is set, regardless of the `state` field.

## Project structure

```text
src/
├── index.ts          — registers both databases and syncs
├── github.ts         — API client (auth, pagination, types)
├── issues.ts         — issue schema + transform
├── pull-requests.ts  — PR schema + transform
└── helpers.ts        — shared utilities (dateOnly)
```

## How it works

1. Every 5 minutes, the worker iterates through each repository listed in
   `GITHUB_REPOS`, fetching issues and PRs with page-based pagination (100
   per page).
2. Each record is converted to an `upsert` keyed by `owner/repo#number`, so
   the same issue or PR is never duplicated — even across multiple repos.
3. The platform applies the changes to the managed database and loops until
   all repos and pages have been fetched.
4. Because both syncs use `mode: "replace"`, issues or PRs deleted from GitHub
   are automatically removed from the Notion database on the next full sync.

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
   ntn workers sync trigger pullRequestsSync --preview
   ```

8. Run a real sync:

   ```sh
   ntn workers sync trigger issuesSync
   ntn workers sync trigger pullRequestsSync
   ```

Once deployed, both syncs run automatically every 5 minutes. Two databases will
appear in your Notion workspace after the first run.

## Adapting the schema

Each resource has its own file with a schema and transform function:

| Resource | File |
| --- | --- |
| Issues | `src/issues.ts` |
| Pull Requests | `src/pull-requests.ts` |

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
- [Contributing guide](../../../../CONTRIBUTING.md)
