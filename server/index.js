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
 * Later stages add recap file writing and Spotify OAuth to this same server.
 */

import express from 'express'
import dotenv from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Load server/.env regardless of the cwd the process was launched from.
const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dirname, '.env') })

const PORT = Number(process.env.PORT) || 8787
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

    return res.json({ status: 'ok', track: cleanResult(data.result) })
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

app.listen(PORT, () => {
  console.log(`[server] recognition backend listening on http://localhost:${PORT}`)
  if (!AUDD_TOKEN) {
    console.warn(
      '[server] WARNING: AUDD_TOKEN is not set. /api/identify will return an error until you ' +
        'create server/.env with AUDD_TOKEN=...',
    )
  }
})

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
