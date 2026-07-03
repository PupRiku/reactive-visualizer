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
  /** ParticleSwarm (energetic) score weights. Higher = more likely to win. */
  swarm: {
    tempo: 0.45, // fast tempo -> energetic
    beat: 0.4, // driving/frequent beat -> energetic
    bright: 0.15, // brighter timbre leans energetic
  },
  /** FluidPlasma (calm) score weights — the mirror of the swarm. */
  plasma: {
    slow: 0.45, // slow tempo -> calm
    sparse: 0.4, // little/no beat -> calm
    dark: 0.15, // dark timbre -> calm
  },
  /** tempoNorm window edges (BPM): min -> 0, max -> 1. Recenter to your music. */
  tempoNorm: {
    min: 90,
    max: 160,
  },
  /** Brightness window (centroid/Nyquist, ~0..0.5) used by the dark/bright score term. */
  bright: {
    lo: 0.05,
    hi: 0.3,
  },
  /** Director timing / thresholds. */
  director: {
    minHold: 10, // seconds a challenger must lead before a switch pends
    switchMargin: 0.12, // required score lead over the current style
    cooldown: 4, // seconds after a switch before new challengers count
    scoreSmoothTau: 0.8, // seconds; EMA smoothing of scores before comparison
    challengerLeak: 0.5, // fraction of dt the hold timer decays on a brief dip
  },
}
