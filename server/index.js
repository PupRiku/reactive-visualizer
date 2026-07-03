/**
 * v1.2 Stage 1 — local recognition backend.
 *
 * A tiny Express server that runs on your own machine alongside Vite. Its only
 * job in this stage is to proxy the music-recognition call: the browser records
 * a short audio snippet and POSTs it here, this server attaches the AudD API
 * token SERVER-SIDE (so it never ships to the browser), forwards the audio to
 * AudD, and returns cleaned-up JSON.
 *
 * Why a local server and not a browser fetch straight to AudD:
 *   1. The API token must stay secret — in the browser it would be visible to
 *      anyone viewing source / network. It lives only in server/.env here.
 *   2. CORS — AudD does not send CORS headers for browser origins. The browser
 *      calls /api/identify same-origin (Vite proxies it here), so there is no
 *      cross-origin request from the page at all.
 *
 * v1.2 Stage 2 adds recap persistence: each successful match is appended to a
 * timestamped set-list file under recaps/ (see recaps.js). Stage 3 will add
 * Spotify OAuth to this same server.
 */

import express from 'express'
import dotenv from 'dotenv'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { startSession, appendSong } from './recaps.js'
import { createProvider } from './providers/index.js'

// Load server/.env regardless of the cwd the process was launched from.
const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dirname, '.env') })

const PORT = Number(process.env.PORT) || 8787

// The active music-service provider (Spotify for now). All streaming-link and
// playlist features go through this seam — the routes never name Spotify.
const provider = createProvider(PORT)
const AUDD_TOKEN = process.env.AUDD_TOKEN
const AUDD_ENDPOINT = 'https://api.audd.io/'

// Streaming IDs we ask AudD to include on a match. We request all three now so
// later stages (Open in / Add to playlist for Spotify, and other providers) can
// use them without ever re-identifying a song.
const AUDD_RETURN = 'spotify,apple_music,deezer'

const app = express()

// The browser sends the raw recorded audio blob as the request body. Collect it
// as a Buffer for any audio content-type. 25 MB is far more than an ~8s clip.
app.use('/api/identify', express.raw({ type: () => true, limit: '25mb' }))

/**
 * POST /api/identify
 * Body: raw audio bytes (audio/webm from the browser's MediaRecorder).
 * Returns: { status, track? , message? }
 *   status: 'ok'        -> track populated
 *           'not_found' -> AudD had no match
 *           'error'     -> something went wrong (message explains)
 */
app.post('/api/identify', async (req, res) => {
  if (!AUDD_TOKEN) {
    return res.status(500).json({
      status: 'error',
      message:
        'AUDD_TOKEN is not set. Copy server/.env.example to server/.env and add your AudD API token.',
    })
  }

  const audio = req.body
  if (!Buffer.isBuffer(audio) || audio.length === 0) {
    return res
      .status(400)
      .json({ status: 'error', message: 'Empty request body — no audio snippet received.' })
  }

  try {
    // Build the multipart form AudD expects. Node's global FormData/Blob/fetch
    // (Node 18+) let us do this with no extra dependencies.
    const form = new FormData()
    form.append('api_token', AUDD_TOKEN)
    form.append('return', AUDD_RETURN)
    form.append(
      'file',
      new Blob([audio], { type: req.headers['content-type'] || 'audio/webm' }),
      'snippet.webm',
    )

    const auddRes = await fetch(AUDD_ENDPOINT, { method: 'POST', body: form })
    const data = await auddRes.json()

    // AudD signals its own errors in the JSON body (HTTP is still 200).
    if (data.status === 'error') {
      const msg = data.error?.error_message || 'AudD returned an error.'
      console.error('[identify] AudD error:', data.error)
      return res.status(502).json({ status: 'error', message: msg })
    }

    // No match: AudD returns { status: 'success', result: null }.
    if (!data.result) {
      return res.json({ status: 'not_found' })
    }

    const track = cleanResult(data.result)
    // Persist to the set list immediately (deduped against the last entry).
    // Never let a recap write failure break the identify response.
    try {
      if (appendSong(track)) {
        console.log(`[recap] ${track.artist ?? 'Unknown'} - ${track.title ?? 'Unknown'}`)
      }
    } catch (recapErr) {
      console.error('[recap] failed to append song:', recapErr)
    }
    return res.json({ status: 'ok', track })
  } catch (err) {
    console.error('[identify] request failed:', err)
    return res
      .status(502)
      .json({ status: 'error', message: 'Failed to reach the recognition service.' })
  }
})

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', tokenConfigured: Boolean(AUDD_TOKEN) })
})

// --- Provider seam + streaming service (Stage 3) ---------------------------
//
// The browser talks only to these same-origin endpoints; the provider attaches
// all secrets/tokens server-side. `provider` is config-selected (Spotify now).

// JSON body parsing, scoped to the provider POST routes so it never touches the
// raw-audio /api/identify handler above.
const json = express.json()

// Pending OAuth CSRF states. A login mints one; the callback must present it
// back. In-memory is fine for a single-user local tool.
const pendingStates = new Set()

/** Public provider metadata the widget needs (labels, deep-link templates). */
app.get('/api/provider', (_req, res) => {
  res.json({ ...provider.meta, oauthConfigured: provider.isConfigured() })
})

/** Whether the user has authorized the provider (linked) this machine. */
app.get('/api/spotify/status', (_req, res) => {
  res.json({
    configured: provider.isConfigured(),
    connected: provider.isConnected(),
    // Granted scopes, for diagnosing 403s (empty until re-authorized).
    scope: provider.grantedScope?.() ?? '',
  })
})

/** Kick off the OAuth flow: redirect the browser to the provider's consent page. */
app.get('/api/spotify/login', (_req, res) => {
  if (!provider.isConfigured()) {
    return res
      .status(500)
      .send('Spotify is not configured. Set SPOTIFY_CLIENT_ID/SECRET in server/.env.')
  }
  const state = crypto.randomBytes(16).toString('hex')
  pendingStates.add(state)
  // Expire unused states so the set cannot grow without bound.
  setTimeout(() => pendingStates.delete(state), 10 * 60_000).unref?.()
  res.redirect(provider.authorizeUrl(state))
})

/**
 * OAuth redirect target. Spotify sends the browser here (directly to the backend
 * origin, matching the registered redirect URI) with ?code&state. We verify the
 * state, exchange the code for tokens, and show a tiny self-closing page.
 */
app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query
  if (error) return res.status(400).send(callbackPage(`Authorization failed: ${error}`))
  if (!state || !pendingStates.has(String(state))) {
    return res.status(400).send(callbackPage('Invalid or expired state. Please try again.'))
  }
  pendingStates.delete(String(state))
  try {
    const granted = await provider.exchangeCode(String(code))
    console.log(`[spotify] connected; granted scopes: ${granted || '(none reported)'}`)
    res.send(callbackPage('Spotify connected. You can close this tab and return to the app.'))
  } catch (err) {
    console.error('[spotify] token exchange failed:', err)
    res.status(502).send(callbackPage('Could not complete Spotify authorization.'))
  }
})

/** Drop the stored authorization so the user can re-link (e.g. fix scopes). */
app.post('/api/spotify/logout', (_req, res) => {
  provider.disconnect?.()
  res.json({ ok: true })
})

/** The user's playlists for the target dropdown. */
app.get('/api/spotify/playlists', async (_req, res) => {
  try {
    res.json({ playlists: await provider.listPlaylists() })
  } catch (err) {
    sendProviderError(res, err)
  }
})

/** Create a new (private) playlist and return { id, name }. */
app.post('/api/spotify/playlists', json, async (req, res) => {
  const name = (req.body?.name || '').trim()
  if (!name) return res.status(400).json({ error: 'A playlist name is required.' })
  try {
    res.json(await provider.createPlaylist(name))
  } catch (err) {
    sendProviderError(res, err)
  }
})

/** Add one track to a playlist: body { trackId, playlistId }. */
app.post('/api/spotify/add', json, async (req, res) => {
  const { trackId, playlistId } = req.body || {}
  if (!trackId || !playlistId) {
    return res.status(400).json({ error: 'trackId and playlistId are required.' })
  }
  try {
    await provider.addToPlaylist(playlistId, trackId)
    res.json({ ok: true })
  } catch (err) {
    sendProviderError(res, err)
  }
})

const server = app.listen(PORT, () => {
  console.log(`[server] recognition backend listening on http://localhost:${PORT}`)
  // Open a fresh set-list file for this session. Songs append to it as they are
  // identified, so it is always current and survives a crash — no shutdown save.
  const file = startSession()
  console.log(`[server] recap session started: ${file}`)
  console.log(
    `[server] provider: ${provider.meta.id} — ` +
      `${provider.isConfigured() ? (provider.isConnected() ? 'connected' : 'configured, not linked') : 'not configured'}`,
  )
  if (!AUDD_TOKEN) {
    console.warn(
      '[server] WARNING: AUDD_TOKEN is not set. /api/identify will return an error until you ' +
        'create server/.env with AUDD_TOKEN=...',
    )
  }
})

// If the port is already taken (usually a stray backend from a previous run that
// did not exit cleanly), print a friendly, actionable message and exit quietly
// instead of dumping an unhandled-error stack trace.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[server] Port ${PORT} is already in use — another backend is probably still ` +
        `running.\n` +
        `[server] Free it with (PowerShell):\n` +
        `[server]   Get-NetTCPConnection -LocalPort ${PORT} -State Listen | ` +
        `ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }\n` +
        `[server] then run "npm run dev:all" again. (Or set PORT in server/.env to a free port.)`,
    )
    process.exit(1)
  }
  throw err
})

/** Map a provider error to a sensible HTTP status + JSON for the widget. */
function sendProviderError(res, err) {
  if (err.code === 'NOT_CONNECTED') {
    return res.status(401).json({ error: 'not_connected' })
  }
  // Missing write scope — caught before we even call Spotify.
  if (err.code === 'MISSING_SCOPE') {
    console.error(`[spotify] ${err.message}`)
    return res.status(403).json({ error: err.message })
  }
  console.error('[spotify] request failed:', err)
  if (err.status === 403) {
    // Scopes are present (preflight passed) but Spotify still refused — this is
    // an app-side restriction, not a scope problem. Log the granted scopes.
    console.error(`[spotify] granted scopes were: "${provider.grantedScope?.() ?? ''}"`)
    return res.status(403).json({
      error:
        'Spotify refused the write (403) even though the token has modify scopes. This is usually ' +
        'a Spotify app restriction — check the app in the dashboard (Development Mode + your ' +
        'account under User Management), or pick a playlist you own.',
    })
  }
  return res.status(502).json({ error: err.message || 'Provider request failed.' })
}

/** Minimal HTML shown in the OAuth popup after the redirect back. */
function callbackPage(message) {
  return (
    `<!doctype html><meta charset="utf-8"><title>Spotify</title>` +
    `<body style="font-family:system-ui;background:#0b0e16;color:#e8ecf5;` +
    `display:flex;align-items:center;justify-content:center;height:100vh;margin:0">` +
    `<p style="max-width:32ch;text-align:center;line-height:1.6">${message}</p>` +
    `<script>setTimeout(function(){window.close()},2500)</script></body>`
  )
}

/**
 * Reshape AudD's verbose result into the compact object the widget needs, while
 * keeping every streaming ID/URL AudD gave us for later stages. Any field AudD
 * omits comes back as null rather than throwing.
 */
function cleanResult(r) {
  const spotify = r.spotify || null
  const apple = r.apple_music || null
  const deezer = r.deezer || null

  return {
    title: r.title ?? null,
    artist: r.artist ?? null,
    album: r.album ?? null,
    releaseDate: r.release_date ?? null,
    label: r.label ?? null,
    // AudD's own page for the song — a decent universal fallback link.
    songLink: r.song_link ?? null,
    artwork: pickArtwork(spotify, apple, deezer),
    streaming: {
      spotify: spotify
        ? {
            id: spotify.id ?? null,
            url: spotify.external_urls?.spotify ?? null,
            uri: spotify.uri ?? (spotify.id ? `spotify:track:${spotify.id}` : null),
          }
        : null,
      appleMusic: apple ? { url: apple.url ?? null } : null,
      deezer: deezer ? { id: deezer.id ?? null, url: deezer.link ?? null } : null,
    },
  }
}

/** Best available artwork thumbnail across the providers AudD returned. */
function pickArtwork(spotify, apple, deezer) {
  // Spotify album images are ordered largest-first; take a middle/smaller one.
  const spImgs = spotify?.album?.images
  if (Array.isArray(spImgs) && spImgs.length) {
    return (spImgs[1] || spImgs[0]).url ?? null
  }
  // Apple artwork URLs are templates with {w}x{h} placeholders.
  const appleArt = apple?.artwork?.url
  if (typeof appleArt === 'string') {
    return appleArt.replace('{w}', '300').replace('{h}', '300')
  }
  const dz = deezer?.album?.cover_medium || deezer?.album?.cover_big
  if (typeof dz === 'string') return dz
  return null
}
