# GitHub draft release tools

**TL;DR:** Give a Notion Agent a focused way to review an existing GitHub draft
release and publish it when you are ready.

The Worker connects to one configured repository. It does not create or edit
release notes, tags, or assets, and it does not require a supporting Notion
database or Redis.

## Try asking

- “Inspect draft release 987654 and summarize what will be published.”
- “Check the tag, commit, notes, and assets for release 987654.”
- “Publish the release you just inspected and make it the latest release.”
- “Publish this draft, but keep the current latest release unchanged.”

The inspect-first flow keeps the conversation useful: the agent can show you
the live GitHub release, ask for confirmation, and then publish that same
version.

## Quickstart

Create a GitHub App, install it on the repository you want to use, and grant it:

- **Contents: Read and write**
- **Metadata: Read-only**

Then deploy the Worker from the repository root:

```zsh
npm install --global ntn
cd workers/github-publish-prepared-release
npm install
ntn login
ntn workers deploy --name github-publish-prepared-release

ntn workers env set GITHUB_REPOSITORY=example-org/example-repo
ntn workers env set GITHUB_REPOSITORY_ID=123456789
ntn workers env set GITHUB_AUTH_MODE=installation
ntn workers env set GITHUB_APP_CLIENT_ID=Iv23liExample
ntn workers env set GITHUB_APP_INSTALLATION_ID=12345678
ntn workers env set GITHUB_APP_PRIVATE_KEY_BASE64=your_base64_encoded_private_key
```

`GITHUB_REPOSITORY_ID` is the numeric ID shown by GitHub's repository API. It
keeps the Worker tied to the same repository even if an owner or repository is
renamed.

In Notion, add the deployed Worker to a custom agent under **Tools and access >
Add connection**.

## How it works

The Worker exposes two tools:

| Tool                  | What it does                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `inspectDraftRelease` | Reads a draft by numeric release ID and returns its current details plus an opaque `version`. |
| `publishDraftRelease` | Re-reads that release, requires the inspected version, publishes it, and checks the result.   |

`inspectDraftRelease` is read-only. Its `version` is a SHA-256 fingerprint of
the observed release state. It is a stale-state guard, not an approval token or
security credential.

`publishDraftRelease` accepts:

- `releaseId`: the same positive numeric ID used for inspection;
- `expectedVersion`: the opaque `version` returned by inspection; and
- `makeLatest`: GitHub's `"true"`, `"false"`, or `"legacy"` policy.

Before publishing, the tool fetches the release again and rejects the request
if anything represented by `expectedVersion` changed. It sends one GitHub
update that changes the draft to a published release, then reads the release
again to report the observed result. A matching release that is already
published returns as a no-op.

The publish tool is marked as a write operation, so a Notion Agent normally
asks for confirmation before calling it. The GitHub credential and configured
repository remain the real access boundary.

## Authentication

A GitHub App installation is recommended because it provides short-lived
tokens and can be installed on only the intended repository.

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
ntn workers exec inspectDraftRelease --local -d '{"releaseId": 987654}'
ntn workers exec publishDraftRelease --local -d \
  '{"releaseId": 987654, "expectedVersion": "version_from_inspect", "makeLatest": "false"}'
```

The second command publishes a real GitHub release. Inspect its input carefully
and use a sandbox repository for local testing.

Run the offline checks without GitHub credentials:

```zsh
npm run check
npm test
npm run build
```

## Extend it

This example intentionally keeps publication small and direct. Useful next
steps include a read-only release browser, a managed release sync for discovery,
or a tool that dispatches an existing GitHub Actions release workflow. None is
required for these two tools to work.

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
