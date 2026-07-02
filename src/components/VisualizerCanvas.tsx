import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import type { Features } from '../audio/features'
import { ParticleSwarm } from '../renderers/ParticleSwarm'
import type { Renderer } from '../renderers/types'

interface VisualizerCanvasProps {
  /** Live features, updated once per frame by useFeatures (null until capture). */
  featuresRef: React.RefObject<Features | null>
}

/**
 * Owns the single WebGLRenderer and the frame loop. Each frame it reads the
 * latest features and calls renderer.update(features, dt) then renderer.render().
 * When capture isn't running yet, it drives the swarm with a zeroed feature set
 * so the cloud idles (alive even in silence) behind the start UI.
 */
export default function VisualizerCanvas({ featuresRef }: VisualizerCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const glRenderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    glRenderer.setClearColor(0x05060a, 1)
    glRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))

    const sizeOf = () => ({
      width: canvas.clientWidth || window.innerWidth,
      height: canvas.clientHeight || window.innerHeight,
    })

    let { width, height } = sizeOf()
    glRenderer.setSize(width, height, false)

    const renderer: Renderer = new ParticleSwarm()
    renderer.init({ renderer: glRenderer, width, height })

    const resize = () => {
      ;({ width, height } = sizeOf())
      glRenderer.setSize(width, height, false)
      renderer.resize?.(width, height)
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

      renderer.update(featuresRef.current ?? IDLE_FEATURES, dt)
      renderer.render()
    }
    loop()

    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', resize)
      renderer.dispose()
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

/** All-zero features so the swarm idles before/without capture. */
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
