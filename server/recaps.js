/**
 * v1.2 Stage 2 — recaps (set-list memory + file export).
 *
 * A tiny append-only set-list logger that lives entirely in the LOCAL backend.
 * On startup we open one timestamped session file under recaps/ at the project
 * root and write a small header. Every successfully identified song is appended
 * to that file IMMEDIATELY — the file is always current and survives a crash, so
 * there is no "on close" save to lose (browsers can't reliably do that anyway).
 *
 * Dedupe rule: only against the MOST RECENT entry. A song identified twice in a
 * row is logged once; the same song returning later in the set (after other
 * songs) gets its own new line. We never dedupe against the whole list.
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
// recaps/ sits at the project root — one level up from server/.
const RECAPS_DIR = join(__dirname, '..', 'recaps')

let sessionFile = null // absolute path to the current session's file
let lastKey = null // dedupe key of the most recently logged song

/** Zero-pad a number to two digits (local-time formatting helper). */
function pad2(n) {
  return String(n).padStart(2, '0')
}

/** "2026-07-03_1435" — used for the session filename (local time). */
function fileStamp(d) {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `_${pad2(d.getHours())}${pad2(d.getMinutes())}`
  )
}

/** "21:34" — the per-song timestamp shown in each set-list line (local time). */
function timeStamp(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** "Artist - Title", or just the title when the artist is unknown. */
function formatSong(track) {
  const title = (track.title ?? '').trim() || 'Unknown title'
  const artist = (track.artist ?? '').trim()
  return artist ? `${artist} - ${title}` : title
}

/**
 * Open a new session file with a header. Called once on backend startup. Creates
 * recaps/ if it does not exist. Returns the file path (for logging).
 */
export function startSession() {
  const now = new Date()
  fs.mkdirSync(RECAPS_DIR, { recursive: true })
  sessionFile = join(RECAPS_DIR, `${fileStamp(now)}.txt`)
  lastKey = null

  const header =
    `Reactive Visualizer — set list\n` +
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}\n` +
    `${'='.repeat(30)}\n`
  // Use 'a' (append) so re-running with an identical minute stamp never clobbers
  // an existing set list — extremely unlikely, but harmless to guard against.
  fs.appendFileSync(sessionFile, header, 'utf8')
  return sessionFile
}

/**
 * Append one identified song to the current session file, unless it duplicates
 * the immediately preceding entry. Returns true if a line was written, false if
 * it was skipped as a consecutive duplicate. No-match results must never reach
 * this function (the caller only invokes it on a successful match).
 */
export function appendSong(track) {
  if (!sessionFile) startSession() // defensive: should already be open

  const song = formatSong(track)
  const key = song.toLowerCase()
  if (key === lastKey) return false // same as the most recent entry — skip

  const line = `${timeStamp(new Date())}  ${song}\n`
  fs.appendFileSync(sessionFile, line, 'utf8')
  lastKey = key
  return true
}

/** Current session file path (or null before startSession). For diagnostics. */
export function currentSessionFile() {
  return sessionFile
}
