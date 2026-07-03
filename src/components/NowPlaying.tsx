import { useCallback, useEffect, useRef, useState } from 'react'
import type { AudioCapture } from '../audio/capture'
import { identifyFromStream, type IdentifiedTrack } from '../song/identify'
import SpotifyActions from './SpotifyActions'

interface NowPlayingProps {
  /**
   * Live capture handle. We read its `stream` on demand to record a snippet —
   * reusing the existing system-audio capture, never re-prompting getDisplayMedia.
   */
  captureRef: React.RefObject<AudioCapture | null>
}

type Phase = 'hidden' | 'identifying' | 'result' | 'notfound' | 'error'

/** How long the tag stays fully lit before easing back to a subtle state. */
const DIM_AFTER_MS = 7000

/**
 * v1.2 Stage 1 — "now playing" tag.
 *
 * A small, unobtrusive bottom-right overlay. Press 'i' to identify the current
 * song from the captured system audio; it shows a brief "identifying…" state,
 * then fades in artwork + title + artist. After a few seconds it eases back to a
 * subtle, low-opacity state so it never competes with the visuals. On no match
 * it shows a quiet "no match" line. No buttons yet — those are later stages.
 */
export default function NowPlaying({ captureRef }: NowPlayingProps) {
  const [phase, setPhase] = useState<Phase>('hidden')
  const [track, setTrack] = useState<IdentifiedTrack | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [dimmed, setDimmed] = useState(false)
  // Hovering the tag cancels the subtle-dim so its buttons stay readable/usable.
  const [hovered, setHovered] = useState(false)

  // Guards against a second 'i' press while one identify is already in flight.
  const busyRef = useRef(false)
  const dimTimerRef = useRef<number | null>(null)

  const clearDimTimer = () => {
    if (dimTimerRef.current !== null) {
      window.clearTimeout(dimTimerRef.current)
      dimTimerRef.current = null
    }
  }

  const identify = useCallback(async () => {
    if (busyRef.current) return
    const capture = captureRef.current
    if (!capture) {
      // Nothing is being captured yet — say so briefly rather than silently.
      clearDimTimer()
      setDimmed(false)
      setMessage('Start capture first, then press "i".')
      setPhase('error')
      return
    }

    busyRef.current = true
    clearDimTimer()
    setDimmed(false)
    setMessage(null)
    setPhase('identifying')

    const result = await identifyFromStream(capture.stream)

    busyRef.current = false
    if (result.status === 'ok') {
      setTrack(result.track)
      setPhase('result')
    } else if (result.status === 'not_found') {
      setPhase('notfound')
    } else {
      setMessage(result.message)
      setPhase('error')
    }

    // Ease back to a subtle state after a few seconds (but keep it on screen).
    dimTimerRef.current = window.setTimeout(() => setDimmed(true), DIM_AFTER_MS)
  }, [captureRef])

  // 'i' hotkey — on-demand only, no polling. Ignores typing in form fields.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'i' && e.key !== 'I') return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      void identify()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [identify])

  useEffect(() => () => clearDimTimer(), [])

  if (phase === 'hidden') return null

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...containerStyle,
        opacity: dimmed && !hovered ? 0.4 : 1,
        // Only intercept clicks when there are buttons to press (result state),
        // so the passive states never sit on top of the visuals.
        pointerEvents: phase === 'result' ? 'auto' : 'none',
      }}
    >
      {phase === 'identifying' && (
        <div style={rowStyle}>
          <span style={{ ...dotStyle, animation: 'np-pulse 1s ease-in-out infinite' }} />
          <span style={secondaryText}>Identifying…</span>
        </div>
      )}

      {phase === 'notfound' && (
        <div style={rowStyle}>
          <span style={secondaryText}>No match found.</span>
        </div>
      )}

      {phase === 'error' && (
        <div style={rowStyle}>
          <span style={{ ...secondaryText, color: '#ffb4b4' }}>{message}</span>
        </div>
      )}

      {phase === 'result' && track && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={rowStyle}>
            {track.artwork ? (
              <img src={track.artwork} alt="" width={44} height={44} style={artStyle} />
            ) : (
              <div style={{ ...artStyle, ...artPlaceholder }}>♪</div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={eyebrowText}>Now playing</span>
              <span style={titleText}>{track.title ?? 'Unknown title'}</span>
              <span style={artistText}>{track.artist ?? 'Unknown artist'}</span>
            </div>
          </div>

          {/* Stage 3: Open in / Add to playlist. Reads labels from the provider. */}
          <SpotifyActions track={track} />
        </div>
      )}

      {/* Keyframes for the identifying pulse. Scoped by the np- prefix. */}
      <style>{'@keyframes np-pulse { 0%,100% { opacity: 0.3 } 50% { opacity: 1 } }'}</style>
    </div>
  )
}

const containerStyle: React.CSSProperties = {
  position: 'absolute',
  right: 16,
  bottom: 16,
  maxWidth: 320,
  padding: '10px 14px',
  background: 'rgba(10, 12, 20, 0.66)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 12,
  backdropFilter: 'blur(8px)',
  boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
  // Smooth the fade-in on mount and the ease-back to subtle.
  transition: 'opacity 700ms ease',
  pointerEvents: 'none',
  zIndex: 20,
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
}

const artStyle: React.CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: 8,
  objectFit: 'cover',
  flexShrink: 0,
  background: 'rgba(255,255,255,0.06)',
}

const artPlaceholder: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 20,
  color: 'rgba(255,255,255,0.5)',
}

const eyebrowText: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: 1,
  textTransform: 'uppercase',
  color: '#7f8aa3',
}

const titleText: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: '#eef1f7',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const artistText: React.CSSProperties = {
  fontSize: 12,
  color: '#aeb6c8',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const secondaryText: React.CSSProperties = {
  fontSize: 13,
  color: '#c6cddb',
}

const dotStyle: React.CSSProperties = {
  width: 9,
  height: 9,
  borderRadius: '50%',
  background: '#78c8ff',
  flexShrink: 0,
}
