import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import type { Features } from '../audio/features'
import { ParticleSwarm } from '../renderers/ParticleSwarm'
import { FluidPlasma } from '../renderers/FluidPlasma'
import { ReactiveGeometry } from '../renderers/ReactiveGeometry'
import { ElevatedSpectrum } from '../renderers/ElevatedSpectrum'
import { Director, type DirectorState } from '../director/Director'

/**
 * Imperative command handle the control bar (in App) calls to drive the single
 * Director that lives inside this component — the down-channel mirroring the
 * onStatus up-channel. Populated once the canvas effect has built the director;
 * null before that and after unmount.
 */
export interface VisualizerControls {
  /** Toggle auto (self-driving) vs manual. */
  toggleAuto(): void
  /** Select a style AND drop to manual (so the user needn't turn auto off first). */
  selectStyle(index: number): void
  /** Set the global visual intensity dial (0..2) on every renderer. */
  setIntensity(value: number): void
  /** Current auto flag (for reflecting state). */
  isAuto(): boolean
}

interface VisualizerCanvasProps {
  /** Live features, updated once per frame by useFeatures (null until capture). */
  featuresRef: React.RefObject<Features | null>
  /** Director writes a fresh state snapshot here each frame (for the overlay). */
  directorRef?: React.MutableRefObject<DirectorState | null>
  /** Notified when the current style or auto flag changes (for the top panel). */
  onStatus?: (status: { current: string; auto: boolean }) => void
  /** Populated with the imperative command handle for the control bar. */
  controlsRef?: React.MutableRefObject<VisualizerControls | null>
}

/**
 * Owns the single WebGLRenderer, the Director, and the frame loop.
 *
 * Each frame: clear once, let the director advance its state machine and set
 * renderer opacities, then update()+render() every renderer in the director's
 * render list. During a crossfade that list holds BOTH renderers (outgoing then
 * incoming) and we draw them over a single cleared frame with autoClear off, so
 * neither wipes the other.
 *
 * Keys (temporary dev controls, formalized in v1.1): 'a' toggles auto direction;
 * when auto is OFF, '1'/'2' force ParticleSwarm/FluidPlasma (still crossfading).
 */
export default function VisualizerCanvas({
  featuresRef,
  directorRef,
  onStatus,
  controlsRef,
}: VisualizerCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const glRenderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    glRenderer.setClearColor(0x05060a, 1)
    glRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
    // We composite up to two renderers per frame, so clear exactly once
    // ourselves and let neither renderer clear the buffer.
    glRenderer.autoClear = false

    const sizeOf = () => ({
      width: canvas.clientWidth || window.innerWidth,
      height: canvas.clientHeight || window.innerHeight,
    })

    let { width, height } = sizeOf()
    glRenderer.setSize(width, height, false)

    // Build the renderers and hand them to the director. Index order defines the
    // '1'/'2'/'3' force keys below.
    const swarm = new ParticleSwarm()
    const plasma = new FluidPlasma()
    const geometry = new ReactiveGeometry()
    const spectrum = new ElevatedSpectrum()
    for (const r of [swarm, plasma, geometry, spectrum]) {
      r.init({ renderer: glRenderer, width, height })
    }

    const director = new Director([
      { name: 'ParticleSwarm', renderer: swarm },
      { name: 'FluidPlasma', renderer: plasma },
      { name: 'ReactiveGeometry', renderer: geometry },
      { name: 'ElevatedSpectrum', renderer: spectrum },
    ])

    // Report current-style / auto changes up to the panel only when they change.
    let lastCurrent = ''
    let lastAuto = director.isAuto()
    const pushStatus = () => {
      const s = director.getState()
      if (s.currentName !== lastCurrent || s.auto !== lastAuto) {
        lastCurrent = s.currentName
        lastAuto = s.auto
        onStatus?.({ current: s.currentName, auto: s.auto })
      }
    }
    pushStatus()

    // Expose the imperative command handle for the control bar. Same single
    // director — no second instance. selectStyle() flips to manual first so a
    // style click always lands (forceIndex is ignored while auto is on).
    const applyIntensity = (value: number) => {
      const v = Math.min(2, Math.max(0, value))
      swarm.setIntensity?.(v)
      plasma.setIntensity?.(v)
      geometry.setIntensity?.(v)
      spectrum.setIntensity?.(v)
    }
    if (controlsRef) {
      controlsRef.current = {
        toggleAuto: () => {
          director.toggleAuto()
          pushStatus()
        },
        selectStyle: (index: number) => {
          if (director.isAuto()) director.toggleAuto()
          director.forceIndex(index)
          pushStatus()
        },
        setIntensity: applyIntensity,
        isAuto: () => director.isAuto(),
      }
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'a' || e.key === 'A') {
        director.toggleAuto()
        pushStatus()
      } else if (e.key === '1') {
        director.forceIndex(0)
      } else if (e.key === '2') {
        director.forceIndex(1)
      } else if (e.key === '3') {
        director.forceIndex(2)
      } else if (e.key === '4') {
        director.forceIndex(3)
      }
    }
    window.addEventListener('keydown', onKey)

    const resize = () => {
      ;({ width, height } = sizeOf())
      glRenderer.setSize(width, height, false)
      swarm.resize?.(width, height)
      plasma.resize?.(width, height)
      geometry.resize?.(width, height)
      spectrum.resize?.(width, height)
    }
    window.addEventListener('resize', resize)

    let rafId = 0
    let last = performance.now()
    const loop = () => {
      rafId = requestAnimationFrame(loop)
      const now = performance.now()
      // Clamp dt so a background tab / hitch doesn't jump the sim or transitions.
      let dt = (now - last) / 1000
      last = now
      if (dt > 0.05) dt = 0.05

      const features = featuresRef.current ?? IDLE_FEATURES

      // Director decides selection + crossfade and sets opacities.
      director.update(features, dt)
      if (directorRef) directorRef.current = director.getState()
      pushStatus()

      // Clear the frame ONCE, then draw each active renderer with no clear
      // between them (autoClear is off) so they composite instead of wiping.
      glRenderer.setRenderTarget(null)
      glRenderer.clear()
      for (const r of director.getRenderList()) {
        r.update(features, dt)
        r.render()
      }
    }
    loop()

    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', resize)
      window.removeEventListener('keydown', onKey)
      swarm.dispose()
      plasma.dispose()
      geometry.dispose()
      spectrum.dispose()
      glRenderer.dispose()
      if (directorRef) directorRef.current = null
      if (controlsRef) controlsRef.current = null
    }
    // featuresRef/directorRef are stable refs; set up the WebGL context once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
    />
  )
}

/** All-zero features so the visuals idle before/without capture. */
const IDLE_FEATURES: Features = {
  raw: { bass: 0, mid: 0, treble: 0, loudness: 0, brightness: 0, motion: 0 },
  smoothed: { bass: 0, mid: 0, treble: 0, loudness: 0, brightness: 0, motion: 0 },
  normalized: { bass: 0, mid: 0, treble: 0, loudness: 0, brightness: 0, motion: 0 },
  brightnessHz: 0,
  beat: false,
  beatEnvelope: 0,
  beatActivity: 0,
  beatCount: 0,
  bar: 0,
  bpm: 0,
  sinceLastBeatMs: 0,
  spectrum: new Uint8Array(0),
  spectrumBinWidth: 0,
}
