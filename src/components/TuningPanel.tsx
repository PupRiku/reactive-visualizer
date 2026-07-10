import { useEffect, useState } from 'react'
import { tuning } from '../tuning'

/**
 * Dev-only tuning panel (build plan step 6) — NOT the v1.1 user controls.
 *
 * Live sliders bound to the `tuning` config: each renderer's score weights, the
 * tempoNorm window, the brightness window, and the five director constants. The
 * sliders mutate `tuning` in place, so the director/scoring pick up changes on
 * the very next frame with no rebuild. It prints the current values in the same
 * shape as tuning.ts so good settings can be copied back as the new defaults.
 *
 * Toggle with the 't' key. Hidden by default and clearly separated from the real
 * UI so it never gets mistaken for a user control.
 */

type Group = keyof typeof tuning

interface Row {
  group: Group
  key: string
  label: string
  min: number
  max: number
  step: number
}

const PROTO_AXES: { key: string; label: string }[] = [
  { key: 'energy', label: 'energy' },
  { key: 'pulse', label: 'pulse' },
  { key: 'bright', label: 'bright' },
  { key: 'flux', label: 'flux' },
]
const protoRows = (group: Group): Row[] =>
  PROTO_AXES.map(({ key, label }) => ({ group, key, label, min: 0, max: 1, step: 0.01 }))

const SECTIONS: { title: string; rows: Row[] }[] = [
  {
    title: 'Feature axes',
    rows: [
      { group: 'axes', key: 'energyTempoMix', label: 'energy: tempo↔loud', min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    title: 'Swarm prototype (energetic)',
    rows: protoRows('swarmProto'),
  },
  {
    title: 'Plasma prototype (calm)',
    rows: protoRows('plasmaProto'),
  },
  {
    title: 'Geometry prototype (bright/structured)',
    rows: protoRows('geometryProto'),
  },
  {
    title: 'tempoNorm window (BPM)',
    rows: [
      { group: 'tempoNorm', key: 'min', label: 'min → 0', min: 40, max: 140, step: 1 },
      { group: 'tempoNorm', key: 'max', label: 'max → 1', min: 100, max: 220, step: 1 },
    ],
  },
  {
    title: 'Brightness window',
    rows: [
      { group: 'bright', key: 'lo', label: 'lo (dark)', min: 0, max: 0.4, step: 0.005 },
      { group: 'bright', key: 'hi', label: 'hi (bright)', min: 0.05, max: 0.6, step: 0.005 },
    ],
  },
  {
    title: 'Director',
    rows: [
      { group: 'director', key: 'minHold', label: 'minHold (s)', min: 0, max: 30, step: 0.5 },
      { group: 'director', key: 'switchMargin', label: 'switchMargin', min: 0, max: 0.5, step: 0.01 },
      { group: 'director', key: 'cooldown', label: 'cooldown (s)', min: 0, max: 15, step: 0.5 },
      { group: 'director', key: 'scoreSmoothTau', label: 'smoothTau (s)', min: 0.05, max: 3, step: 0.05 },
      { group: 'director', key: 'challengerLeak', label: 'leak', min: 0, max: 1, step: 0.05 },
    ],
  },
]

function get(group: Group, key: string): number {
  return (tuning[group] as Record<string, number>)[key]
}
function set(group: Group, key: string, v: number): void {
  ;(tuning[group] as Record<string, number>)[key] = v
}

/** Compact numeric format: ints stay ints, decimals trim trailing zeros. */
function fmt(n: number): string {
  if (Number.isInteger(n)) return String(n)
  return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

/** Serialize the live config in the same shape as tuning.ts, for copy-back. */
function serialize(): string {
  const groups: Group[] = [
    'axes',
    'swarmProto',
    'plasmaProto',
    'geometryProto',
    'tempoNorm',
    'bright',
    'director',
  ]
  const line = (g: Group) =>
    Object.entries(tuning[g] as Record<string, number>)
      .map(([k, v]) => `${k}: ${fmt(v)}`)
      .join(', ')
  return groups.map((g) => `${g}: { ${line(g)} },`).join('\n')
}

export default function TuningPanel() {
  const [visible, setVisible] = useState(false)
  // Bumped on every slider change to re-render the (uncontrolled-source) inputs.
  const [, force] = useState(0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 't' || e.key === 'T') setVisible((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!visible) return null

  const onChange = (g: Group, k: string, v: number) => {
    set(g, k, v)
    force((n) => n + 1)
  }

  const copy = () => {
    void navigator.clipboard?.writeText(serialize()).catch(() => {})
  }

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <strong style={{ fontSize: 13, color: '#ffd166' }}>⚙ Tuning (dev)</strong>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#6b7590' }}>
          press <kbd style={kbdStyle}>t</kbd> to hide
        </span>
      </div>

      {SECTIONS.map((section) => (
        <div key={section.title} style={{ marginBottom: 10 }}>
          <div style={sectionTitleStyle}>{section.title}</div>
          {section.rows.map((r) => (
            <div key={`${r.group}.${r.key}`} style={{ marginBottom: 6 }}>
              <div style={rowHeadStyle}>
                <span style={{ color: '#aeb6c8' }}>{r.label}</span>
                <span style={valStyle}>{fmt(get(r.group, r.key))}</span>
              </div>
              <input
                type="range"
                min={r.min}
                max={r.max}
                step={r.step}
                value={get(r.group, r.key)}
                onChange={(e) => onChange(r.group, r.key, parseFloat(e.target.value))}
                style={sliderStyle}
              />
            </div>
          ))}
        </div>
      ))}

      <div style={dividerStyle} />
      <div style={{ fontSize: 10, color: '#6b7590', marginBottom: 4 }}>
        Current values — paste into <code>src/tuning.ts</code>:
      </div>
      <pre style={preStyle}>{serialize()}</pre>
      <button onClick={copy} style={buttonStyle}>
        Copy values
      </button>
    </div>
  )
}

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  // Sit just left of the debug overlay (right: 16, width: 300) so both can be
  // open side by side: 16 + 300 + 12px gap.
  top: 16,
  right: 328,
  width: 260,
  maxHeight: '82vh',
  overflowY: 'auto',
  padding: 14,
  background: 'rgba(14, 10, 6, 0.9)',
  border: '1px solid rgba(255,209,102,0.3)',
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

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  color: '#8a7a5a',
  margin: '2px 0 6px',
}

const rowHeadStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  fontSize: 11,
  marginBottom: 1,
}

const valStyle: React.CSSProperties = {
  marginLeft: 'auto',
  color: '#ffd166',
  fontVariantNumeric: 'tabular-nums',
}

const sliderStyle: React.CSSProperties = {
  width: '100%',
  accentColor: '#ffd166',
  cursor: 'pointer',
}

const dividerStyle: React.CSSProperties = {
  height: 1,
  background: 'rgba(255,255,255,0.08)',
  margin: '8px 0',
}

const preStyle: React.CSSProperties = {
  margin: '0 0 8px',
  padding: 8,
  background: 'rgba(0,0,0,0.35)',
  borderRadius: 6,
  fontSize: 10,
  lineHeight: 1.5,
  color: '#d8dceb',
  whiteSpace: 'pre',
  overflowX: 'auto',
  userSelect: 'text',
}

const buttonStyle: React.CSSProperties = {
  appearance: 'none',
  border: '1px solid rgba(255,209,102,0.4)',
  background: 'rgba(255,209,102,0.12)',
  color: '#ffd166',
  fontSize: 12,
  fontWeight: 600,
  padding: '5px 12px',
  borderRadius: 8,
  cursor: 'pointer',
  width: '100%',
}

const kbdStyle: React.CSSProperties = {
  padding: '1px 4px',
  borderRadius: 3,
  border: '1px solid rgba(255,255,255,0.2)',
  background: 'rgba(255,255,255,0.06)',
  fontSize: 10,
}
