/**
 * v1.2 Stage 1 — snippet capture + recognition request (client side).
 *
 * On demand ('i' hotkey), we record a short clip from the ALREADY-captured
 * system-audio stream (src/audio/capture.ts) and POST it to our local backend's
 * /api/identify, which attaches the AudD token server-side and returns a match.
 *
 * Deliberately NOT a rolling buffer: MediaRecorder emits webm where only the
 * first chunk carries the container header, so concatenating chunks from a
 * long-running recorder yields an undecodable file. We instead start a fresh
 * recorder on each trigger and stop it after SNIPPET_MS, producing one complete,
 * self-contained webm. (An instant, zero-wait path via a PCM ring buffer encoded
 * to WAV is a later refinement, not this stage.)
 */

/** How long to record before sending. ~8s is plenty for AudD to fingerprint. */
const SNIPPET_MS = 8000

/** Cleaned recognition result, mirrors the backend's `track` shape. */
export interface IdentifiedTrack {
  title: string | null
  artist: string | null
  album: string | null
  releaseDate: string | null
  label: string | null
  songLink: string | null
  artwork: string | null
  streaming: {
    spotify: { id: string | null; url: string | null; uri: string | null } | null
    appleMusic: { url: string | null } | null
    deezer: { id: string | null; url: string | null } | null
  }
}

export type IdentifyResult =
  | { status: 'ok'; track: IdentifiedTrack }
  | { status: 'not_found' }
  | { status: 'error'; message: string }

/** Pick a webm MIME the browser can actually record, or fall back to default. */
function pickMimeType(): string | undefined {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm']
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) {
      return type
    }
  }
  return undefined
}

/**
 * Record SNIPPET_MS of audio from `stream` and resolve to a single complete blob.
 * Rejects if the stream has no audio track or recording fails to produce data.
 */
function recordSnippet(stream: MediaStream): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (stream.getAudioTracks().length === 0) {
      reject(new Error('The captured stream has no audio track to record.'))
      return
    }

    const mimeType = pickMimeType()
    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    } catch (err) {
      reject(err instanceof Error ? err : new Error('Could not start MediaRecorder.'))
      return
    }

    const chunks: BlobPart[] = []
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data)
    }
    recorder.onerror = () => reject(new Error('Recording failed.'))
    recorder.onstop = () => {
      if (chunks.length === 0) {
        reject(new Error('No audio was recorded — is anything playing?'))
        return
      }
      resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }))
    }

    recorder.start()
    // Single stop after the window — one contiguous, header-complete file.
    window.setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop()
    }, SNIPPET_MS)
  })
}

/**
 * Full identify flow: record a snippet from the live capture stream, POST it to
 * the backend, and return the cleaned result. Never throws — network/record
 * failures come back as { status: 'error', message }.
 */
export async function identifyFromStream(stream: MediaStream): Promise<IdentifyResult> {
  let blob: Blob
  try {
    blob = await recordSnippet(stream)
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : 'Could not record an audio snippet.',
    }
  }

  try {
    const res = await fetch('/api/identify', {
      method: 'POST',
      // Raw bytes; the backend reads them with express.raw and forwards to AudD.
      headers: { 'Content-Type': blob.type || 'audio/webm' },
      body: blob,
    })
    const data = (await res.json()) as IdentifyResult
    return data
  } catch {
    return {
      status: 'error',
      message: 'Could not reach the local backend. Is it running (npm run dev:all)?',
    }
  }
}

export { SNIPPET_MS }
