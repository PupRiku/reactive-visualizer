/**
 * Scoring helpers shared by the renderers' score(features) methods (build plan
 * layer 3 / step 5), reworked for v1.3's multi-axis model.
 *
 * Instead of each style summing its own ad-hoc weighted terms, every frame we
 * build ONE normalized feature vector, and each style scores by proximity to its
 * own prototype point in that space (`scoreAgainstProfile`). This scales cleanly:
 * a new style is just a new prototype, not new bespoke math.
 */

import type { Features } from '../audio/features'
import { tuning } from '../tuning'

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
 * Map a BPM estimate to 0..1 where slow≈0 and fast≈1. The window edges live in
 * `tuning.tempoNorm` (default 90 -> 0, 160 -> 1) so they can be recentered live.
 * Unknown tempo (bpm <= 0, before enough beats) returns a neutral-low 0.3 so it
 * doesn't spuriously favor the "fast" style.
 */
export function tempoNorm(bpm: number): number {
  if (!bpm || bpm <= 0) return 0.3
  const { min, max } = tuning.tempoNorm
  return clamp01((bpm - min) / Math.max(1, max - min))
}

// --- v1.3 multi-axis scoring ------------------------------------------------

/** The feature-vector axes, in the order every vector/prototype uses. */
export const AXES = ['energy', 'pulse', 'bright', 'flux'] as const
export type Axis = (typeof AXES)[number]

/** A per-style ideal point in feature space, one value per axis (0..1). */
export type Prototype = Record<Axis, number>

/**
 * Build the shared normalized feature vector for this frame, [energy, pulse,
 * bright, flux], each 0..1 (see the axis notes in tuning.ts). Loudness in the
 * energy blend uses the AGC (normalized) value so the decision stays
 * volume-independent, consistent with the rest of the director.
 */
export function buildFeatureVector(f: Features): number[] {
  const mix = clamp01(tuning.axes.energyTempoMix)
  const energy = clamp01(mix * tempoNorm(f.bpm) + (1 - mix) * f.normalized.loudness)
  const pulse = clamp01(f.beatActivity)
  const bright = smoothstep(tuning.bright.lo, tuning.bright.hi, f.smoothed.brightness)
  const flux = clamp01(f.normalized.motion)
  return [energy, pulse, bright, flux]
}

/** A prototype object as an axis-ordered array, ready for scoreAgainstProfile. */
export function prototypeVector(proto: Prototype): number[] {
  return AXES.map((a) => proto[a])
}

/**
 * Proximity score of a feature vector to a style's prototype: 1 minus the
 * weighted, normalized Euclidean distance between them, clamped to 0..1. Higher
 * = closer = better fit. With axes in 0..1 the normalization divides by the sum
 * of weights, so the worst-possible distance maps to 0 and an exact match to 1
 * regardless of how many axes or what weights are used. `weights` defaults to 1
 * per axis (all axes equal).
 */
export function scoreAgainstProfile(
  vector: number[],
  prototype: number[],
  weights?: number[],
): number {
  const n = Math.min(vector.length, prototype.length)
  let weightedSq = 0
  let weightSum = 0
  for (let i = 0; i < n; i++) {
    const w = weights?.[i] ?? 1
    const d = vector[i] - prototype[i]
    weightedSq += w * d * d
    weightSum += w
  }
  const dist = Math.sqrt(weightedSq / Math.max(1e-6, weightSum))
  return clamp01(1 - dist)
}
