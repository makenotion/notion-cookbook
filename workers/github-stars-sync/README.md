# Worker sync: GitHub starred repositories

Turn the repositories you star on GitHub into a current Notion research
library. Use the resulting database to evaluate tools, connect them to projects,
and keep implementation notes that do not belong in GitHub.

One deploy creates the managed database and refreshes it every hour. The Worker
is read-only: it never stars, unstars, or changes a repository. You do not need
to create the database or provide a Notion API token.

## Quickstart

You need Node.js 22+, npm 10.9.2+, a GitHub.com account, and a fine-grained
personal access token (PAT) with read-only **Starring** account permission. This
recipe does not support GitHub Enterprise Server. You also need the account's
immutable numeric user ID. Open
`https://api.github.com/users/YOUR_LOGIN` and copy the numeric `id`; do not use
the changeable login name.

From the repository root:

```sh
npm install --global ntn@latest
cd workers/github-stars-sync
npm install
ntn login
ntn workers deploy --name github-stars-sync
ntn workers sync pause starredRepositoriesSync
ntn workers env set GITHUB_AUTH_MODE=pat
ntn workers env set GITHUB_USER_ID=your-numeric-user-id
ntn workers env set GITHUB_TOKEN=github_pat_your-token-here
```

Use `--name github-stars-sync` only for the first deployment. After
`workers.json` identifies the deployed Worker, update it with
`ntn workers deploy`.

The first deployment starts the schedule, so keep it paused while you validate
the connection. Preview the database without changing Notion, then start the
first sync manually:

```sh
ntn workers sync trigger starredRepositoriesSync --preview
ntn workers sync trigger starredRepositoriesSync
ntn workers sync status starredRepositoriesSync
```

When the first run succeeds and the private database looks right, press Ctrl-C
and start the hourly schedule:

```sh
ntn workers sync resume starredRepositoriesSync
```

Preview output can include private repository metadata, so treat it as
sensitive.

## What you can answer

| Managed database                | Questions it helps answer                                                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub Starred Repositories** | What did I star recently? Which tools fit a project or language? Which repositories are archived, inactive, highly adopted, or ready to try? |

Add properties such as **Evaluation**, **Use for**, **Tried**, or a relation to
your Projects database directly in Notion. The Worker refreshes GitHub-owned
fields while leaving those properties and each page body available for your
judgment and notes.

## Reference

### Synced database and schedule

| Database                        | Sync                      | Mode        | Schedule   |
| ------------------------------- | ------------------------- | ----------- | ---------- |
| **GitHub Starred Repositories** | `starredRepositoriesSync` | incremental | Every hour |

The database contains one page per repository:

| Notion property     | GitHub field             | Type         |
| ------------------- | ------------------------ | ------------ |
| Repository          | `repo.full_name`         | title        |
| Description         | `repo.description`       | rich text    |
| Owner               | `repo.owner.login`       | rich text    |
| Starred at          | `starred_at`             | date         |
| Last pushed         | `repo.pushed_at`         | date         |
| Stars               | `repo.stargazers_count`  | number       |
| Archived            | `repo.archived`          | checkbox     |
| Topics              | `repo.topics`            | multi-select |
| Language            | `repo.language`          | select       |
| Repository link     | `repo.html_url`          | URL          |
| Homepage            | `repo.homepage`          | URL          |
| License             | `repo.license`           | rich text    |
| Visibility          | `repo.visibility`        | select       |
| Fork                | `repo.fork`              | checkbox     |
| Forks               | `repo.forks_count`       | number       |
| Open issues and PRs | `repo.open_issues_count` | number       |
| Repository created  | `repo.created_at`        | date         |
| Default branch      | `repo.default_branch`    | rich text    |
| Repository ID       | `repo.id`                | rich text    |

**Repository ID** is the primary key. Repository names and owners can change;
the numeric ID keeps a rename on the same Notion page.

The Worker does not emit `pageContentMarkdown`. It updates only the properties
listed above, so page-body notes and properties you add in Notion are not
overwritten during refreshes.

### How it works

GitHub provides paginated star timestamps, but no update cursor, unstar
tombstones, or webhook for a user's complete star collection. A newest-first
scan could capture new stars but could not remove unstarred repositories
reliably.

This Worker uses incremental mode so removals are explicit, but it still scans
the complete star collection every hour:

1. For every stars page, it calls `GET /user` with the same credential and
   verifies the returned ID against `GITHUB_USER_ID` and the account pinned in
   sync state.
2. One pass reads stars in ascending `starred_at` order and upserts each
   repository by numeric ID.
3. A repository missing from one completed hourly inventory is retained and
   recorded as a possible absence.
4. Only a second consecutive completed inventory without that repository emits
   an explicit delete. Seeing it again clears the absence evidence.

Authentication, pagination, or validation failures do not count as completed
inventories and never confirm a deletion. Ordinary failures resume from the
saved page. If a cross-page duplicate proves that offset pagination shifted,
the Worker ends without advancing absence evidence and starts from page one on
the next schedule. Stars and unstars do not require a manual state reset.

Each inventory supports up to 100 GitHub pages, or 10,000 stars. A larger or known
truncated collection fails instead of being treated as complete. Requests use
GitHub's star media type and pinned REST API version, share a conservative rate
pacer, respect rate-limit reset timing, and have bounded time and response size.

### Deletion and access behavior

After a repository is absent from two consecutive completed inventories, the
Worker removes it from the managed database. Removing a managed page also
removes its page-body notes and custom property values. If that context must
remain durable, mark the repository with an **Archive** or **Evaluation**
property instead of un-starring, or move the durable record elsewhere first.
The two-inventory delay protects against one shifted offset traversal; GitHub
does not provide an atomic snapshot of the star collection.

GitHub also omits private repositories that the current credential can no
longer read. That absence is indistinguishable from an unstar, so two completed
inventories remove those pages too. Preserve durable notes before narrowing
PAT, GitHub App, or organization access. Preview the reduced scope as
verification, but do not treat preview as a pause on the hourly schedule.

Deployments preserve inventory state. Do not reset state to recover from normal
membership changes. A reset safely starts a new baseline, but it forgets
already-managed repositories that are no longer visible to GitHub; those stale
Notion pages may then require manual removal.

### Authentication

One deployment represents one GitHub user:

| Mode   | Best for                             | Required values                                                      |
| ------ | ------------------------------------ | -------------------------------------------------------------------- |
| `pat`  | Personal use and the shortest setup  | `GITHUB_USER_ID`, `GITHUB_TOKEN`                                     |
| `user` | Refreshable GitHub App authorization | `GITHUB_USER_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` |

For PAT mode, create a fine-grained token owned by the user, grant **Starring:
Read-only** under account permissions, and select only the repository access
needed for private stars. The Worker requests no write permission.

For GitHub App user OAuth:

1. Deploy once in PAT mode so Workers allocates the OAuth callback URL.
2. Create a GitHub App with no webhook. Under **Where can this GitHub App be
   installed?**, choose **Any account** if private stars belong to accounts
   other than the app owner.
3. Grant **Starring: Read-only** under account permissions.
4. Print the callback URL with `ntn workers oauth show-redirect-url` and add it
   to the app's callback URLs.
5. From the app's **Install App** page, install it on every account that owns
   private starred repositories you expect to sync: the user's personal account
   for personal repositories and each relevant organization. Request an
   organization owner's approval when needed. If GitHub shows a
   repository-access choice, select all repositories or include every expected
   private repository.
6. Configure the app credentials and redeploy:

   ```sh
   ntn workers env set GITHUB_AUTH_MODE=user
   ntn workers env set GITHUB_USER_ID=your-numeric-user-id
   ntn workers env set GITHUB_APP_CLIENT_ID=Iv1.your-client-id
   ntn workers env set GITHUB_APP_CLIENT_SECRET=your-client-secret
   ntn workers deploy
   ```

7. Authorize the GitHub user:

   ```sh
   ntn workers oauth start githubUserOAuth
   ```

8. Immediately run a preview and confirm that expected private repositories
   are present. If coverage is incomplete, restore installation access before
   leaving the scheduled capability enabled.

Authorization does not install a GitHub App. GitHub App user tokens can access
resources only in accounts where the app is installed. Keep expiring user
authorization tokens enabled. Installation tokens are not supported because
`GET /user/starred` represents a person, not an app installation.

| Variable                   | Modes  | Description                               |
| -------------------------- | ------ | ----------------------------------------- |
| `GITHUB_AUTH_MODE`         | All    | `pat` or `user`; defaults to `pat`        |
| `GITHUB_USER_ID`           | All    | Immutable numeric ID of the expected user |
| `GITHUB_TOKEN`             | `pat`  | Fine-grained personal access token        |
| `GITHUB_APP_CLIENT_ID`     | `user` | GitHub App client ID                      |
| `GITHUB_APP_CLIENT_SECRET` | `user` | GitHub App client secret                  |

`GITHUB_USER_ID` verifies the credential and pins persisted inventory state to
one account. Never change both the expected ID and credential to repoint an
existing deployment. Create a separate Worker and managed database for the
other account.

### Adapt the sync

- **Add workflow fields in Notion.** Keep user-owned values out of
  `repositoryToChange()` so GitHub refreshes do not overwrite them.
- **Sync another GitHub field.** Validate it in `src/github.ts`, add its schema
  property in `src/repositories.ts`, emit the matching `Builder.*` value, and
  update the test payload and property table. Emit `[]` when a nullable source
  value disappears so stale values are cleared.
- **Change the schedule.** Edit `schedule: "1h"` in `src/index.ts`. Keep the
  complete inventory and two-inventory absence confirmation so unstars and
  permission changes cannot delete pages after one incomplete view.

Keep the numeric repository ID as the sync key and leave page bodies unmanaged
when users are expected to keep notes there.

### Local verification

The checks are deterministic and require no GitHub or Notion credentials:

```sh
cd workers/github-stars-sync
npm install
npm run check
npm test
npm run build
```

For a live local read, copy the safe template, add the PAT and expected user ID,
then run the capability without deploying:

```sh
cp .env.example .env
ntn workers exec starredRepositoriesSync --local
```

Never commit `.env`, access tokens, generated Worker state, or output containing
private repository metadata.

## Learn more

- [Notion Workers overview](https://developers.notion.com/workers/get-started/overview)
- [Notion Workers sync guide](https://developers.notion.com/workers/guides/syncs)
- [GitHub REST API endpoints for starring](https://docs.github.com/en/rest/activity/starring)
- [GitHub REST API endpoint for the authenticated user](https://docs.github.com/en/rest/users/users#get-the-authenticated-user)
- [GitHub REST API pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)
- [GitHub App user authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)
- [Install your own GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app)
- [Contributing guide](../../CONTRIBUTING.md)
