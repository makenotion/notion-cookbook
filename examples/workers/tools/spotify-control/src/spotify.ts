import type {
  CurrentlyPlayingResponse,
  SpotifySearchResponse,
  SpotifyTrack,
} from "./types.js"

const SPOTIFY_API = "https://api.spotify.com"

// Spotify returns this error reason when there's no Spotify client open
// on any of the user's devices. We translate it to a clearer message so
// the agent can tell the user what to do.
const NO_ACTIVE_DEVICE = "NO_ACTIVE_DEVICE"

async function spotifyFetch(
  token: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const res = await fetch(`${SPOTIFY_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  })

  if (res.status === 404) {
    // Spotify returns 404 both for missing resources and for "no
    // active device." Inspect the body to disambiguate.
    const body = await res.clone().text()
    if (body.includes(NO_ACTIVE_DEVICE)) {
      throw new Error(
        "No active Spotify device. Open Spotify on your phone, desktop, or web player and try again."
      )
    }
  }

  if (!res.ok && res.status !== 204) {
    throw new Error(`Spotify API error: ${res.status} ${await res.text()}`)
  }

  return res
}

export async function searchTopTrack(
  token: string,
  query: string
): Promise<SpotifyTrack> {
  const params = new URLSearchParams({
    q: query,
    type: "track",
    limit: "1",
  })
  const res = await spotifyFetch(token, `/v1/search?${params.toString()}`)
  const data = (await res.json()) as SpotifySearchResponse
  const top = data.tracks.items[0]
  if (!top) {
    throw new Error(`No Spotify track found for "${query}".`)
  }
  return top
}

export async function playTrack(token: string, uri: string): Promise<void> {
  await spotifyFetch(token, "/v1/me/player/play", {
    method: "PUT",
    body: JSON.stringify({ uris: [uri] }),
  })
}

export async function pause(token: string): Promise<void> {
  await spotifyFetch(token, "/v1/me/player/pause", { method: "PUT" })
}

export async function skip(
  token: string,
  direction: "next" | "previous"
): Promise<void> {
  await spotifyFetch(token, `/v1/me/player/${direction}`, {
    method: "POST",
  })
}

export async function queueTrack(token: string, uri: string): Promise<void> {
  const params = new URLSearchParams({ uri })
  await spotifyFetch(token, `/v1/me/player/queue?${params.toString()}`, {
    method: "POST",
  })
}

export async function nowPlaying(
  token: string
): Promise<CurrentlyPlayingResponse | null> {
  const res = await spotifyFetch(token, "/v1/me/player/currently-playing")
  // 204 = no track currently active for the user.
  if (res.status === 204) return null
  return (await res.json()) as CurrentlyPlayingResponse
}
