# GitHub draft release tools

**TL;DR:** Give a Notion Agent a focused way to review an existing GitHub draft
release and publish it when you are ready.

The Worker connects to one configured repository. It does not create or edit
release notes, tags, or assets, and it does not require a supporting Notion
database or Redis.

## Try asking

- “Show me the draft releases for this repository.”
- “Inspect the v1.2.3 draft, summarize the notes preview, and flag anything omitted.”
- “Publish the release you just inspected and make it the latest release.”
- “Publish this draft, but keep the current latest release unchanged.”

The Agent helps you choose a draft, shows you its live GitHub details, asks for
confirmation, and then publishes that same version.

## Quickstart

You need Node.js 22+, npm 10.9.2+, the [GitHub CLI](https://cli.github.com/),
access to deploy Notion Workers, and permission to create and install a GitHub
App. Install the Workers CLI and sign in to GitHub:

```zsh
npm install --global ntn
gh auth login
```

Create the GitHub App under the organization that owns the repository so the
Worker uses a team-owned service identity. Install it only on the repository
you want to publish from, generate a private key, and grant it:

- **Contents: Read and write**
- **Metadata: Read-only**

Webhooks are not required. Copy the Client ID from the App settings. After
installing the App, open its **Configure** page and copy the trailing number
from the URL (`.../installations/12345678`) as the installation ID. These
commands show the repository ID and a single-line copy of the private key:

```zsh
gh api repos/example-org/example-repo --jq .id
base64 < github-app.private-key.pem | tr -d '\n'
```

Deploy the Worker and set the values you found above:

```zsh
cd workers/github-draft-release-tools
npm install
ntn login
ntn workers deploy --name github-draft-release-tools

ntn workers env set GITHUB_REPOSITORY=example-org/example-repo
ntn workers env set GITHUB_REPOSITORY_ID=123456789
ntn workers env set GITHUB_AUTH_MODE=installation
ntn workers env set GITHUB_APP_CLIENT_ID=Iv23liExample
ntn workers env set GITHUB_APP_INSTALLATION_ID=12345678
ntn workers env set GITHUB_APP_PRIVATE_KEY_BASE64=your_base64_encoded_private_key
```

The numeric repository ID prevents an owner/name from silently pointing the
Worker at a different repository. After an intentional rename or transfer,
confirm that the ID is unchanged and update `GITHUB_REPOSITORY`.

In Notion, add the deployed Worker to a custom agent under **Tools and access >
Add connection**. Limit access to people who may publish this repository, and
keep confirmation enabled for the publish tool.

## How it works

The Worker exposes three tools:

| Tool                  | What it does                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `listDraftReleases`   | Lists up to 20 drafts in the configured repository so the user can choose one.              |
| `inspectRelease`      | Reads a release by numeric ID and returns its current details plus an opaque `version`.     |
| `publishDraftRelease` | Re-reads that release, requires the inspected version, publishes it, and checks the result. |

Users can choose a draft by its tag and title; the Agent carries its numeric ID
from `listDraftReleases` into `inspectRelease`. Results are bounded, and
`hasMore: true` means other drafts may exist beyond the returned list.

`inspectRelease` is read-only. Its `version` is a SHA-256 fingerprint of the
release content. It is a stale-state guard, not an approval token or security
credential.

Release notes are bounded to a 4,000-character preview. When `bodyTruncated` is
true, the agent should say so and ask the user to review the complete notes at
the returned GitHub URL before publication.

`publishDraftRelease` accepts the release ID, the exact `expectedVersion` from
inspection, and one explicit `latestBehavior`:

- `make_latest` makes the published release the repository's latest release.
- `keep_current` publishes without changing the current latest release.

Before publishing, the tool fetches the release again and stops if anything in
the inspected version changed. It sends one GitHub update, then reads the
release again to report the observed result. A matching release that is already
published returns as a no-op.

## Authentication

A GitHub App installation is recommended because it provides short-lived
tokens and can be installed on only the intended repository.

Everyone using the agent publishes through this same GitHub identity. This
recipe does not use each caller's personal GitHub permissions.

For a smaller personal setup, use a fine-grained personal access token limited
to the same repository with **Contents: Read and write**:

```zsh
ntn workers env set GITHUB_AUTH_MODE=pat
ntn workers env set GITHUB_TOKEN=github_pat_your_token
```

Do not configure both authentication modes. Keep credentials out of source
control and rotate them according to your organization's GitHub policy.

## Safety notes

- The repository name and immutable repository ID are fixed in Worker
  configuration; callers choose only a release ID.
- The draft tag must already exist. Publishing does not create or move tags,
  upload assets, or rewrite release content.
- Assets must be fully uploaded; reads are bounded so releases with more than
  100 assets fail clearly.
- The expected version prevents publication when the inspected release has
  already changed.
- GitHub does not offer a conditional release-update API. Another GitHub actor
  could still edit a draft between the Worker's final read and update. The
  Worker checks the result but cannot make those separate API calls atomic.

For stricter organizational gates, keep approval and deployment policy in
GitHub—for example, dispatch a protected GitHub Actions workflow instead of
expanding this Worker into a release-management system.

## Run locally

Copy `.env.example` to `.env`, add sandbox credentials, and use a disposable
draft release:

```zsh
ntn workers exec listDraftReleases --local -d '{}'
ntn workers exec inspectRelease --local -d '{"releaseId": 987654}'
ntn workers exec publishDraftRelease --local -d \
  '{"releaseId":987654,"expectedVersion":"version_from_inspect","latestBehavior":"make_latest"}'
```

The third command publishes a real GitHub release. Inspect its input carefully
and use a sandbox repository for local testing.

Run the offline checks without GitHub credentials:

```zsh
npm run check
npm test
npm run build
```

## Extend it

Useful next steps include a managed release sync for a richer browsing
experience or a tool that dispatches an existing GitHub Actions release
workflow. Neither is required for these tools to work.

## Project map

```text
src/index.ts   Worker and tool registration
src/config.ts  Repository and authentication configuration
src/auth.ts    GitHub App and fine-grained PAT authentication
src/github.ts  Release inspection, versioning, and publication
src/types.ts   Release and tool result types
```

## Learn more

- [Notion Workers documentation](https://developers.notion.com/workers/get-started/overview)
- [Tools for Notion Agents](https://developers.notion.com/workers/guides/tools)
- [GitHub releases REST API](https://docs.github.com/en/rest/releases/releases)
- [GitHub App authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app)
- [Contribute to this cookbook](../../CONTRIBUTING.md)
