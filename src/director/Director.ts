/**
 * Layer 3: The director (build plan step 5).
 *
 * Reads the audio features each frame, scores every renderer, and decides which
 * style should be on screen — then crossfades between them. The whole point is
 * COMMITMENT: without hysteresis a borderline song flickers between styles every
 * second. So a challenger must out-score the current style by a margin for a
 * sustained stretch, and the actual switch only lands on a musical boundary (the
 * 4-beat `bar` tick standing in for a downbeat), followed by a cooldown.
 *
 * The director does not render; it manages selection + transition state and sets
 * each renderer's opacity via setOpacity(). The canvas asks getRenderList() for
 * the renderers to draw this frame (1 when stable, 2 during a crossfade).
 */

import type { Features } from '../audio/features'
import type { Renderer } from '../renderers/types'

// --- Tunable timing / thresholds --------------------------------------------
/** A challenger must lead for this long (seconds) before a switch is pending. */
export const MIN_HOLD_SECONDS = 10
/** Challenger must beat the current style's score by at least this much. */
export const SWITCH_MARGIN = 0.12
/** Crossfade duration (seconds) once a switch commits. */
export const CROSSFADE_SECONDS = 1.5
/** After a switch completes, ignore new challengers for this long (seconds). */
export const COOLDOWN_SECONDS = 4
/**
 * How long a pending switch will wait for a downbeat before committing anyway.
 * We prefer to land switches on a bar tick, but ambient/beatless passages never
 * produce one — so after this long we commit unaligned rather than never.
 */
export const SWITCH_MAX_WAIT_SECONDS = 4
/**
 * Time constant (seconds) for smoothing each style's score before the director
 * compares them. The per-frame scores are noisy (tempo/beat jitter); smoothing
 * keeps a brief wobble from flipping the leader and resetting the hold timer.
 */
export const SCORE_SMOOTH_TAU = 0.8
/**
 * How fast the challenger's hold timer decays when it briefly stops leading,
 * as a fraction of dt. Leaking (instead of hard-resetting) lets a sustained but
 * noisy challenger keep its progress through short dips. 0 = never lose progress,
 * 1 = decay as fast as it accrues.
 */
export const CHALLENGER_LEAK = 0.5

export type DirectorPhase = 'STABLE' | 'TRANSITIONING'

export interface StyleScore {
  name: string
  score: number
}

/** Snapshot of director state for the debug overlay (built fresh each frame). */
export interface DirectorState {
  auto: boolean
  phase: DirectorPhase
  currentName: string
  scores: StyleScore[]
  challengerName: string | null
  challengerTimer: number
  minHoldSeconds: number
  switchPending: boolean
  transitionProgress: number // 0..1 (0 while stable)
  cooldownRemaining: number
}

interface Style {
  name: string
  renderer: Renderer
}

export class Director {
  private readonly styles: Style[]

  private currentIndex = 0
  private phase: DirectorPhase = 'STABLE'

  // Challenger tracking (auto mode).
  private challengerIndex: number | null = null
  private challengerTimer = 0
  private switchPending = false
  private pendingTimer = 0 // time switchPending has been waiting for a downbeat
  private cooldown = 0

  // Transition tracking.
  private fromIndex = 0
  private toIndex = 0
  private transitionTimer = 0

  // Bar-tick edge detection (the 4-beat "downbeat" we switch on).
  private lastBar = 0

  private auto = true

  // Raw per-frame scores and their smoothed form (what the director acts on).
  private scores: number[] = []
  private scoresSmoothed: number[] = []

  constructor(styles: Style[]) {
    this.styles = styles
    this.scores = styles.map(() => 0)
    this.scoresSmoothed = styles.map(() => 0)
    // Start with the first style fully visible.
    styles.forEach((s, i) => s.renderer.setOpacity(i === this.currentIndex ? 1 : 0))
  }

  /** Advance the state machine and set renderer opacities. Call once per frame. */
  update(features: Features, dt: number): void {
    // Score everyone every frame, then smooth so the comparison isn't at the
    // mercy of per-frame tempo/beat jitter.
    const smooth = 1 - Math.exp(-dt / SCORE_SMOOTH_TAU)
    for (let i = 0; i < this.styles.length; i++) {
      this.scores[i] = this.styles[i].renderer.score(features)
      this.scoresSmoothed[i] += (this.scores[i] - this.scoresSmoothed[i]) * smooth
    }

    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt)

    if (this.phase === 'TRANSITIONING') {
      this.advanceTransition(dt)
      this.applyOpacities()
      return
    }

    // --- STABLE ---
    const barTicked = this.detectBarTick(features)

    if (this.auto && this.cooldown === 0) {
      this.evaluateChallenger(dt)
      if (this.switchPending && this.challengerIndex !== null) {
        // Prefer to land the switch on a downbeat, but don't wait forever:
        // ambient/beatless passages never tick a bar, so commit after a timeout.
        this.pendingTimer += dt
        if (barTicked || this.pendingTimer >= SWITCH_MAX_WAIT_SECONDS) {
          this.beginTransition(this.currentIndex, this.challengerIndex)
        }
      }
    } else {
      // Manual mode (or cooling down): no automatic challenger accrual.
      this.resetChallenger()
    }

    this.applyOpacities()
  }

  /** Renderers to draw this frame, in draw order (outgoing first, incoming last). */
  getRenderList(): Renderer[] {
    if (this.phase === 'TRANSITIONING') {
      return [this.styles[this.fromIndex].renderer, this.styles[this.toIndex].renderer]
    }
    return [this.styles[this.currentIndex].renderer]
  }

  /** Toggle automatic direction on/off. Returns the new value. */
  toggleAuto(): boolean {
    this.auto = !this.auto
    this.resetChallenger()
    return this.auto
  }

  isAuto(): boolean {
    return this.auto
  }

  /**
   * Force a specific style (manual controls). Honored only when auto is OFF and
   * we're not mid-transition; still uses the crossfade.
   */
  forceIndex(index: number): void {
    if (this.auto) return
    if (this.phase === 'TRANSITIONING') return
    if (index < 0 || index >= this.styles.length) return
    if (index === this.currentIndex) return
    this.beginTransition(this.currentIndex, index)
  }

  /** Build a fresh state snapshot for the debug overlay. */
  getState(): DirectorState {
    const progress =
      this.phase === 'TRANSITIONING'
        ? Math.min(1, this.transitionTimer / CROSSFADE_SECONDS)
        : 0
    return {
      auto: this.auto,
      phase: this.phase,
      currentName: this.styles[this.currentIndex].name,
      // Report the smoothed scores — that's what the director actually compares.
      scores: this.styles.map((s, i) => ({ name: s.name, score: this.scoresSmoothed[i] ?? 0 })),
      challengerName:
        this.challengerIndex !== null ? this.styles[this.challengerIndex].name : null,
      challengerTimer: this.challengerTimer,
      minHoldSeconds: MIN_HOLD_SECONDS,
      switchPending: this.switchPending,
      transitionProgress: progress,
      cooldownRemaining: this.cooldown,
    }
  }

  // --- internals ------------------------------------------------------------

  /** Accumulate (or leak) the challenger timer based on the smoothed scores. */
  private evaluateChallenger(dt: number): void {
    const topIndex = this.argmaxScore()
    const currentScore = this.scoresSmoothed[this.currentIndex]
    const topScore = this.scoresSmoothed[topIndex]
    const viable = topIndex !== this.currentIndex && topScore - currentScore > SWITCH_MARGIN

    if (viable) {
      if (this.challengerIndex !== topIndex) {
        // A different challenger took the lead — restart its clocks.
        this.challengerIndex = topIndex
        this.challengerTimer = 0
        this.switchPending = false
        this.pendingTimer = 0
      }
      this.challengerTimer += dt
      if (this.challengerTimer >= MIN_HOLD_SECONDS) {
        this.switchPending = true
      }
    } else if (this.challengerIndex !== null) {
      // The current challenger briefly lost its lead. Leak its timer instead of
      // hard-resetting, so a short wobble doesn't wipe a long, genuine hold.
      this.challengerTimer -= dt * CHALLENGER_LEAK
      if (this.challengerTimer <= 0) this.resetChallenger()
    }
  }

  private beginTransition(from: number, to: number): void {
    if (from === to) return
    this.phase = 'TRANSITIONING'
    this.fromIndex = from
    this.toIndex = to
    this.transitionTimer = 0
    this.resetChallenger()
  }

  private advanceTransition(dt: number): void {
    this.transitionTimer += dt
    if (this.transitionTimer >= CROSSFADE_SECONDS) {
      // Landed. The incoming style is now current; start the cooldown.
      this.phase = 'STABLE'
      this.currentIndex = this.toIndex
      this.cooldown = COOLDOWN_SECONDS
      this.resetChallenger()
    }
  }

  private applyOpacities(): void {
    if (this.phase === 'TRANSITIONING') {
      const p = Math.min(1, this.transitionTimer / CROSSFADE_SECONDS)
      for (let i = 0; i < this.styles.length; i++) {
        const o = i === this.fromIndex ? 1 - p : i === this.toIndex ? p : 0
        this.styles[i].renderer.setOpacity(o)
      }
    } else {
      for (let i = 0; i < this.styles.length; i++) {
        this.styles[i].renderer.setOpacity(i === this.currentIndex ? 1 : 0)
      }
    }
  }

  private resetChallenger(): void {
    this.challengerIndex = null
    this.challengerTimer = 0
    this.switchPending = false
    this.pendingTimer = 0
  }

  private argmaxScore(): number {
    let best = 0
    for (let i = 1; i < this.scoresSmoothed.length; i++) {
      if (this.scoresSmoothed[i] > this.scoresSmoothed[best]) best = i
    }
    return best
  }

  /** True on the frame the 4-beat bar counter increments (our "downbeat"). */
  private detectBarTick(features: Features): boolean {
    const bar = features.bar
    if (bar > this.lastBar) {
      this.lastBar = bar
      return true
    }
    // Capture restarted (extractor reset bar to 0): resync without a tick.
    if (bar < this.lastBar) this.lastBar = bar
    return false
  }
}
