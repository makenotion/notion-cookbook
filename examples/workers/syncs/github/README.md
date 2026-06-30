# Worker sync: GitHub

Syncs GitHub issues and pull requests from one or more repositories into
Notion databases that stay up to date automatically. Once deployed, the worker
creates three databases covering issues, all pull requests, and a focused view
of open PRs with review activity and CI status.

You don't need to create the Notion databases yourself. The worker declares the
schemas and Notion creates and manages each database for you (these are called
"managed databases").

## What you get

| Database            | GitHub resource            | Schedule    |
| ------------------- | -------------------------- | ----------- |
| **GitHub Issues**   | Issues                     | Every 5 min |
| **All GitHub PRs**  | Pull Requests (all states) | Every 5 min |
| **Open GitHub PRs** | Open PRs + reviews + CI    | Every 5 min |

### GitHub Issues

| Notion property | GitHub field            | Type        |
| --------------- | ----------------------- | ----------- |
| Title           | `title`                 | title       |
| Issue Key       | `owner/repo#number`     | richText    |
| Issue Link      | `html_url`              | url         |
| State           | `state`                 | select      |
| State Reason    | `state_reason`          | select      |
| Author          | `user.login`            | richText    |
| Assignees       | `assignees[].login`     | multiSelect |
| Labels          | `labels[].name`         | multiSelect |
| Milestone       | `milestone.title`       | richText    |
| Comments        | `comments`              | number      |
| Reactions       | `reactions.total_count` | number      |
| Repository      | `owner/repo`            | richText    |
| Created         | `created_at`            | date        |
| Updated         | `updated_at`            | date        |
| Closed          | `closed_at`             | date        |

Each page body contains the issue body (markdown).

### All GitHub PRs

| Notion property | GitHub field                  | Type        |
| --------------- | ----------------------------- | ----------- |
| Title           | `title`                       | title       |
| PR Key          | `owner/repo#number`           | richText    |
| PR Link         | `html_url`                    | url         |
| State           | Open / Closed / Merged        | select      |
| Draft           | `draft`                       | checkbox    |
| Author          | `user.login`                  | richText    |
| Assignees       | `assignees[].login`           | multiSelect |
| Reviewers       | `requested_reviewers[].login` | multiSelect |
| Labels          | `labels[].name`               | multiSelect |
| Milestone       | `milestone.title`             | richText    |
| Base Branch     | `base.ref`                    | richText    |
| Head Branch     | `head.ref`                    | richText    |
| Repository      | `owner/repo`                  | richText    |
| Created         | `created_at`                  | date        |
| Updated         | `updated_at`                  | date        |
| Closed          | `closed_at`                   | date        |
| Merged          | `merged_at`                   | date        |

Each page body contains the PR description (markdown). State is "Merged" when
`merged_at` is set, regardless of the `state` field.

### Open GitHub PRs

A focused view of currently open pull requests, enriched with review activity
and CI status from per-PR API calls.

| Notion property | GitHub field                          | Type        |
| --------------- | ------------------------------------- | ----------- |
| Title           | `title`                               | title       |
| PR Key          | `owner/repo#number`                   | richText    |
| PR Link         | `html_url`                            | url         |
| Draft           | `draft`                               | checkbox    |
| Review Activity | Latest submitted reviews by reviewer  | select      |
| CI Status       | Check runs and commit status contexts | select      |
| Author          | `user.login`                          | richText    |
| Assignees       | `assignees[].login`                   | multiSelect |
| Reviewers       | `requested_reviewers[].login`         | multiSelect |
| Labels          | `labels[].name`                       | multiSelect |
| Milestone       | `milestone.title`                     | richText    |
| Base Branch     | `base.ref`                            | richText    |
| Head Branch     | `head.ref`                            | richText    |
| Repository      | `owner/repo`                          | richText    |
| Created         | `created_at`                          | date        |
| Updated         | `updated_at`                          | date        |

**Review Activity** summarizes submitted reviews. Each reviewer's latest
non-comment review is used: if any reviewer has requested changes, the state is
"Changes Requested"; otherwise, if at least one current review is an approval,
it is "Approved". Dismissed reviews are excluded. This does not evaluate branch
protection, required reviewers, CODEOWNERS, or whether GitHub considers the PR
ready to merge.

**CI Status** combines check runs and commit status contexts on the PR's head
commit. Failure, cancellation, or timeout produces "Failure"; otherwise, a
nonterminal result produces "Pending". Completed `success`, `neutral`, and
`skipped` checks count as passing, and all observed results must pass for
"Success".

## Project structure

```text
src/
├── index.ts              — registers all databases and syncs
├── github.ts             — API client (auth, pagination, types)
├── issues.ts             — issue schema + transform
├── all-pull-requests.ts  — all-PRs schema + transform
├── open-pull-requests.ts — open-PRs schema + transform (reviews, CI)
└── helpers.ts            — shared utilities (dateOnly)
```

## How it works

1. The worker runs three syncs across all repositories listed in `GITHUB_REPOS`:
   - **Issues** and **All PRs** use list endpoints that return pages of up to
     100 GitHub results and sync every 5 minutes.
   - **Open PRs** scans pull requests in stable creation order, emits only open
     pull requests, then fetches reviews, check runs, and commit status contexts
     to summarize review and CI activity. It syncs every 5 minutes.
2. Each record is converted to an `upsert` keyed by `owner/repo#number`, so
   the same issue or PR is never duplicated — even across multiple repos.
3. The API client follows GitHub's pagination links and surfaces rate-limit
   reset timing to the Workers runtime so requests can be retried safely.
4. Requests use GitHub's recommended media type and pin REST API version
   `2026-03-10`.
5. All three syncs use `mode: "replace"`. **GitHub Issues** and **All GitHub
   PRs** request all states, so closed records remain in those databases. **Open
   GitHub PRs** emits only open PRs, so a PR is removed from that database after
   it closes. Records no longer returned by GitHub are removed after a complete
   sweep.

## Prerequisites

- Node >= 22, npm >= 10.9.2
- A GitHub account with access to the repositories you want to sync
- The `ntn` CLI installed and authenticated (`ntn login`)

> **Supported configuration:** This example connects to repositories on
> GitHub.com with a personal access token. GitHub Enterprise Server base URLs
> and GitHub App authentication/token renewal are not implemented.

### Getting a GitHub token

1. Go to **Settings > Developer settings > Personal access tokens >
   Fine-grained tokens**.
2. Limit repository access to the repositories you want to sync.
3. Grant these read-only repository permissions: **Issues**, **Pull
   requests**, **Checks**, and **Commit statuses**.
4. Copy the token — you'll need it for `GITHUB_TOKEN`.

Fine-grained tokens select a single resource owner. All private repositories in
one deployment must be available through that selected user or organization,
and an organization may require an administrator to approve the token.

Use the shortest practical expiration and rotate the token before it expires.

## Environment variables

### Required

| Variable       | Description                                                   |
| -------------- | ------------------------------------------------------------- |
| `GITHUB_TOKEN` | Fine-grained personal access token with the permissions above |
| `GITHUB_REPOS` | Comma-separated list of repos in `owner/repo` format          |

No `NOTION_API_TOKEN` is needed — the platform handles Notion credentials
automatically.

## Setup and deploy

1. Install the Notion Workers CLI:

   ```sh
   curl -fsSL https://ntn.dev | bash
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
   ntn login
   ```

5. Deploy the worker:

   ```sh
   ntn workers deploy --name github-sync
   ```

6. Set environment variables on the deployed worker:

   ```sh
   ntn workers env set GITHUB_TOKEN=github_pat_your-token-here
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

| Resource           | File                        |
| ------------------ | --------------------------- |
| Issues             | `src/issues.ts`             |
| All Pull Requests  | `src/all-pull-requests.ts`  |
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
cp .env.example .env
# Fill in GITHUB_TOKEN and GITHUB_REPOS in .env, then run:
ntn workers exec issuesSync --local
```

## Learn more

- [Notion Workers documentation](https://developers.notion.com/workers/get-started/overview)
- [GitHub REST API — Issues](https://docs.github.com/en/rest/issues/issues)
- [GitHub REST API — Pull Requests](https://docs.github.com/en/rest/pulls/pulls)
- [GitHub REST API — Reviews](https://docs.github.com/en/rest/pulls/reviews)
- [GitHub REST API — Check Runs](https://docs.github.com/en/rest/checks/runs)
- [GitHub REST API — Commit Statuses](https://docs.github.com/en/rest/commits/statuses)
- [GitHub REST API — Best Practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
- [Contributing guide](../../../../CONTRIBUTING.md)
