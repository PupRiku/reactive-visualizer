/**
 * Dev-only LIVE tuning config (build plan step 6).
 *
 * A single mutable object holding the director/scoring parameters that used to be
 * scattered as module-level `const`s. The hot-path code (scoring, both renderers'
 * score(), the director) reads from here every frame, and the dev Tuning panel
 * (press 't') mutates it at runtime — so changes apply immediately with no
 * rebuild. This is a DEVELOPER instrument, NOT the v1.1 user controls.
 *
 * The values below are the canonical DEFAULTS. When tuning finds good settings,
 * copy the panel's printout back over this literal to make them the new defaults.
 *
 * This module imports nothing app-specific on purpose (keeps it cycle-free).
 */
export const tuning = {
  /**
   * v1.3 scoring model (multi-axis). Each frame `scoring.buildFeatureVector`
   * builds a normalized [energy, pulse, bright, flux] vector, and every style
   * scores by proximity to its own prototype point (see `scoreAgainstProfile`).
   * Prototypes and the one axis-blend param live here so the Tuning panel can
   * edit them live. Axis meanings:
   *   energy = blend of tempo + loudness (overall intensity)
   *   pulse  = rhythmic drive (beatActivity)
   *   bright = spectral centroid via the `bright` window (smoothstep)
   *   flux   = normalized spectral flux (volatility)
   */
  axes: {
    // Energy blend: fraction from tempo vs loudness. 1 = all tempo, 0 = all
    // (AGC) loudness, 0.5 = even. Loudness uses the volume-independent AGC value.
    energyTempoMix: 0.5,
  },
  /** ParticleSwarm prototype [energy, pulse, bright, flux] — explosive/energetic. */
  swarmProto: {
    energy: 0.9,
    pulse: 0.85,
    bright: 0.6,
    flux: 0.85,
  },
  /** FluidPlasma prototype [energy, pulse, bright, flux] — calm/ambient/dark. */
  plasmaProto: {
    energy: 0.2,
    pulse: 0.2,
    bright: 0.3,
    flux: 0.25,
  },
  /** tempoNorm window edges (BPM): min -> 0, max -> 1. Recenter to your music. */
  tempoNorm: {
    min: 90,
    max: 160,
  },
  /** Brightness window (centroid/Nyquist, ~0..0.5) feeding the `bright` axis. */
  bright: {
    lo: 0.05,
    hi: 0.3,
  },
  /** Director timing / thresholds. */
  director: {
    minHold: 10, // seconds a challenger must lead before a switch pends
    // Lowered from 0.12 (v1.2): proximity scores bunch closer than the old
    // complementary 0/1 sums, so a smaller lead now signals a genuine switch.
    switchMargin: 0.08, // required score lead over the current style
    cooldown: 4, // seconds after a switch before new challengers count
    scoreSmoothTau: 0.8, // seconds; EMA smoothing of scores before comparison
    challengerLeak: 0.5, // fraction of dt the hold timer decays on a brief dip
  },
}
