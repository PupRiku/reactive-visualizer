/**
 * v1.2 Stage 3 — Spotify provider (backend implementation of the provider seam).
 *
 * All Spotify secrets and tokens live HERE, in the backend, and never reach the
 * browser: the client id/secret come from server/.env, and the OAuth tokens are
 * persisted to a gitignored file (server/.spotify-tokens.json). The browser only
 * ever talks to our own /api/spotify/* endpoints.
 *
 * This is the single implementation of the provider interface (see
 * providers/index.js for the shape). A second service later (Apple, YouTube…)
 * becomes a new file implementing the same methods — not a refactor here.
 *
 * OAuth: Authorization Code flow.
 *   - authorizeUrl(state) -> where we send the browser to grant access
 *   - exchangeCode(code)  -> swap the returned code for access + refresh tokens
 *   - getAccessToken()    -> valid bearer token, auto-refreshing when expired
 * Data:
 *   - listPlaylists() / createPlaylist(name) / addToPlaylist(id, trackId)
 */

import fs from 'node:fs'

const ACCOUNTS = 'https://accounts.spotify.com'
const API = 'https://api.spotify.com/v1'
const SCOPES = ['playlist-modify-public', 'playlist-modify-private', 'playlist-read-private']

export class SpotifyProvider {
  /**
   * @param {object} cfg
   * @param {string} cfg.clientId
   * @param {string} cfg.clientSecret
   * @param {string} cfg.redirectUri  Must match a URI registered in the Spotify app.
   * @param {string} cfg.tokenFile    Absolute path to the gitignored token store.
   */
  constructor({ clientId, clientSecret, redirectUri, tokenFile }) {
    this.id = 'spotify'
    this.clientId = clientId
    this.clientSecret = clientSecret
    this.redirectUri = redirectUri
    this.tokenFile = tokenFile

    // Client-facing labels + deep-link templates. The widget reads these so its
    // buttons are not hardcoded to "Spotify" — a different provider ships its own.
    this.meta = {
      id: 'spotify',
      label: 'Spotify',
      openLabel: 'Open in Spotify',
      addLabel: 'Add to Playlist',
      connectLabel: 'Connect Spotify',
      track: {
        // {id} is the streaming track id stored on the identified song.
        uriTemplate: 'spotify:track:{id}',
        urlTemplate: 'https://open.spotify.com/track/{id}',
      },
    }

    /** @type {{access_token?:string, refresh_token?:string, expires_at?:number}} */
    this.tokens = this.#loadTokens()
    this.#userId = null // cached /v1/me id, resolved lazily
  }

  #userId

  /** True when OAuth credentials are configured (regardless of connect state). */
  isConfigured() {
    return Boolean(this.clientId && this.clientSecret && this.redirectUri)
  }

  /** True when we hold a refresh token, i.e. the user has authorized once. */
  isConnected() {
    return Boolean(this.tokens.refresh_token)
  }

  /** Space-separated list of scopes Spotify granted on the stored token. */
  grantedScope() {
    return this.tokens.scope || ''
  }

  /** Whether the stored token can create/modify playlists. */
  #canModify() {
    const s = this.grantedScope()
    return s.includes('playlist-modify-public') || s.includes('playlist-modify-private')
  }

  /**
   * Throw a clear, actionable error if the token lacks write scopes, so a scope
   * problem surfaces as "reconnect" guidance instead of a raw Spotify 403.
   */
  #requireModifyScope() {
    if (!this.#canModify()) {
      const err = new Error(
        `The Spotify token is missing playlist-modify permission (granted: "${this.grantedScope()}" ). ` +
          `Click Disconnect, then Connect and approve on the consent screen.`,
      )
      err.code = 'MISSING_SCOPE'
      throw err
    }
  }

  /** The URL to redirect the browser to so the user can grant access. */
  authorizeUrl(state) {
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      scope: SCOPES.join(' '),
      state,
      // Force the consent screen every time. Without this, Spotify may reuse a
      // prior grant for this app that lacks the modify scopes, handing back a
      // token that can read playlists but 403s on create/add.
      show_dialog: 'true',
    })
    return `${ACCOUNTS}/authorize?${params.toString()}`
  }

  /**
   * Exchange the authorization code for tokens and persist them. Returns the
   * space-separated list of scopes Spotify actually granted (for diagnostics).
   */
  async exchangeCode(code) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
    })
    const data = await this.#tokenRequest(body)
    this.tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
      scope: data.scope || '',
    }
    this.#saveTokens()
    return data.scope || ''
  }

  /** Drop the stored tokens so the user can re-authorize (e.g. to fix scopes). */
  disconnect() {
    this.tokens = {}
    this.#userId = null
    try {
      fs.rmSync(this.tokenFile, { force: true })
    } catch {
      /* nothing to remove */
    }
  }

  /**
   * Return a valid access token, refreshing it first if it is missing or within
   * 60s of expiry. Throws NOT_CONNECTED if the user has never authorized.
   */
  async getAccessToken() {
    if (!this.isConnected()) {
      const err = new Error('Spotify is not connected. Authorize first.')
      err.code = 'NOT_CONNECTED'
      throw err
    }
    const stillValid = this.tokens.access_token && this.tokens.expires_at - 60_000 > Date.now()
    if (stillValid) return this.tokens.access_token

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refresh_token,
    })
    const data = await this.#tokenRequest(body)
    this.tokens.access_token = data.access_token
    this.tokens.expires_at = Date.now() + data.expires_in * 1000
    // Spotify only sometimes returns a rotated refresh token; keep the old one
    // if this response omits it, or auth silently breaks on the next restart.
    if (data.refresh_token) this.tokens.refresh_token = data.refresh_token
    this.#saveTokens()
    return this.tokens.access_token
  }

  /**
   * List the playlists the user can actually add to — ones they own or that are
   * collaborative. Followed playlists (and Spotify-generated ones) are excluded
   * because adding to them returns 403.
   */
  async listPlaylists() {
    const meId = await this.#me()
    const out = []
    let url = `${API}/me/playlists?limit=50`
    // Page through, but cap at a few hundred so we never loop unbounded.
    for (let i = 0; i < 6 && url; i++) {
      const data = await this.#api(url)
      for (const p of data.items || []) {
        if (p.owner?.id === meId || p.collaborative) out.push({ id: p.id, name: p.name })
      }
      url = data.next
    }
    return out
  }

  /** Create a new (private by default) playlist and return { id, name }. */
  async createPlaylist(name) {
    this.#requireModifyScope()
    const userId = await this.#me()
    const data = await this.#api(`${API}/users/${encodeURIComponent(userId)}/playlists`, {
      method: 'POST',
      json: { name, public: false },
    })
    return { id: data.id, name: data.name }
  }

  /** Add one track to a playlist. Returns { ok: true }. */
  async addToPlaylist(playlistId, trackId) {
    this.#requireModifyScope()
    await this.#api(`${API}/playlists/${encodeURIComponent(playlistId)}/tracks`, {
      method: 'POST',
      json: { uris: [`spotify:track:${trackId}`] },
    })
    return { ok: true }
  }

  // --- internals -----------------------------------------------------------

  /** Cached current-user id (needed to create playlists). */
  async #me() {
    if (this.#userId) return this.#userId
    const me = await this.#api(`${API}/me`)
    this.#userId = me.id
    return this.#userId
  }

  /** Authenticated Spotify API call returning parsed JSON (or {} for 201/204). */
  async #api(url, { method = 'GET', json } = {}) {
    const token = await this.getAccessToken()
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(json ? { 'Content-Type': 'application/json' } : {}),
      },
      body: json ? JSON.stringify(json) : undefined,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const err = new Error(`Spotify API ${res.status}: ${text || res.statusText}`)
      err.status = res.status
      throw err
    }
    if (res.status === 204 || res.status === 201) {
      // Some endpoints (add-tracks) return a snapshot body; try to parse, ignore if empty.
      return res.json().catch(() => ({}))
    }
    return res.json()
  }

  /** POST to the token endpoint with HTTP Basic (client id/secret) auth. */
  async #tokenRequest(body) {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')
    const res = await fetch(`${ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(
        `Spotify token request failed (${res.status}): ${data.error_description || data.error || 'unknown'}`,
      )
    }
    return data
  }

  #loadTokens() {
    try {
      return JSON.parse(fs.readFileSync(this.tokenFile, 'utf8'))
    } catch {
      return {} // no file yet — not connected
    }
  }

  #saveTokens() {
    // 0600-ish: best effort. The file is gitignored regardless.
    fs.writeFileSync(this.tokenFile, JSON.stringify(this.tokens, null, 2), { mode: 0o600 })
  }
}
