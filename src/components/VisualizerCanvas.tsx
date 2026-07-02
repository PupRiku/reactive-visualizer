import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import type { Features } from '../audio/features'
import { ParticleSwarm } from '../renderers/ParticleSwarm'
import { FluidPlasma } from '../renderers/FluidPlasma'
import type { Renderer } from '../renderers/types'

interface VisualizerCanvasProps {
  /** Live features, updated once per frame by useFeatures (null until capture). */
  featuresRef: React.RefObject<Features | null>
  /** Notified when the active renderer changes (dev toggle: '1'/'2'). */
  onActiveChange?: (name: string) => void
}

/**
 * Owns the single WebGLRenderer and the frame loop. Each frame it reads the
 * latest features and calls activeRenderer.update(features, dt) then .render().
 * When capture isn't running yet, it drives the active renderer with a zeroed
 * feature set so the visuals idle (alive even in silence) behind the start UI.
 *
 * Step 4 dev scaffold: both renderers are constructed and init'd up front; only
 * ONE runs at a time. Press '1' for ParticleSwarm, '2' for FluidPlasma. This is
 * a temporary manual switch — the director (step 5) will replace it with scored
 * selection and crossfades. No simultaneous rendering / blending here yet.
 */
export default function VisualizerCanvas({
  featuresRef,
  onActiveChange,
}: VisualizerCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const glRenderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    glRenderer.setClearColor(0x05060a, 1)
    // Clamp pixel ratio: full-screen shaders (plasma) get expensive at native
    // high-DPI. 1.5 is a good balance for both renderers.
    glRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))

    const sizeOf = () => ({
      width: canvas.clientWidth || window.innerWidth,
      height: canvas.clientHeight || window.innerHeight,
    })

    let { width, height } = sizeOf()
    glRenderer.setSize(width, height, false)

    // Build both renderers; only the active one updates/renders each frame.
    const registry: { key: string; name: string; renderer: Renderer }[] = [
      { key: '1', name: 'ParticleSwarm', renderer: new ParticleSwarm() },
      { key: '2', name: 'FluidPlasma', renderer: new FluidPlasma() },
    ]
    for (const r of registry) r.renderer.init({ renderer: glRenderer, width, height })

    let active = registry[0]
    onActiveChange?.(active.name)

    const onKey = (e: KeyboardEvent) => {
      const hit = registry.find((r) => r.key === e.key)
      if (hit && hit !== active) {
        active = hit
        onActiveChange?.(hit.name)
      }
    }
    window.addEventListener('keydown', onKey)

    const resize = () => {
      ;({ width, height } = sizeOf())
      glRenderer.setSize(width, height, false)
      for (const r of registry) r.renderer.resize?.(width, height)
    }
    window.addEventListener('resize', resize)

    let rafId = 0
    let last = performance.now()
    const loop = () => {
      rafId = requestAnimationFrame(loop)
      const now = performance.now()
      // Clamp dt so a background tab / hitch doesn't launch the swarm to infinity.
      let dt = (now - last) / 1000
      last = now
      if (dt > 0.05) dt = 0.05

      const features = featuresRef.current ?? IDLE_FEATURES
      active.renderer.update(features, dt)
      active.renderer.render()
    }
    loop()

    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', resize)
      window.removeEventListener('keydown', onKey)
      for (const r of registry) r.renderer.dispose()
      glRenderer.dispose()
    }
    // featuresRef is a stable ref; set up the WebGL context exactly once.
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
  brightnessHz: 0,
  beat: false,
  beatEnvelope: 0,
  beatCount: 0,
  bar: 0,
  bpm: 0,
  sinceLastBeatMs: 0,
}
