import { useEffect, useRef } from 'react'
import { FeatureExtractor, type Features } from '../audio/features'

/**
 * Runs a single requestAnimationFrame loop that updates a FeatureExtractor once
 * per frame and stashes the latest Features in a ref. Deliberately does NOT
 * trigger React re-renders — consumers (the debug overlay, later the renderers)
 * read `featuresRef.current` from their own loops. One update() per frame keeps
 * spectral flux's previous-frame comparison correct.
 *
 * Returns a ref whose `.current` is null until capture starts.
 */
export function useFeatures(analyser: AnalyserNode | null) {
  const featuresRef = useRef<Features | null>(null)

  useEffect(() => {
    if (!analyser) {
      featuresRef.current = null
      return
    }

    const extractor = new FeatureExtractor(analyser)
    let rafId = 0

    const tick = () => {
      rafId = requestAnimationFrame(tick)
      featuresRef.current = extractor.update(performance.now())
    }
    tick()

    return () => {
      cancelAnimationFrame(rafId)
      featuresRef.current = null
    }
  }, [analyser])

  return featuresRef
}
