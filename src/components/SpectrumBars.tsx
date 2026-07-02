import { useEffect, useRef } from 'react'

interface SpectrumBarsProps {
  /** Live analyser to read frequency data from, or null when not capturing. */
  analyser: AnalyserNode | null
}

/**
 * Step 1 proof: a plain spectrum-bar display driven by getByteFrequencyData.
 * This is intentionally simple (a 2D canvas, no Three.js) — its only job is to
 * confirm audio is flowing before we build real renderers.
 */
export default function SpectrumBars({ analyser }: SpectrumBarsProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let rafId = 0
    // Backed by an explicit ArrayBuffer so the type matches
    // getByteFrequencyData's Uint8Array<ArrayBuffer> parameter (TS 5.7+).
    let freq: Uint8Array<ArrayBuffer> | null = null

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.floor(canvas.clientWidth * dpr)
      canvas.height = Math.floor(canvas.clientHeight * dpr)
    }
    resize()
    window.addEventListener('resize', resize)

    const draw = () => {
      rafId = requestAnimationFrame(draw)
      const w = canvas.width
      const h = canvas.height

      ctx.clearRect(0, 0, w, h)

      if (!analyser) return

      if (!freq || freq.length !== analyser.frequencyBinCount) {
        freq = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
      }
      analyser.getByteFrequencyData(freq)

      // Draw a subset of bins — the top FFT bins are usually near-silent, so
      // showing ~the lower 3/4 gives a livelier display.
      const usableBins = Math.floor(freq.length * 0.75)
      const barWidth = w / usableBins

      for (let i = 0; i < usableBins; i++) {
        const value = freq[i] / 255 // 0..1
        const barHeight = value * h

        // Hue sweeps blue -> magenta across the spectrum; brighter with energy.
        const hue = 220 + (i / usableBins) * 140
        ctx.fillStyle = `hsl(${hue}, 90%, ${25 + value * 45}%)`
        ctx.fillRect(i * barWidth, h - barHeight, Math.max(barWidth - 1, 1), barHeight)
      }
    }
    draw()

    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', resize)
    }
  }, [analyser])

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
    />
  )
}
