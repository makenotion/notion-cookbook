# Cookbook roadmap

This file tracks recipe ideas that are not runnable yet. They are intentionally
excluded from `catalog.json` and the example directories until they have
working code, complete setup instructions, and offline checks.

## Worker ideas

### Spotify control

Create a `workers/spotify-control/` agent tool that can inspect playback and
perform explicitly authorized playback actions. A complete recipe should cover
Spotify OAuth and token refresh, device selection, required scopes, clear
confirmation boundaries for mutations, rate limits, and offline request and
response tests.

## Proposing or implementing an idea

Open an issue to discuss scope before implementing a new external integration.
When the code is runnable, follow the Worker contract in
[`CONTRIBUTING.md`](CONTRIBUTING.md), add it to `catalog.json`, and link it from
the cookbook indexes in the same pull request.
