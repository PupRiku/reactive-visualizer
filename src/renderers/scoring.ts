/**
 * Small normalization helpers shared by the renderers' score(features) methods
 * (build plan layer 3 / step 5). Kept generic and dependency-free so both
 * renderers can map raw features into comparable 0..1 terms before the director
 * weighs them against each other.
 */

/** Clamp to 0..1. */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** GLSL-style smoothstep (Hermite interpolation, clamped). */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/**
 * Map a BPM estimate to 0..1 where slow≈0 and fast≈1 (≈90 BPM -> 0, ≈160 -> 1).
 * Unknown tempo (bpm <= 0, before enough beats) returns a neutral-low 0.3 so it
 * doesn't spuriously favor the "fast" style.
 */
export function tempoNorm(bpm: number): number {
  if (!bpm || bpm <= 0) return 0.3
  return clamp01((bpm - 90) / 70)
}
