# GitHub starred repositories sync

Turn the repositories you star on GitHub into a current Notion research
library. Star a project when it catches your attention, then use Notion to add
the evaluation status, project fit, notes, and next action that GitHub does not
store for you.

The Worker creates one managed database and refreshes it every hour. It is
read-only: it lists the authenticated GitHub user's stars and never stars,
unstars, or changes a repository.

## Quickstart

The shortest setup uses a fine-grained personal access token (PAT). You need
Node.js 22+, npm 10.9.2+, and a token with read-only **Starring** account
permission. You also need the account's immutable numeric GitHub user ID. To
find it, replace `YOUR_LOGIN` in `https://api.github.com/users/YOUR_LOGIN` and
copy the numeric `id` value; do not use the changeable login name.

From the repository root:

```sh
npm install --global ntn
cd workers/github-stars-sync
npm install
ntn login
ntn workers deploy --name github-stars-sync
ntn workers env set GITHUB_AUTH_MODE=pat
ntn workers env set GITHUB_USER_ID=your-numeric-user-id
ntn workers env set GITHUB_TOKEN=github_pat_your-token-here
```

Preview the sync output without writing to Notion:

```sh
ntn workers sync trigger starredRepositoriesSync --preview
```

Then create and populate the database immediately:

```sh
ntn workers sync trigger starredRepositoriesSync
```

After that run completes, the Worker refreshes the database every hour.

## What this unlocks

GitHub stars are useful for capture but weak for follow-through. In Notion, the
same collection can become a working system:

- Add an `Evaluation` property such as **Inbox**, **Try**, **Adopt**, or
  **Reference**.
- Relate a repository to the projects, architecture decisions, or research
  pages it may help.
- Ask a Notion Agent to find recently starred TypeScript tools, archived
  dependencies, or repositories that have not been pushed recently.
- Build views by topic, language, license, owner, or when you starred the
  repository.
- Keep implementation notes in each repository page without the sync
  replacing the page body.

The sync provides factual source fields. Your custom properties and page notes
provide the judgment that turns a bookmark list into a reusable library.

## What it creates

The Worker creates **GitHub Starred Repositories** with one page per repository.

| Notion property     | GitHub field             | Type         |
| ------------------- | ------------------------ | ------------ |
| Repository          | `repo.full_name`         | title        |
| Description         | `repo.description`       | rich text    |
| Owner               | `repo.owner.login`       | rich text    |
| Repository link     | `repo.html_url`          | URL          |
| Homepage            | `repo.homepage`          | URL          |
| Language            | `repo.language`          | select       |
| Topics              | `repo.topics`            | multi-select |
| Visibility          | `repo.visibility`        | select       |
| Archived            | `repo.archived`          | checkbox     |
| Fork                | `repo.fork`              | checkbox     |
| Stars               | `repo.stargazers_count`  | number       |
| Forks               | `repo.forks_count`       | number       |
| Open issues and PRs | `repo.open_issues_count` | number       |
| License             | `repo.license`           | rich text    |
| Default branch      | `repo.default_branch`    | rich text    |
| Starred at          | `starred_at`             | date         |
| Last pushed         | `repo.pushed_at`         | date         |
| Repository created  | `repo.created_at`        | date         |
| Repository ID       | `repo.id`                | rich text    |

`Repository ID` is the primary key. Repository names and owners can change;
the numeric repository ID remains the same, so a rename updates the existing
Notion page instead of creating a duplicate.

The Worker intentionally does not send `pageContentMarkdown`. Hourly upserts
therefore refresh only the listed provider-owned properties and leave the page
body available for your notes. Properties you add for your own workflow are
not emitted by the sync.

## How freshness and removals work

GitHub's starred-repositories endpoint supports pagination and star timestamps,
but it does not provide an update cursor, unstar tombstones, or a webhook for a
user's complete star collection. A newest-first incremental scan could find
new stars but could not reliably remove unstarred repositories.

This Worker instead runs an hourly `mode: "replace"` cycle with two complete
membership scans:

1. Before every stars page, it uses that page's exact access token with
   `GET /user` and requires the returned ID to match `GITHUB_USER_ID` and the
   account pinned in cycle state.
2. The baseline scan requests up to 100 stars per page in ascending
   `starred_at` order, follows every `Link` page, and upserts each repository by
   numeric repository ID.
3. A second complete scan reads membership again without emitting duplicate
   upserts.
4. Only when both scans contain the same repository IDs does the Worker finish
   replacement and allow Notion to remove records absent from GitHub.

If GitHub, authentication, or pagination fails partway through, the replacement
does not complete and existing pages are not swept. A star or unstar during
offset pagination can shift a live repository across an already-read page
boundary; if that changes observed membership, the confirmation scan fails the
cycle instead of deleting the skipped Notion page. The next stable hourly cycle
reconciles the collection.

Each scan supports at most 100 pages, or 10,000 stars. A stable replacement can
therefore require up to 200 logical stars pages. If GitHub reports another page,
the Worker fails before completing replacement; it never treats a known
truncated response as the full collection. Raise this guard only after reviewing
Workers execution and state limits and testing a larger library.

### What happens when you unstar a repository

On the next completed sweep, Notion removes the corresponding managed page.
That also removes page-body notes and custom property values stored on that
page. If those notes must remain durable, use a custom `Evaluation` or `Archive`
property instead of un-starring, or move the durable research record into a
separate database before removing the GitHub star.

GitHub also omits private repositories that the current PAT or GitHub App can
no longer access. That absence is indistinguishable from an unstar, so two
stable scans will eventually remove those pages too. Preview the sync after
changing token ownership, GitHub App repository access, or organization policy,
and move durable notes first when visibility may shrink.

## Authentication

One deployment represents one GitHub user. Choose `pat` for the shortest setup
or `user` for a refreshable GitHub App user token managed by Notion Workers.

| Mode   | Best for                             | Required values                                                      |
| ------ | ------------------------------------ | -------------------------------------------------------------------- |
| `pat`  | Personal evaluation and simple setup | `GITHUB_USER_ID`, `GITHUB_TOKEN`                                     |
| `user` | Refreshable GitHub App authorization | `GITHUB_USER_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` |

GitHub App installation tokens are intentionally unsupported. They represent
an installation rather than a person, while `GET /user/starred` lists the
authenticated user's collection.

### Fine-grained PAT

1. Open **GitHub Settings > Developer settings > Personal access tokens >
   Fine-grained tokens**.
2. Choose the user as the resource owner.
3. Under **Account permissions**, grant **Starring: Read-only**.
4. Give the token the minimum repository access needed for private repositories
   you expect to see. Public repository metadata does not require broad private
   repository access.
5. Choose a practical expiration and create the token.
6. Configure the Worker:

   ```sh
   ntn workers env set GITHUB_AUTH_MODE=pat
   ntn workers env set GITHUB_USER_ID=your-numeric-user-id
   ntn workers env set GITHUB_TOKEN=github_pat_your-token-here
   ```

Organizations can restrict or require approval for fine-grained PATs. Rotate
the token before it expires. The Worker requests no write permission.

### GitHub App user OAuth

Use this mode when you want GitHub to issue a refreshable user access token
rather than storing a PAT.

1. Complete the PAT quickstart through the first deployment. That allocates the
   Worker's OAuth callback URL.
2. In GitHub, create a GitHub App. Disable its webhook because this Worker
   polls the list endpoint.
3. Under **Account permissions**, set **Starring** to **Read-only**. Do not
   grant write permission.
4. Print the Worker's callback URL:

   ```sh
   ntn workers oauth show-redirect-url
   ```

5. Add that URL to the GitHub App's **Callback URL** list. Keep expiring user
   authorization tokens enabled.
6. Copy the app's client ID, generate a client secret, then configure and
   redeploy:

   ```sh
   ntn workers env set GITHUB_AUTH_MODE=user
   ntn workers env set GITHUB_USER_ID=your-numeric-user-id
   ntn workers env set GITHUB_APP_CLIENT_ID=Iv1.your-client-id
   ntn workers env set GITHUB_APP_CLIENT_SECRET=your-client-secret
   ntn workers deploy
   ```

7. Authorize the GitHub user whose stars should populate the database:

   ```sh
   ntn workers oauth start githubUserOAuth
   ```

GitHub filters private resources according to the user token and app's access.
Use `--preview` to verify the expected collection before the first real sync.

## Configuration reference

| Variable                   | Modes  | Description                                   |
| -------------------------- | ------ | --------------------------------------------- |
| `GITHUB_AUTH_MODE`         | All    | `pat` or `user`; defaults to `pat`            |
| `GITHUB_USER_ID`           | All    | Immutable numeric ID of the one expected user |
| `GITHUB_TOKEN`             | `pat`  | Fine-grained personal access token            |
| `GITHUB_APP_CLIENT_ID`     | `user` | GitHub App client ID                          |
| `GITHUB_APP_CLIENT_SECRET` | `user` | GitHub App client secret                      |

`GITHUB_USER_ID` is a deletion-safety boundary, not a display name. Every page
verifies that the current token's `GET /user` response matches it. A token
rotation or OAuth reauthorization to another account therefore fails before
that credential can contribute stars to the replacement cycle. No
`NOTION_API_TOKEN` is needed because the Workers runtime supplies Notion
authentication.

## API and pagination behavior

For every logical page, the client first calls
`GET https://api.github.com/user` and then calls
`GET https://api.github.com/user/starred` with the same token. The stars request
uses:

- `Accept: application/vnd.github.star+json`, which changes each result to a
  `{ starred_at, repo }` envelope.
- `X-GitHub-Api-Version: 2026-03-10`.
- `sort=created`, `direction=asc`, `per_page=100`, and the current page.

It treats GitHub's `Link` header as authoritative, rejects repeated, backward,
off-origin, and over-limit next-page links, and surfaces provider rate-limit
timing through the Workers retry mechanism. Each HTTP request has a 30-second
timeout and an 8 MiB response-body limit. Requests are serialized through a
shared pacer with headroom below GitHub's normal authenticated hourly limit.

## Project structure

```text
fixtures/
├── starred-page-1.json — representative first API page
└── starred-page-2.json — representative final API page
src/
├── index.ts            — registers the database, pacer, OAuth, and sync
├── auth.ts             — PAT/OAuth providers and expected-account validation
├── github.ts           — typed REST client, validation, pagination, retries
├── repositories.ts     — Notion schema and repository-to-upsert transform
└── sync.ts             — account-bound baseline/confirmation scan state
test.ts                 — deterministic offline contract and behavior tests
```

## Adapt the workflow

### Add your own review fields

Add properties such as `Evaluation`, `Use for`, `Tried`, or a relation to a
Projects database directly in Notion. Do not add them to
`repositoryToChange()` unless GitHub should own their values.

### Add another GitHub field

1. Add and validate the field in `src/github.ts`.
2. Add the corresponding property in `repositorySchema`.
3. Emit a `Builder.*` value in `repositoryToChange()`.
4. Explicitly emit `[]` when a nullable provider field disappears so stale
   source values are cleared.
5. Update the schema table and offline fixtures.

Keep the numeric repository ID as the key. Avoid writing generated summaries
into the page body if users are expected to keep notes there.

### Change the schedule

Change `schedule: "1h"` in `src/index.ts`. Less frequent schedules reduce API
traffic but leave unstarred pages present longer. Do not replace the full sweep
with an incremental scan unless the design also includes a complete,
automatically run reconciliation path.

## Verify locally

The checks are deterministic and require no GitHub or Notion credentials:

```sh
cd workers/github-stars-sync
npm install
npm run check
npm test
npm run build
```

They cover response validation, star-media envelopes, stable keys, nullable
field clearing, pagination links, page caps, rate limits, request timeouts,
account mismatches, mutation-safe confirmation scans, authentication selection,
the read-only request, and the Worker manifest.

For a live local PAT check, create `.env` from the safe template and run:

```sh
cp .env.example .env
# Fill in GITHUB_AUTH_MODE=pat, GITHUB_USER_ID, and GITHUB_TOKEN, then:
ntn workers exec starredRepositoriesSync --local
```

Do not commit `.env`, generated Worker state, tokens, or live API responses that
contain private repository data.

## Learn more

- [Notion Workers overview](https://developers.notion.com/workers/get-started/overview)
- [Notion Workers sync guide](https://developers.notion.com/workers/guides/syncs)
- [GitHub REST API endpoints for starring](https://docs.github.com/en/rest/activity/starring)
- [GitHub REST API endpoint for the authenticated user](https://docs.github.com/en/rest/users/users#get-the-authenticated-user)
- [GitHub REST API pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)
- [GitHub REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
- [GitHub App user authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)
- [Contributing guide](../../CONTRIBUTING.md)
