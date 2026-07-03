import { useCallback, useEffect, useRef, useState } from 'react'
import { startCapture, type AudioCapture } from './audio/capture'
import VisualizerCanvas from './components/VisualizerCanvas'
import DebugOverlay from './components/DebugOverlay'
import SessionLogger from './components/SessionLogger'
import TuningPanel from './components/TuningPanel'
import { useFeatures } from './hooks/useFeatures'
import type { DirectorState } from './director/Director'

type Status = 'idle' | 'starting' | 'running' | 'error'

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
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <VisualizerCanvas
        featuresRef={featuresRef}
        directorRef={directorRef}
        onStatus={setStatus2}
      />

      {analyser && <DebugOverlay featuresRef={featuresRef} directorRef={directorRef} />}

      {/* Dev-only live tuning (press 't'). Hidden by default; not a user control. */}
      <TuningPanel />

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
          Reactive Visualizer — Step 6: Tuning
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
          <strong style={{ color: '#e8ecf5' }}>a</strong> auto on/off ·{' '}
          <strong style={{ color: '#e8ecf5' }}>1</strong>/<strong style={{ color: '#e8ecf5' }}>2</strong>{' '}
          force style (manual) · <strong style={{ color: '#e8ecf5' }}>d</strong> debug ·{' '}
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
