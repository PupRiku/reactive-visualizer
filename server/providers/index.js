/**
 * v1.2 Stage 3 — provider seam.
 *
 * The music-service integration sits behind one small interface so a second
 * service later (Apple Music, YouTube Music…) is a new implementation, not a
 * refactor of the endpoints. The active provider is chosen by config
 * (PROVIDER env var, default 'spotify'); the /api routes only ever call the
 * active provider, never Spotify by name.
 *
 * Provider interface:
 *   meta                              { id, label, openLabel, addLabel, connectLabel, track:{uriTemplate,urlTemplate} }
 *   isConfigured()  -> boolean        OAuth credentials present
 *   isConnected()   -> boolean        user has authorized (refresh token held)
 *   authorizeUrl(state) -> string     where to send the browser to grant access
 *   exchangeCode(code) -> Promise     swap code for tokens, persist them
 *   listPlaylists() -> Promise<[{id,name}]>
 *   createPlaylist(name) -> Promise<{id,name}>
 *   addToPlaylist(playlistId, trackId) -> Promise<{ok}>
 *
 * openTrack is the one method that lives on the CLIENT (deep-linking happens in
 * the browser); the client reads meta.track's templates to build the links, so
 * it is not hardcoded to Spotify either.
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { SpotifyProvider } from './spotify.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Build the active provider from env config. Called once at startup.
 * @param {number} port  Backend port, used to derive the default redirect URI.
 */
export function createProvider(port) {
  const which = (process.env.PROVIDER || 'spotify').toLowerCase()

  if (which === 'spotify') {
    return new SpotifyProvider({
      clientId: process.env.SPOTIFY_CLIENT_ID || '',
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
      // Spotify requires an exact match to a URI registered in the dashboard.
      // Loopback must use 127.0.0.1 (not "localhost") per Spotify's rules.
      redirectUri: process.env.SPOTIFY_REDIRECT_URI || `http://127.0.0.1:${port}/callback`,
      tokenFile: join(__dirname, '..', '.spotify-tokens.json'),
    })
  }

  throw new Error(`Unknown PROVIDER "${which}". Supported: spotify.`)
}
