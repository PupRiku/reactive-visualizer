import { useEffect, useRef, useState } from 'react'
import type { ContinuousFeatures, Features } from '../audio/features'
import type { DirectorState } from '../director/Director'
import { AXES, buildFeatureVector } from '../renderers/scoring'

interface DebugOverlayProps {
  /** Live features ref, updated once per frame by useFeatures. */
  featuresRef: React.RefObject<Features | null>
  /** Live director state ref, updated once per frame by the canvas loop. */
  directorRef?: React.RefObject<DirectorState | null>
}

/** The continuous channels we show as raw + smoothed bars. */
const CHANNELS: { key: keyof ContinuousFeatures; label: string }[] = [
  { key: 'bass', label: 'Bass' },
  { key: 'mid', label: 'Mid' },
  { key: 'treble', label: 'Treble' },
  { key: 'loudness', label: 'Loudness (RMS)' },
  { key: 'brightness', label: 'Brightness' },
  { key: 'motion', label: 'Motion (flux)' },
]

/**
 * Toggleable live-feature readout (press 'd'). Shows every feature as a labeled
 * number plus a small bar, and flashes on each detected beat. Updates the DOM
 * imperatively from a per-frame loop so it never triggers React re-renders.
 */
export default function DebugOverlay({ featuresRef, directorRef }: DebugOverlayProps) {
  const [visible, setVisible] = useState(true)

  const rootRef = useRef<HTMLDivElement>(null)
  // Per-channel DOM refs: [rawSmoothed text, smoothed bar fill, raw bar tick].
  const rowRefs = useRef<
    Record<string, { text: HTMLSpanElement; bar: HTMLDivElement; tick: HTMLDivElement }>
  >({})
  const scalarRefs = useRef<Record<string, HTMLSpanElement>>({})
  const beatDotRef = useRef<HTMLDivElement>(null)
  // v1.3 feature-vector rows (energy/pulse/bright/flux): [value text, bar fill].
  const vecRefs = useRef<Record<string, { val: HTMLSpanElement; bar: HTMLDivElement }>>({})

  // Director-section DOM refs.
  const dirRefs = useRef<Record<string, HTMLElement>>({})
  const dirStyleRefs = useRef<
    Record<number, { label: HTMLSpanElement; val: HTMLSpanElement; bar: HTMLDivElement }>
  >({})

  // Toggle with the 'd' key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'd' || e.key === 'D') setVisible((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Per-frame imperative update loop.
  useEffect(() => {
    if (!visible) return
    let rafId = 0

    const draw = () => {
      rafId = requestAnimationFrame(draw)
      updateFeatures()
      updateDirector()
    }
    draw()
    return () => cancelAnimationFrame(rafId)

    function updateFeatures() {
      const f = featuresRef.current
      if (!f) return

      for (const { key } of CHANNELS) {
        const row = rowRefs.current[key]
        if (!row) continue
        const raw = f.raw[key]
        const smoothed = f.smoothed[key]
        row.text.textContent = `${raw.toFixed(3)} → ${smoothed.toFixed(3)}`
        row.bar.style.width = `${clamp01(smoothed) * 100}%`
        row.tick.style.left = `${clamp01(raw) * 100}%`
      }

      // v1.3 feature vector — what the prototype scoring actually consumes.
      const vec = buildFeatureVector(f)
      AXES.forEach((axis, i) => {
        const row = vecRefs.current[axis]
        if (!row) return
        row.val.textContent = vec[i].toFixed(3)
        row.bar.style.width = `${clamp01(vec[i]) * 100}%`
      })

      setScalar('brightnessHz', `${Math.round(f.brightnessHz)} Hz`)
      setScalar('bpm', f.bpm > 0 ? `${f.bpm}` : '—')
      setScalar('bar', `${f.bar}`)
      setScalar('beatCount', `${f.beatCount}`)
      setScalar('sinceBeat', `${Math.round(f.sinceLastBeatMs)} ms`)
      setScalar('beatActivity', f.beatActivity.toFixed(2))
      setScalar('loudnessAgc', f.normalized.loudness.toFixed(2))
      setScalar('motionAgc', f.normalized.motion.toFixed(2))

      // Beat flash: envelope drives a glowing dot and the whole panel's border.
      const env = f.beatEnvelope
      if (beatDotRef.current) {
        beatDotRef.current.style.opacity = `${0.25 + env * 0.75}`
        beatDotRef.current.style.transform = `scale(${1 + env * 0.9})`
      }
      if (rootRef.current) {
        rootRef.current.style.boxShadow = `0 0 ${env * 28}px rgba(120,200,255,${env * 0.8})`
        rootRef.current.style.borderColor = `rgba(120,200,255,${0.12 + env * 0.7})`
      }
    }

    function updateDirector() {
      const ds = directorRef?.current
      if (!ds) return

      // Per-style score bars; highlight whichever is current.
      ds.scores.forEach((s, i) => {
        const row = dirStyleRefs.current[i]
        if (!row) return
        const isCurrent = s.name === ds.currentName
        row.label.textContent = s.name
        row.label.style.color = isCurrent ? '#78c8ff' : '#aeb6c8'
        row.label.style.fontWeight = isCurrent ? '700' : '400'
        row.val.textContent = s.score.toFixed(3)
        row.bar.style.width = `${clamp01(s.score) * 100}%`
      })

      setDir('current', ds.currentName)

      if (ds.challengerName) {
        setDir('challenger', ds.challengerName)
        setDir('chalTimer', `${ds.challengerTimer.toFixed(1)}s / ${ds.minHoldSeconds}s`)
        dirBar('chalBar', clamp01(ds.challengerTimer / ds.minHoldSeconds))
      } else {
        setDir('challenger', '—')
        setDir('chalTimer', '')
        dirBar('chalBar', 0)
      }

      const pend = dirRefs.current['pending']
      if (pend) {
        pend.textContent = ds.switchPending ? 'YES' : 'no'
        pend.style.color = ds.switchPending ? '#7cfc9b' : '#6b7590'
      }

      dirBar('transBar', ds.transitionProgress)
      setDir(
        'transVal',
        ds.phase === 'TRANSITIONING' ? `${Math.round(ds.transitionProgress * 100)}%` : 'stable',
      )

      setDir('cooldown', ds.cooldownRemaining > 0 ? `${ds.cooldownRemaining.toFixed(1)}s` : '—')

      const badge = dirRefs.current['autoBadge']
      if (badge) {
        badge.textContent = ds.auto ? 'AUTO' : 'MANUAL'
        badge.style.color = ds.auto ? '#7cfc9b' : '#ffd166'
        badge.style.borderColor = ds.auto ? 'rgba(124,252,155,0.4)' : 'rgba(255,209,102,0.4)'
      }
    }

    function setScalar(id: string, value: string) {
      const el = scalarRefs.current[id]
      if (el) el.textContent = value
    }
    function setDir(id: string, value: string) {
      const el = dirRefs.current[id]
      if (el) el.textContent = value
    }
    function dirBar(id: string, frac: number) {
      const el = dirRefs.current[id]
      if (el) el.style.width = `${clamp01(frac) * 100}%`
    }
  }, [visible, featuresRef, directorRef])

  if (!visible) return null

  return (
    <div ref={rootRef} style={panelStyle}>
      <div style={headerStyle}>
        <div ref={beatDotRef} style={beatDotStyle} />
        <strong style={{ fontSize: 13 }}>Features</strong>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#6b7590' }}>
          press <kbd style={kbdStyle}>d</kbd> to hide
        </span>
      </div>

      {CHANNELS.map(({ key, label }) => (
        <div key={key} style={{ marginBottom: 8 }}>
          <div style={rowHeaderStyle}>
            <span style={{ color: '#aeb6c8' }}>{label}</span>
            <span
              ref={(el) => {
                if (el) {
                  rowRefs.current[key] = { ...rowRefs.current[key], text: el } as never
                }
              }}
              style={{ marginLeft: 'auto', color: '#e8ecf5', fontVariantNumeric: 'tabular-nums' }}
            >
              0.000 → 0.000
            </span>
          </div>
          <div style={barTrackStyle}>
            <div
              ref={(el) => {
                if (el) rowRefs.current[key] = { ...rowRefs.current[key], bar: el } as never
              }}
              style={barFillStyle}
            />
            <div
              ref={(el) => {
                if (el) rowRefs.current[key] = { ...rowRefs.current[key], tick: el } as never
              }}
              style={rawTickStyle}
            />
          </div>
        </div>
      ))}

      <div style={dividerStyle} />

      <ScalarRow label="Brightness" id="brightnessHz" scalarRefs={scalarRefs} />
      <ScalarRow label="Tempo" id="bpm" suffix="BPM" scalarRefs={scalarRefs} />
      <ScalarRow label="Bar (every 4 beats)" id="bar" scalarRefs={scalarRefs} />
      <ScalarRow label="Beat count" id="beatCount" scalarRefs={scalarRefs} />
      <ScalarRow label="Since last beat" id="sinceBeat" scalarRefs={scalarRefs} />
      <ScalarRow label="Beat activity" id="beatActivity" scalarRefs={scalarRefs} />
      <ScalarRow label="Loudness (agc)" id="loudnessAgc" scalarRefs={scalarRefs} />
      <ScalarRow label="Motion (agc)" id="motionAgc" scalarRefs={scalarRefs} />

      <div style={dividerStyle} />

      <div style={{ ...headerStyle, marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>Feature vector</strong>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: '#6b7590' }}>
          scoring input
        </span>
      </div>

      {AXES.map((axis) => (
        <div key={axis} style={{ marginBottom: 8 }}>
          <div style={rowHeaderStyle}>
            <span style={{ color: '#aeb6c8' }}>{axis}</span>
            <span
              ref={(el) => {
                if (el) vecRefs.current[axis] = { ...vecRefs.current[axis], val: el } as never
              }}
              style={{ marginLeft: 'auto', color: '#e8ecf5', fontVariantNumeric: 'tabular-nums' }}
            >
              0.000
            </span>
          </div>
          <div style={barTrackStyle}>
            <div
              ref={(el) => {
                if (el) vecRefs.current[axis] = { ...vecRefs.current[axis], bar: el } as never
              }}
              style={vecBarFillStyle}
            />
          </div>
        </div>
      ))}

      {directorRef && (
        <>
          <div style={dividerStyle} />

          <div style={{ ...headerStyle, marginBottom: 10 }}>
            <strong style={{ fontSize: 13 }}>Director</strong>
            <span
              ref={dref(dirRefs, 'autoBadge')}
              style={{ marginLeft: 'auto', ...autoBadgeStyle }}
            >
              AUTO
            </span>
          </div>

          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ marginBottom: 8 }}>
              <div style={rowHeaderStyle}>
                <span
                  ref={(el) => {
                    if (el) dirStyleRefs.current[i] = { ...dirStyleRefs.current[i], label: el } as never
                  }}
                  style={{ color: '#aeb6c8' }}
                >
                  Style {i}
                </span>
                <span
                  ref={(el) => {
                    if (el) dirStyleRefs.current[i] = { ...dirStyleRefs.current[i], val: el } as never
                  }}
                  style={{ marginLeft: 'auto', color: '#e8ecf5', fontVariantNumeric: 'tabular-nums' }}
                >
                  0.000
                </span>
              </div>
              <div style={barTrackStyle}>
                <div
                  ref={(el) => {
                    if (el) dirStyleRefs.current[i] = { ...dirStyleRefs.current[i], bar: el } as never
                  }}
                  style={scoreBarFillStyle}
                />
              </div>
            </div>
          ))}

          <div style={{ ...scalarRowStyle, marginTop: 4 }}>
            <span style={{ color: '#aeb6c8' }}>Current</span>
            <span ref={dref(dirRefs, 'current')} style={dirValueStyle}>
              —
            </span>
          </div>

          <div style={{ marginTop: 6, marginBottom: 6 }}>
            <div style={rowHeaderStyle}>
              <span style={{ color: '#aeb6c8' }}>Challenger</span>
              <span ref={dref(dirRefs, 'challenger')} style={dirValueStyle}>
                —
              </span>
            </div>
            <div style={barTrackStyle}>
              <div ref={dref(dirRefs, 'chalBar')} style={challengerBarFillStyle} />
            </div>
            <div style={{ fontSize: 10, color: '#6b7590', textAlign: 'right', marginTop: 2 }}>
              <span ref={dref(dirRefs, 'chalTimer')} />
            </div>
          </div>

          <div style={scalarRowStyle}>
            <span style={{ color: '#aeb6c8' }}>Switch pending</span>
            <span ref={dref(dirRefs, 'pending')} style={dirValueStyle}>
              no
            </span>
          </div>

          <div style={{ marginTop: 6 }}>
            <div style={rowHeaderStyle}>
              <span style={{ color: '#aeb6c8' }}>Transition</span>
              <span ref={dref(dirRefs, 'transVal')} style={dirValueStyle}>
                stable
              </span>
            </div>
            <div style={barTrackStyle}>
              <div ref={dref(dirRefs, 'transBar')} style={transitionBarFillStyle} />
            </div>
          </div>

          <div style={{ ...scalarRowStyle, marginTop: 6 }}>
            <span style={{ color: '#aeb6c8' }}>Cooldown</span>
            <span ref={dref(dirRefs, 'cooldown')} style={dirValueStyle}>
              —
            </span>
          </div>
        </>
      )}
    </div>
  )
}

/** Ref-callback helper that stores an element in a string-keyed ref map. */
function dref(map: React.RefObject<Record<string, HTMLElement>>, id: string) {
  return (el: HTMLElement | null) => {
    if (el && map.current) map.current[id] = el
  }
}

function ScalarRow({
  label,
  id,
  suffix,
  scalarRefs,
}: {
  label: string
  id: string
  suffix?: string
  scalarRefs: React.RefObject<Record<string, HTMLSpanElement>>
}) {
  return (
    <div style={scalarRowStyle}>
      <span style={{ color: '#aeb6c8' }}>{label}</span>
      <span style={{ marginLeft: 'auto', color: '#e8ecf5', fontVariantNumeric: 'tabular-nums' }}>
        <span
          ref={(el) => {
            if (el && scalarRefs.current) scalarRefs.current[id] = el
          }}
        >
          —
        </span>
        {suffix ? <span style={{ color: '#6b7590' }}> {suffix}</span> : null}
      </span>
    </div>
  )
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  top: 16,
  right: 16,
  width: 300,
  padding: 14,
  background: 'rgba(10, 12, 20, 0.82)',
  border: '1px solid rgba(120,200,255,0.12)',
  borderRadius: 10,
  backdropFilter: 'blur(6px)',
  fontSize: 12,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  userSelect: 'none',
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 12,
}

const beatDotStyle: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: '50%',
  background: '#78c8ff',
  boxShadow: '0 0 8px #78c8ff',
  opacity: 0.25,
}

const rowHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  marginBottom: 3,
  fontSize: 11,
}

const barTrackStyle: React.CSSProperties = {
  position: 'relative',
  height: 6,
  borderRadius: 3,
  background: 'rgba(255,255,255,0.08)',
  overflow: 'hidden',
}

const barFillStyle: React.CSSProperties = {
  position: 'absolute',
  inset: '0 auto 0 0',
  width: '0%',
  background: 'linear-gradient(90deg, #2a6cf0, #78c8ff)',
  borderRadius: 3,
}

// A thin marker showing the raw (unsmoothed) value on the same track.
const rawTickStyle: React.CSSProperties = {
  position: 'absolute',
  top: -1,
  left: '0%',
  width: 2,
  height: 8,
  background: '#ffd166',
  transform: 'translateX(-1px)',
}

const dividerStyle: React.CSSProperties = {
  height: 1,
  background: 'rgba(255,255,255,0.08)',
  margin: '10px 0',
}

const scalarRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  fontSize: 11,
  padding: '2px 0',
}

const kbdStyle: React.CSSProperties = {
  padding: '1px 4px',
  borderRadius: 3,
  border: '1px solid rgba(255,255,255,0.2)',
  background: 'rgba(255,255,255,0.06)',
  fontSize: 10,
}

const dirValueStyle: React.CSSProperties = {
  marginLeft: 'auto',
  color: '#e8ecf5',
  fontVariantNumeric: 'tabular-nums',
}

const autoBadgeStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.5,
  padding: '1px 6px',
  borderRadius: 4,
  border: '1px solid rgba(124,252,155,0.4)',
  color: '#7cfc9b',
}

const scoreBarFillStyle: React.CSSProperties = {
  position: 'absolute',
  inset: '0 auto 0 0',
  width: '0%',
  background: 'linear-gradient(90deg, #6b4bd6, #b98cff)',
  borderRadius: 3,
}

// Feature-vector axis bars — teal, distinct from the feature and score bars.
const vecBarFillStyle: React.CSSProperties = {
  position: 'absolute',
  inset: '0 auto 0 0',
  width: '0%',
  background: 'linear-gradient(90deg, #1f9e8f, #57e0c9)',
  borderRadius: 3,
}

const challengerBarFillStyle: React.CSSProperties = {
  position: 'absolute',
  inset: '0 auto 0 0',
  width: '0%',
  background: 'linear-gradient(90deg, #d68a2a, #ffd166)',
  borderRadius: 3,
}

const transitionBarFillStyle: React.CSSProperties = {
  position: 'absolute',
  inset: '0 auto 0 0',
  width: '0%',
  background: 'linear-gradient(90deg, #2a6cf0, #78c8ff)',
  borderRadius: 3,
}
