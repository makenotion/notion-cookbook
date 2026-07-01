# Sync closed GitHub PRs to Notion tasks

Connect pull requests to the Notion tasks they implement. When a linked PR is
closed, this example adds the outcome to its Notion task and can optionally
update a Status property.

The script reads one GitHub repository and writes only to Notion. It does not
change pull requests or other GitHub data.

## Run it

### 1. Prepare Notion

Create or choose a task database, then create a
[Notion integration](https://www.notion.com/my-integrations) and connect it to
that database through **••• > Connections**.

The integration needs permission to read and create comments. If you enable
status updates, it also needs permission to update page content and the database
must have a Status property with these options:

- `Closed - Merged`
- `Closed - Not Merged`

### 2. Prepare GitHub

Create a GitHub personal access token with read access to pull requests in the
repository you want to inspect. Note the repository owner and name.

For a PR to match a task, put the task's canonical Notion page URL at the end of
the PR description, without query parameters. For example:

```text
https://www.notion.so/Example-task-0123456789abcdef0123456789abcdef
```

### 3. Configure and run

From the repository root:

```sh
cd examples/notion-task-github-pr-sync
npm install
```

Create an untracked `.env` file:

```dotenv
GITHUB_KEY=your-github-personal-access-token
NOTION_KEY=your-notion-integration-token
GITHUB_REPO_OWNER=github-owner-or-organization
GITHUB_REPO_NAME=repository-name

# Only a value of "true" enables Status updates. "false" or an omitted variable
# leaves the Status property unchanged.
UPDATE_STATUS_IN_NOTION_DB=false

# Required only when UPDATE_STATUS_IN_NOTION_DB=true
STATUS_PROPERTY_NAME=Status
```

Then run the sync once:

```sh
npm start
```

## What changes in Notion

For each matching closed PR, the integration adds a comment linking to the PR
and saying whether it was merged or closed without merging.

| Configuration                                 | Result                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `UPDATE_STATUS_IN_NOTION_DB=false` or omitted | Adds the PR outcome comment and leaves all task properties unchanged.                           |
| `UPDATE_STATUS_IN_NOTION_DB=true`             | Adds the comment and sets `STATUS_PROPERTY_NAME` to `Closed - Merged` or `Closed - Not Merged`. |

The script skips a task when this integration has already created any comment
on that page. This prevents duplicate PR comments on later runs, but it also
means another comment created by the same integration will cause the task to be
treated as already processed.

If no eligible tasks remain, the script prints `Notion Tasks are already
up-to-date` and makes no changes.
