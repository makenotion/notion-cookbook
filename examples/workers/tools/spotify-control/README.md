# Worker Tool: Spotify Control

Five Notion agent tools that let an agent control the calling user's Spotify playback — `play`, `pause`, `skip`, `queue`, and `nowPlaying`. Auth is per-user OAuth, so each Notion user who invokes the agent authorizes their own Spotify account.

## Prerequisites

- A Notion workspace where you can install workers.
- A [Spotify Developer account](https://developer.spotify.com/) (free).
- Spotify open and playing on a device (phone, desktop app, or [web player](https://open.spotify.com)) when you test — the Web API can't talk to a device that isn't currently active.
- Node.js ≥ 22 and the [`ntn` CLI](https://developers.notion.com/workers/get-started/quickstart) installed.

## Step 1 — Create a Spotify app

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and click **Create app**.
2. Fill in **App name** and **App description**.
3. Get your worker's callback URL:
   ```zsh
   ntn workers oauth show-redirect-url
   ```
   Paste it into **Redirect URIs**. Click **Add**, then **Save**.
4. Under **Which API/SDKs are you planning to use?**, tick **Web API**.
5. Open **Settings** on the new app to reveal **Client ID** and **Client secret**.

## Step 2 — Clone and install

```zsh
git clone https://github.com/makenotion/notion-cookbook.git
cd notion-cookbook/examples/workers/tools/spotify-control
npm install
ntn login
```

## Step 3 — Store the credentials

```zsh
ntn workers env set SPOTIFY_CLIENT_ID=<client-id>
ntn workers env set SPOTIFY_CLIENT_SECRET=<client-secret>
```

## Step 4 — Deploy

```zsh
ntn workers deploy --name spotify-control
```

## Step 5 — Authorize (one-time, per user)

```zsh
ntn workers oauth start spotifyAuth
```

A browser opens to Spotify's consent screen. Approve the requested scopes (`user-read-playback-state`, `user-modify-playback-state`, `user-read-currently-playing`).

> Every Notion user who runs the worker's tools will be prompted to authorize their own Spotify account the first time they invoke one — the runtime stores per-user tokens.

## Step 6 — Verify it works

1. Open Spotify on a device and start any track (the Web API will respond with "No active device" otherwise).
2. Connect the worker to a custom agent in Notion: **Settings → Connections → Add custom agent → Add tools**.
3. Ask the agent:
   > "Play Bohemian Rhapsody by Queen on Spotify."

The agent calls the `play` tool, which searches the catalog and starts playback. You'll hear the track switch on your device within a second.

## How the code is organized

- `src/index.ts` — Worker entry. Declares the OAuth provider and the five tools. A shared `resolveTrackUri` helper lets `play` and `queue` accept either a search query or an explicit URI.
- `src/spotify.ts` — Web API client. Centralizes the `Authorization: Bearer` header and translates Spotify's "no active device" 404 into an actionable error message.
- `src/types.ts` — Minimal Spotify response shapes (`SpotifyTrack`, `SpotifySearchResponse`, `CurrentlyPlayingResponse`).

OAuth is per-user — `accessToken()` returns the calling user's token, scoped to their authorized account, so no user-ID plumbing is needed in our code.

## Customizing

- **Resolve albums and playlists** — `playTrack` always sends `{ uris: [uri] }`. To support album/playlist URIs, switch to `{ context_uri: uri }` when the URI doesn't start with `spotify:track:`.
- **Add `transferPlayback`** — wrap `PUT /v1/me/player` to push playback onto a specific device. Useful when a user has multiple Spotify clients open.
- **Search multiple results** — change `searchTopTrack` to return the top N tracks and let the agent pick. Requires adjusting the `play` and `queue` schemas to accept an `index` argument.

## Troubleshooting

- **`No active Spotify device`** — open Spotify on any device first. The Web API can only control devices Spotify already knows are online.
- **OAuth consent screen says "Insufficient client scope"** — re-deploy after editing the `scope` string, then re-run `ntn workers oauth start spotifyAuth`. New scopes require re-consent.
- **`invalid_grant` during `oauth start`** — the redirect URI in the Spotify Dashboard doesn't match the worker's. Run `ntn workers oauth show-redirect-url` again and paste exactly (including trailing slash, if any).
- **Playback doesn't switch** — Spotify Free accounts can't be controlled by the Web API. The user needs Spotify Premium.

## Learn more

- [Notion Workers documentation](https://developers.notion.com/workers/get-started/overview)
- [Tools guide](https://developers.notion.com/workers/guides/tools)
- [OAuth guide](https://developers.notion.com/workers/guides/oauth)
- [Spotify Web API reference](https://developer.spotify.com/documentation/web-api)
- [Contribute to this cookbook](../../../../CONTRIBUTING.md)
