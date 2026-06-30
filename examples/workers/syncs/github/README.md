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
├── auth.ts               — PAT, GitHub App user, and installation auth
├── github.ts             — API client (pagination, errors, types)
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
3. A token provider supplies the selected PAT, user OAuth token, or short-lived
   installation token without changing the sync or API code.
4. The API client follows GitHub's pagination links and surfaces rate-limit
   reset timing to the Workers runtime so requests can be retried safely.
5. GitHub data requests use the recommended media type and pin REST API version
   `2026-03-10`.
6. All three syncs use `mode: "replace"`. **GitHub Issues** and **All GitHub
   PRs** request all states, so closed records remain in those databases. **Open
   GitHub PRs** emits only open PRs, so a PR is removed from that database after
   it closes. Records no longer returned by GitHub are removed after a complete
   sweep.

## Prerequisites

- Node >= 22, npm >= 10.9.2
- A GitHub account with access to the repositories you want to sync
- A GitHub App installed on the target account, or permission to request or
  install one, if you choose either GitHub App mode
- The `ntn` CLI installed and authenticated (`ntn login`)

> **Supported configuration:** This example connects to GitHub.com using a
> GitHub App installation token, a GitHub App user access token, or a
> fine-grained personal access token. GitHub Enterprise Server base URLs are
> not implemented.

## Choose an authentication mode

Set `GITHUB_AUTH_MODE` to one of these values:

| Mode                             | Best for                                        | Credential lifecycle                                       |
| -------------------------------- | ----------------------------------------------- | ---------------------------------------------------------- |
| `installation` **(recommended)** | Unattended, organization-owned scheduled syncs  | Octokit renews the GitHub App installation token           |
| `user`                           | Access that should follow one employee          | Notion Workers stores and refreshes the GitHub App token   |
| `pat`                            | Local evaluation and small personal deployments | You rotate the fine-grained personal access token manually |

Installation authentication is recommended for a shared production sync
because the automation belongs to the GitHub App rather than an employee. User
authentication is useful when the sync should see only repositories that both
the app and one particular employee can access. A PAT is the shortest setup
path, but organizations can restrict or require approval for PATs.

`GITHUB_AUTH_MODE` defaults to `pat` for compatibility. Set it explicitly so
the deployment's credential source is clear.

One GitHub App can support both `installation` and `user`. A deployment uses
one mode at a time, and switching modes requires configuration changes only —
the sync code stays the same.

### GitHub permissions

The GitHub App or fine-grained PAT needs these read-only repository
permissions:

- **Issues**
- **Pull requests**
- **Checks**
- **Commit statuses**

GitHub Apps also receive the required read-only **Metadata** permission
automatically. Grant access only to the repositories listed in `GITHUB_REPOS`.

## Environment variables

| Variable                        | Modes                  | Description                                              |
| ------------------------------- | ---------------------- | -------------------------------------------------------- |
| `GITHUB_AUTH_MODE`              | All                    | `installation`, `user`, or `pat`                         |
| `GITHUB_REPOS`                  | All                    | Comma-separated repositories in `owner/repo` format      |
| `GITHUB_APP_CLIENT_ID`          | `installation`, `user` | Client ID from the GitHub App settings                   |
| `GITHUB_APP_CLIENT_SECRET`      | `user`                 | Client secret generated for the GitHub App               |
| `GITHUB_APP_PRIVATE_KEY_BASE64` | `installation`         | Single-line base64 encoding of the App's PEM private key |
| `GITHUB_APP_INSTALLATION_ID`    | `installation`         | Positive numeric ID of the App installation              |
| `GITHUB_TOKEN`                  | `pat`                  | Fine-grained personal access token                       |

Only set the credentials required by the selected mode. No `NOTION_API_TOKEN`
is needed — the platform handles Notion credentials automatically.

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

   This first deployment registers successfully before GitHub credentials
   exist. Sync runs still require one option below to be configured. The
   deployment also allocates the callback URL needed by user OAuth.

6. Configure the repositories shared by every authentication mode:

   ```sh
   ntn workers env set GITHUB_REPOS=acme/widgets,acme/api
   ```

7. Complete one of the authentication options below.

### Option 1: GitHub App installation (recommended)

This is GitHub's server-to-server model and is the recommended choice for an
unattended scheduled sync.

1. In GitHub, open **Settings > Developer settings > GitHub Apps > New GitHub
   App**. For an organization-owned app, start from the organization's
   settings instead.
2. Enter a name and homepage URL, then deselect **Active** under **Webhook**.
   This worker polls GitHub and does not use webhooks.
3. Set **Issues**, **Pull requests**, **Checks**, and **Commit statuses** to
   **Read-only** under **Repository permissions**.
4. Create the app, then use **Install App** to install it on the account that
   owns the repositories. Select only the repositories you want to sync.
5. Copy the app's **Client ID** from its settings page.
6. Generate and download a private key from the app's settings page.
7. Open the installed app's **Configure** page. Copy the numeric installation
   ID from the end of the browser URL.
8. Encode the PEM private key as one line:

   ```sh
   openssl base64 -A -in your-github-app.private-key.pem
   ```

   Base64 is only an encoding; keep the output secret. Store the command's
   output, not the PEM path.

9. Configure and redeploy the worker:

   ```sh
   ntn workers env set GITHUB_AUTH_MODE=installation
   ntn workers env set GITHUB_APP_CLIENT_ID=Iv1.your-client-id
   ntn workers env set GITHUB_APP_INSTALLATION_ID=12345678
   ntn workers env set GITHUB_APP_PRIVATE_KEY_BASE64=your-base64-value
   ntn workers deploy
   ```

GitHub installation tokens expire after one hour. `@octokit/auth-app` creates,
caches, and renews them automatically; do not create or store an installation
token yourself.

This example supports one GitHub App installation per worker deployment. Every
repository in `GITHUB_REPOS` must be available through
`GITHUB_APP_INSTALLATION_ID`.

### Option 2: GitHub App user OAuth

This is GitHub's user-to-server model. Use it when access should follow one
employee and GitHub should attribute the token to that user and the app.

The app must be installed on the account or organization that owns the
repositories. Its token can access only repositories that both the installed
app and the authorizing user can access. If the user loses access or revokes
authorization, the sync loses that access too.

1. Create and install a GitHub App by following steps 1–5 under installation
   mode above. You do not need a private key or installation ID for this mode.
2. Get the callback URL allocated by the first deployment:

   ```sh
   ntn workers oauth show-redirect-url
   ```

3. Add the printed URL to the GitHub App's **Callback URL** list. Keep **Expire
   user authorization tokens** enabled. Leave **Request user authorization
   (OAuth) during installation** disabled because the CLI starts that flow.
4. Generate a client secret on the GitHub App's settings page.
5. Configure the worker and redeploy so its OAuth capability contains the app
   credentials:

   ```sh
   ntn workers env set GITHUB_AUTH_MODE=user
   ntn workers env set GITHUB_APP_CLIENT_ID=Iv1.your-client-id
   ntn workers env set GITHUB_APP_CLIENT_SECRET=your-client-secret
   ntn workers deploy
   ```

6. Authorize the GitHub user whose access the sync should follow:

   ```sh
   ntn workers oauth start githubUserOAuth
   ```

GitHub App user tokens do not use OAuth scopes. Access comes from the app's
read-only permissions, its installed repositories, and the authorizing user's
own access. Notion Workers stores the token and handles refresh automatically.

One worker deployment stores one authorization for `githubUserOAuth`; this is
a user-scoped deployment, not a multi-user OAuth service.

### Option 3: Fine-grained personal access token

Use this for the quickest local evaluation or a small personal deployment:

1. Open **Settings > Developer settings > Personal access tokens >
   Fine-grained tokens**.
2. Select the repository owner and limit access to the repositories you want
   to sync.
3. Grant read-only **Issues**, **Pull requests**, **Checks**, and **Commit
   statuses** permissions.
4. Choose the shortest practical expiration and create the token.
5. Configure and redeploy the worker:

   ```sh
   ntn workers env set GITHUB_AUTH_MODE=pat
   ntn workers env set GITHUB_TOKEN=github_pat_your-token-here
   ntn workers deploy
   ```

Fine-grained PATs select one resource owner. An organization may restrict PATs
or require administrator approval, and you must rotate the token before it
expires.

## Run the sync

1. Preview a sync without writing to Notion:

   ```sh
   ntn workers sync trigger issuesSync --preview
   ntn workers sync trigger openPullRequestsSync --preview
   ```

2. Run a real sync:

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

For `installation` or `pat`, test against real GitHub repositories by filling
only the variables for that mode:

```sh
cp .env.example .env
# Fill in the selected mode's credentials and GITHUB_REPOS, then run:
ntn workers exec issuesSync --local
```

For `user`, complete the deployed OAuth flow first, then pull its stored token
for local execution:

```sh
ntn workers oauth start githubUserOAuth
ntn workers env pull
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
- [GitHub App authentication modes](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/about-authentication-with-a-github-app)
- [GitHub App installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- [GitHub App user authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)
- [Notion Workers OAuth](https://developers.notion.com/workers/guides/oauth)
- [Contributing guide](../../../../CONTRIBUTING.md)
