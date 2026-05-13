// Spotify Control — agent tools for Spotify playback.
//
// Five tools that wrap the Spotify Web API:
//
//   - play(query?, uri?) — start playback; resolves a natural-language
//     query to a track URI via the search API when needed.
//   - pause() — pause playback.
//   - skip(direction) — skip to the next or previous track.
//   - queue(query?, uri?) — append to the queue.
//   - nowPlaying() — return the currently playing track.
//
// Auth is OAuth 2.0 Authorization Code Flow. Each Notion user authorizes
// their own Spotify account; `accessToken()` returns the calling user's
// token, so the controls always act on whoever invoked the agent.

import { Worker } from "@notionhq/workers"
import { j } from "@notionhq/workers/schema-builder"
import {
  nowPlaying,
  pause,
  playTrack,
  queueTrack,
  searchTopTrack,
  skip,
} from "./spotify.js"

const worker = new Worker()
export default worker

const spotifyAuth = worker.oauth("spotifyAuth", {
  name: "spotify",
  authorizationEndpoint: "https://accounts.spotify.com/authorize",
  tokenEndpoint: "https://accounts.spotify.com/api/token",
  scope:
    "user-read-playback-state user-modify-playback-state user-read-currently-playing",
  clientId: process.env.SPOTIFY_CLIENT_ID ?? "",
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET ?? "",
})

// Resolve a (query|uri) pair to a concrete Spotify track URI. Shared by
// `play` and `queue` so the two tools behave consistently.
async function resolveTrackUri(
  token: string,
  query: string | null,
  uri: string | null
) {
  if (uri) {
    return { uri, resolved: null as { name: string; artist: string } | null }
  }
  if (!query) {
    throw new Error(
      "Provide either `query` (natural language) or `uri` (a Spotify track URI)."
    )
  }
  const top = await searchTopTrack(token, query)
  return {
    uri: top.uri,
    resolved: {
      name: top.name,
      artist: top.artists[0]?.name ?? "",
    },
  }
}

worker.tool("play", {
  title: "Play music on Spotify",
  description:
    "Start Spotify playback. Provide either a natural-language search query (e.g. 'Bohemian Rhapsody by Queen') or an explicit Spotify track URI. The user must have Spotify open on a device (phone, desktop, or web player).",
  schema: j.object({
    query: j
      .string()
      .nullable()
      .describe(
        "Natural-language search query. Used when `uri` is not provided; the top search result plays."
      ),
    uri: j
      .string()
      .nullable()
      .describe(
        "A Spotify track URI of the form `spotify:track:<id>`. Skips the search step."
      ),
  }),
  execute: async ({ query, uri }) => {
    const token = await spotifyAuth.accessToken()
    const { uri: trackUri, resolved } = await resolveTrackUri(token, query, uri)
    await playTrack(token, trackUri)
    return {
      uri: trackUri,
      name: resolved?.name ?? null,
      artist: resolved?.artist ?? null,
    }
  },
})

worker.tool("pause", {
  title: "Pause Spotify",
  description: "Pause the user's Spotify playback.",
  schema: j.object({}),
  execute: async () => {
    const token = await spotifyAuth.accessToken()
    await pause(token)
    return { paused: true }
  },
})

worker.tool("skip", {
  title: "Skip Spotify track",
  description:
    "Skip to the next or previous track in the user's Spotify queue.",
  schema: j.object({
    direction: j
      .enum("next", "previous")
      .nullable()
      .describe("Direction to skip. Defaults to `next`."),
  }),
  execute: async ({ direction }) => {
    const token = await spotifyAuth.accessToken()
    const dir = direction ?? "next"
    await skip(token, dir)
    return { skipped: dir }
  },
})

worker.tool("queue", {
  title: "Queue a Spotify track",
  description:
    "Append a track to the user's Spotify queue. Like `play`, accepts either a search query or a track URI.",
  schema: j.object({
    query: j.string().nullable().describe("Natural-language search query."),
    uri: j.string().nullable().describe("Spotify track URI."),
  }),
  execute: async ({ query, uri }) => {
    const token = await spotifyAuth.accessToken()
    const { uri: trackUri, resolved } = await resolveTrackUri(token, query, uri)
    await queueTrack(token, trackUri)
    return {
      uri: trackUri,
      name: resolved?.name ?? null,
      artist: resolved?.artist ?? null,
    }
  },
})

worker.tool("nowPlaying", {
  title: "What's playing on Spotify",
  description: "Return the user's currently playing track, if any.",
  schema: j.object({}),
  execute: async () => {
    const token = await spotifyAuth.accessToken()
    const current = await nowPlaying(token)
    if (!current?.item) {
      return {
        playing: false,
        name: null,
        artist: null,
        album: null,
        progressMs: null,
        durationMs: null,
      }
    }
    return {
      playing: current.is_playing,
      name: current.item.name,
      artist: current.item.artists[0]?.name ?? "",
      album: current.item.album.name,
      progressMs: current.progress_ms ?? 0,
      durationMs: current.item.duration_ms,
    }
  },
})
