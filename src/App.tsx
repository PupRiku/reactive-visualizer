import { useCallback, useEffect, useRef, useState } from 'react'
import { startCapture, type AudioCapture } from './audio/capture'
import VisualizerCanvas, { type VisualizerControls } from './components/VisualizerCanvas'
import DebugOverlay from './components/DebugOverlay'
import SessionLogger from './components/SessionLogger'
import TuningPanel from './components/TuningPanel'
import ControlBar from './components/ControlBar'
import { useFeatures } from './hooks/useFeatures'
import type { DirectorState } from './director/Director'

type Status = 'idle' | 'starting' | 'running' | 'error'

const INTENSITY_STEP = 0.1

export default function App() {
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const [status2, setStatus2] = useState({ current: 'ParticleSwarm', auto: true })
  const captureRef = useRef<AudioCapture | null>(null)

  // Layer 2: extract the full feature set every frame from the live analyser.
  const featuresRef = useFeatures(analyser)
  // Layer 3: director state, written by the canvas loop, read by the overlay.
  const directorRef = useRef<DirectorState | null>(null)

  // v1.1: the control bar drives the single Director inside VisualizerCanvas via
  // this imperative handle (down-channel). Intensity is owned here (the slider is
  // the source of truth) and mirrored in a ref so the keyboard handler reads the
  // current value without re-subscribing on every change.
  const controlsRef = useRef<VisualizerControls | null>(null)
  const [intensity, setIntensity] = useState(1)
  const intensityRef = useRef(1)
  const rootRef = useRef<HTMLDivElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  // Top-left capture/info panel: toggleable so it can be cleared off a share ('h').
  const [panelVisible, setPanelVisible] = useState(true)

  const applyIntensity = useCallback((value: number) => {
    const v = Math.min(2, Math.max(0, value))
    intensityRef.current = v
    setIntensity(v)
    controlsRef.current?.setIntensity(v)
  }, [])

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
    } else {
      void rootRef.current?.requestFullscreen().catch(() => {})
    }
  }, [])

  // Reflect fullscreen state (covers Esc / F11 / OS-driven exits too).
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  // v1.1 keyboard: intensity up/down and 'f' fullscreen. Existing shortcuts
  // (a / 1 / 2 / d / t) are owned by their own components and untouched.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'f' || e.key === 'F') {
        toggleFullscreen()
        return
      }
      if (e.key === 'h' || e.key === 'H') {
        setPanelVisible((v) => !v)
        return
      }
      // Let a focused slider/input handle its own arrow keys.
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'ArrowUp' || e.key === '+' || e.key === '=') {
        e.preventDefault()
        applyIntensity(intensityRef.current + INTENSITY_STEP)
      } else if (e.key === 'ArrowDown' || e.key === '-' || e.key === '_') {
        e.preventDefault()
        applyIntensity(intensityRef.current - INTENSITY_STEP)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [applyIntensity, toggleFullscreen])

  const handleStart = useCallback(async () => {
    setError(null)
    setStatus('starting')
    try {
      const capture = await startCapture()
      captureRef.current = capture
      setAnalyser(capture.analyser)
      setStatus('running')
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to start audio capture.'
      // A user cancelling the share dialog throws NotAllowedError — treat that
      // as a quiet return to idle rather than a scary error.
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setStatus('idle')
        return
      }
      setError(message)
      setStatus('error')
    }
  }, [])

  const handleStop = useCallback(() => {
    captureRef.current?.stop()
    captureRef.current = null
    setAnalyser(null)
    setStatus('idle')
  }, [])

  // Tear down capture if the component unmounts.
  useEffect(() => {
    return () => captureRef.current?.stop()
  }, [])

  return (
    <div ref={rootRef} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <VisualizerCanvas
        featuresRef={featuresRef}
        directorRef={directorRef}
        onStatus={setStatus2}
        controlsRef={controlsRef}
      />

      {analyser && <DebugOverlay featuresRef={featuresRef} directorRef={directorRef} />}

      {/* Dev-only live tuning (press 't'). Hidden by default; not a user control. */}
      <TuningPanel />

      {/* v1.1 live control bar. Auto-hides; drives the director via controlsRef. */}
      <ControlBar
        auto={status2.auto}
        current={status2.current}
        intensity={intensity}
        fullscreen={isFullscreen}
        onToggleAuto={() => controlsRef.current?.toggleAuto()}
        onSelectStyle={(i) => controlsRef.current?.selectStyle(i)}
        onIntensity={applyIntensity}
        onToggleFullscreen={toggleFullscreen}
      />

      {/* Top-left capture/info panel — toggle with 'h' to clear it off a share. */}
      {panelVisible && (
        <div
          style={{
            position: 'absolute',
            top: 16,
            left: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: 16,
          background: 'rgba(10, 12, 20, 0.72)',
          borderRadius: 10,
          backdropFilter: 'blur(6px)',
          maxWidth: 380,
        }}
      >
        <strong style={{ fontSize: 14, letterSpacing: 0.3 }}>
          Reactive Visualizer — v1.1: Live controls
        </strong>

        {status !== 'running' ? (
          <button
            onClick={handleStart}
            disabled={status === 'starting'}
            style={buttonStyle}
          >
            {status === 'starting' ? 'Waiting for share dialog…' : 'Start capture'}
          </button>
        ) : (
          <button onClick={handleStop} style={buttonStyle}>
            Stop capture
          </button>
        )}

        {status === 'idle' && (
          <p style={hintStyle}>
            Click <em>Start capture</em>, choose <strong>Entire Screen</strong>,
            and tick <strong>“Share system audio”</strong> in the dialog. Then
            play some music.
          </p>
        )}
        {status === 'running' && (
          <p style={hintStyle}>
            Capturing system audio. If the visuals are inert, the “Share system
            audio” box likely wasn’t checked.
          </p>
        )}
        {status === 'error' && error && (
          <p style={{ ...hintStyle, color: '#ff9aa2' }}>{error}</p>
        )}

        <p style={hintStyle}>
          Use the control bar (bottom) — or keys:{' '}
          <strong style={{ color: '#e8ecf5' }}>a</strong> auto ·{' '}
          <strong style={{ color: '#e8ecf5' }}>1</strong>/<strong style={{ color: '#e8ecf5' }}>2</strong>{' '}
          style · <strong style={{ color: '#e8ecf5' }}>↑</strong>/<strong style={{ color: '#e8ecf5' }}>↓</strong>{' '}
          intensity · <strong style={{ color: '#e8ecf5' }}>f</strong> fullscreen ·{' '}
          <strong style={{ color: '#e8ecf5' }}>h</strong> hide this panel ·{' '}
          <strong style={{ color: '#e8ecf5' }}>d</strong> debug ·{' '}
          <strong style={{ color: '#e8ecf5' }}>t</strong> tuning (dev)
          <br />
          Mode:{' '}
          <strong style={{ color: status2.auto ? '#7cfc9b' : '#ffd166' }}>
            {status2.auto ? 'AUTO' : 'MANUAL'}
          </strong>{' '}
          · Style: <strong style={{ color: '#78c8ff' }}>{status2.current}</strong>
        </p>

        {status === 'running' && (
          <SessionLogger featuresRef={featuresRef} directorRef={directorRef} />
        )}
        </div>
      )}
    </div>
  )
}

const buttonStyle: React.CSSProperties = {
  appearance: 'none',
  border: '1px solid rgba(255,255,255,0.2)',
  background: '#2a6cf0',
  color: 'white',
  fontSize: 14,
  fontWeight: 600,
  padding: '8px 14px',
  borderRadius: 8,
  cursor: 'pointer',
}

const hintStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: '#aeb6c8',
}
