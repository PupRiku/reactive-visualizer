import { useEffect, useRef, useState } from 'react'
import type { Features } from '../audio/features'
import type { DirectorState } from '../director/Director'

interface SessionLoggerProps {
  featuresRef: React.RefObject<Features | null>
  directorRef: React.RefObject<DirectorState | null>
}

/** Sampling period in ms (10 Hz — plenty for feature/director tuning). */
const SAMPLE_MS = 100

/** CSV columns, in order. Keep in sync with buildRow(). */
const COLUMNS = [
  't_ms',
  'bass',
  'mid',
  'treble',
  'loudness',
  'brightness',
  'motion',
  'bass_agc',
  'loud_agc',
  'motion_agc',
  'brightnessHz',
  'bpm',
  'beatCount',
  'beatActivity',
  'sinceBeat_ms',
  'score_swarm',
  'score_plasma',
  'current',
  'challenger',
  'pending',
  'phase',
]

/**
 * Dev instrument: click to start recording a session, click again to stop and
 * download a CSV of features + director state sampled at SAMPLE_MS. Handy for
 * tuning the DSP/scoring against real songs over time rather than eyeballing a
 * single overlay frame.
 */
export default function SessionLogger({ featuresRef, directorRef }: SessionLoggerProps) {
  const [recording, setRecording] = useState(false)
  const [count, setCount] = useState(0)

  const rowsRef = useRef<string[]>([])
  const startRef = useRef(0)
  const timerRef = useRef<number | null>(null)

  // Clean up the sampling timer if we unmount mid-recording.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current)
    }
  }, [])

  const start = () => {
    rowsRef.current = [COLUMNS.join(',')]
    startRef.current = performance.now()
    setCount(0)
    timerRef.current = window.setInterval(() => {
      const f = featuresRef.current
      if (!f) return // not capturing yet — nothing to sample
      const t = Math.round(performance.now() - startRef.current)
      rowsRef.current.push(buildRow(t, f, directorRef.current))
      setCount(rowsRef.current.length - 1)
    }, SAMPLE_MS)
    setRecording(true)
  }

  const stop = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    setRecording(false)
    if (rowsRef.current.length > 1) downloadCsv(rowsRef.current.join('\n'))
    rowsRef.current = []
  }

  return (
    <button
      onClick={() => (recording ? stop() : start())}
      style={recording ? recordingStyle : idleStyle}
      title="Record features + director state to a CSV for offline tuning"
    >
      {recording ? `■ Stop log (${count})` : '● Start log'}
    </button>
  )
}

function buildRow(t: number, f: Features, d: DirectorState | null): string {
  const swarm = scoreOf(d, 'ParticleSwarm')
  const plasma = scoreOf(d, 'FluidPlasma')
  return [
    t,
    n(f.smoothed.bass),
    n(f.smoothed.mid),
    n(f.smoothed.treble),
    n(f.smoothed.loudness),
    n(f.smoothed.brightness),
    n(f.smoothed.motion),
    n(f.normalized.bass),
    n(f.normalized.loudness),
    n(f.normalized.motion),
    Math.round(f.brightnessHz),
    f.bpm,
    f.beatCount,
    n(f.beatActivity),
    Math.round(f.sinceLastBeatMs),
    swarm,
    plasma,
    d?.currentName ?? '',
    d?.challengerName ?? '',
    d?.switchPending ? 1 : 0,
    d?.phase ?? '',
  ].join(',')
}

function scoreOf(d: DirectorState | null, name: string): string {
  const s = d?.scores.find((x) => x.name === name)
  return s ? n(s.score) : ''
}

/** Format a number to 4 decimals for compact, consistent CSV cells. */
function n(v: number): string {
  return v.toFixed(4)
}

function downloadCsv(text: string): void {
  const blob = new Blob([text], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  // performance.timeOrigin + now gives a wall-clock-ish stamp without Date.now.
  a.download = `viz-session-${Math.round(performance.timeOrigin + performance.now())}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

const baseButtonStyle: React.CSSProperties = {
  appearance: 'none',
  border: '1px solid rgba(255,255,255,0.2)',
  color: 'white',
  fontSize: 12,
  fontWeight: 600,
  padding: '6px 12px',
  borderRadius: 8,
  cursor: 'pointer',
}

const idleStyle: React.CSSProperties = {
  ...baseButtonStyle,
  background: 'rgba(255,255,255,0.08)',
}

const recordingStyle: React.CSSProperties = {
  ...baseButtonStyle,
  background: '#c0392b',
  borderColor: 'rgba(255,120,120,0.5)',
}
