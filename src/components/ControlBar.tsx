import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * v1.1 live-use control bar (Zoom happy hours / streams / DJ).
 *
 * Media-player style: hidden by default, fades in on pointer move or tap, and
 * fades back out after ~3s idle so it never sits on screen during a screen
 * share. It will NOT fade while the pointer is over it. Purely presentational —
 * it drives the single Director via callbacks the parent wires to the canvas's
 * imperative command handle, and reflects state passed down as props.
 */

// Brand palette.
const ORANGE = '#FF7A1A' // energetic — Swarm
const PURPLE = '#A855F7' // calm — Plasma
const TEAL = '#2DD4BF' // AUTO / accent

const IDLE_MS = 3000

interface ControlBarProps {
  auto: boolean
  /** Director style name currently on screen ('ParticleSwarm' | 'FluidPlasma'). */
  current: string
  intensity: number
  fullscreen: boolean
  onToggleAuto: () => void
  onSelectStyle: (index: number) => void
  onIntensity: (value: number) => void
  onToggleFullscreen: () => void
}

export default function ControlBar({
  auto,
  current,
  intensity,
  fullscreen,
  onToggleAuto,
  onSelectStyle,
  onIntensity,
  onToggleFullscreen,
}: ControlBarProps) {
  const [active, setActive] = useState(true)
  const [hovering, setHovering] = useState(false)
  const timerRef = useRef<number | undefined>(undefined)

  // Any pointer activity shows the bar and restarts the idle countdown.
  const bump = useCallback(() => {
    setActive(true)
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setActive(false), IDLE_MS)
  }, [])

  useEffect(() => {
    bump() // show briefly on mount, then auto-hide
    window.addEventListener('pointermove', bump)
    window.addEventListener('pointerdown', bump)
    return () => {
      window.removeEventListener('pointermove', bump)
      window.removeEventListener('pointerdown', bump)
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
  }, [bump])

  // Stay up while hovered; otherwise honor the idle timer.
  const visible = active || hovering

  const swarmActive = current === 'ParticleSwarm'
  const plasmaActive = current === 'FluidPlasma'

  return (
    <div
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => {
        setHovering(false)
        bump() // restart the idle countdown when the pointer leaves the bar
      }}
      style={{ ...barStyle, opacity: visible ? 1 : 0, pointerEvents: visible ? 'auto' : 'none' }}
    >
      <button
        onClick={onToggleAuto}
        title="Toggle self-driving (AUTO) vs locked (MANUAL)"
        style={pill(auto, TEAL)}
      >
        {auto ? 'AUTO' : 'MANUAL'}
      </button>

      <span style={divider} />

      <button
        onClick={() => onSelectStyle(0)}
        title="Show the particle swarm (switches to manual)"
        style={pill(swarmActive, ORANGE)}
      >
        Swarm
      </button>
      <button
        onClick={() => onSelectStyle(1)}
        title="Show the fluid plasma (switches to manual)"
        style={pill(plasmaActive, PURPLE)}
      >
        Plasma
      </button>

      <span style={divider} />

      <div style={intensityGroup}>
        <span style={labelStyle}>Intensity</span>
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={intensity}
          onChange={(e) => onIntensity(parseFloat(e.target.value))}
          title="Global liveliness (0 calm · 1 neutral · 2 lively)"
          style={sliderStyle}
        />
        <span style={valueStyle}>{intensity.toFixed(2)}</span>
      </div>

      <span style={divider} />

      <button
        onClick={onToggleFullscreen}
        title="Toggle fullscreen (f)"
        style={iconButton}
      >
        {fullscreen ? '🡼 Exit' : '⛶ Full'}
      </button>
    </div>
  )
}

const barStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 24,
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  background: 'rgba(10, 12, 20, 0.82)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 14,
  backdropFilter: 'blur(10px)',
  boxShadow: '0 8px 30px rgba(0,0,0,0.45)',
  transition: 'opacity 0.35s ease',
  fontFamily: 'system-ui, sans-serif',
  userSelect: 'none',
  zIndex: 20,
}

/** A pill button that lights up in `accent` when active. */
function pill(activeState: boolean, accent: string): React.CSSProperties {
  return {
    appearance: 'none',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: 0.3,
    padding: '7px 14px',
    borderRadius: 9,
    color: activeState ? '#0a0c14' : '#e8ecf5',
    background: activeState ? accent : 'rgba(255,255,255,0.06)',
    border: `1px solid ${activeState ? accent : 'rgba(255,255,255,0.14)'}`,
    boxShadow: activeState ? `0 0 14px ${accent}66` : 'none',
    transition: 'background 0.15s, color 0.15s, box-shadow 0.15s',
  }
}

const iconButton: React.CSSProperties = {
  appearance: 'none',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
  padding: '7px 12px',
  borderRadius: 9,
  color: '#e8ecf5',
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.14)',
}

const divider: React.CSSProperties = {
  width: 1,
  alignSelf: 'stretch',
  background: 'rgba(255,255,255,0.12)',
  margin: '0 2px',
}

const intensityGroup: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#aeb6c8',
}

const sliderStyle: React.CSSProperties = {
  width: 120,
  accentColor: ORANGE,
  cursor: 'pointer',
}

const valueStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#e8ecf5',
  fontVariantNumeric: 'tabular-nums',
  minWidth: 30,
  textAlign: 'right',
}
