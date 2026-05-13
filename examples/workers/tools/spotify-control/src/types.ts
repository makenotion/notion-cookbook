// Minimal Spotify Web API response shapes we depend on. Full schemas at
// https://developer.spotify.com/documentation/web-api/reference

export interface SpotifyArtist {
  name: string
}

export interface SpotifyAlbum {
  name: string
}

export interface SpotifyTrack {
  uri: string
  name: string
  artists: SpotifyArtist[]
  album: SpotifyAlbum
  duration_ms: number
}

export interface SpotifySearchResponse {
  tracks: { items: SpotifyTrack[] }
}

export interface CurrentlyPlayingResponse {
  is_playing: boolean
  progress_ms: number | null
  item: SpotifyTrack | null
}
