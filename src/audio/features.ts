/**
 * Layer 2: Analysis / feature extraction (build plan step 2)
 *
 * Turns the live AnalyserNode into a single `Features` object every frame:
 * band energies, loudness (RMS), brightness (spectral centroid), motion
 * (spectral flux), and beat/tempo. Every continuous feature is available both
 * raw (this frame) and smoothed with an attack-decay envelope (rise fast, fall
 * slow) so downstream visuals don't jitter on noisy values.
 *
 * This module is framework-agnostic: construct a FeatureExtractor around an
 * AnalyserNode and call update(now) once per frame. All Hz->bin math is derived
 * from the analyser at runtime (binWidth = sampleRate / fftSize); nothing is
 * hardcoded, so it stays correct if the fftSize or device sample rate changes.
 */

/** Continuous features that have both a raw and a smoothed form. */
export interface ContinuousFeatures {
  /** Bass band energy (~20-250 Hz), 0..1. */
  bass: number
  /** Mid band energy (~250-4000 Hz), 0..1. */
  mid: number
  /** Treble band energy (~4000-16000 Hz), 0..1. */
  treble: number
  /** Loudness / RMS of the waveform, ~0..1. */
  loudness: number
  /** Brightness: spectral centroid normalized to 0..1 (centroid / Nyquist). */
  brightness: number
  /** Motion: spectral flux, 0..1. High = spectrum changing fast. */
  motion: number
}

export interface Features {
  /** This-frame values, unsmoothed. */
  raw: ContinuousFeatures
  /** Attack-decay smoothed values (rise fast, fall slow). */
  smoothed: ContinuousFeatures
  /**
   * Auto-gained (AGC) values, 0..1. Each energy channel is normalized against
   * its own slowly-decaying recent peak, so it reads its dynamics RELATIVE to
   * the stream — robust to however loud or quiet the capture happens to be.
   * This is what the visuals should react to so they stay lively regardless of
   * capture level. `brightness` is passed through unchanged (a spectral ratio,
   * already level-independent).
   */
  normalized: ContinuousFeatures

  /** Spectral centroid in Hz (the un-normalized brightness). */
  brightnessHz: number

  /** True only on the single frame a beat onset is detected. */
  beat: boolean
  /** Beat flash envelope: spikes to 1 on each beat, decays smoothly toward 0. */
  beatEnvelope: number
  /**
   * Rhythmic drive, 0..1: bumped to 1 on each beat and decaying over ~1.5s, so
   * it stays high while a steady beat plays and falls toward 0 when beats are
   * sparse/absent. Volume-independent — the director's main "is this energetic"
   * signal alongside tempo.
   */
  beatActivity: number
  /** Total beats detected since capture started. */
  beatCount: number
  /** Coarse "bar" counter — increments every 4 beats (stand-in downbeat). */
  bar: number
  /** Rough tempo estimate in BPM (0 until enough beats seen). */
  bpm: number
  /** Milliseconds since the last detected beat. */
  sinceLastBeatMs: number
}

export interface FeatureExtractorOptions {
  /** Envelope rise rate per frame (fast). Default 0.5. */
  attack?: number
  /** Envelope fall rate per frame (slow). Default 0.1. */
  decay?: number
  /**
   * Beat sensitivity: the per-frame RISE in bass energy must exceed its running
   * average times this factor to count as an onset. Higher = fewer beats. Set a
   * touch high so we catch the strong kicks and skip weaker off-beat onsets
   * (which otherwise inflate the tempo estimate). Default 1.7.
   */
  beatSensitivity?: number
  /**
   * Minimum gap between beats in ms (debounce). Also acts as a coarse tempo
   * guard: set high enough to merge the subdivisions (hi-hats, snares, ghost
   * notes) between the main kicks so the tempo estimate tracks the felt beat
   * rather than every onset. Caps detectable tempo at 60000/this BPM. Default
   * 330 (~182 BPM ceiling).
   */
  beatDebounceMs?: number
  /**
   * Minimum bass RISE (per-frame increase in bass energy) below which we never
   * fire a beat — rejects frame-to-frame noise. Default 0.03.
   */
  beatFloor?: number
  /**
   * A beat also requires a spectral-flux spike: this-frame motion must exceed
   * its running average times this factor. Percussive hits are broadband and
   * spike the flux; tonal swells/arpeggios (ambient) raise bass but barely move
   * it, so this rejects their false onsets. Default 1.6.
   */
  beatFluxFactor?: number
}

/** Band edges in Hz. Kept here so the mapping is obvious and tweakable. */
const BANDS = {
  bass: [20, 250],
  mid: [250, 4000],
  treble: [4000, 16000],
} as const

/** Only intervals inside this ms range feed the BPM estimate (~40-240 BPM). */
const MIN_INTERVAL_MS = 250
const MAX_INTERVAL_MS = 1500

/**
 * Preferred musical BPM range for octave folding. Percussive subdivisions can
 * pass the onset gate and, on slower songs, clear the debounce — halving the
 * intervals and roughly doubling the estimated BPM. After computing the raw BPM
 * we fold it into this range (halve while too fast, double while too slow) so
 * the number tracks the felt beat. 76..152 is exactly one octave and covers
 * house / circuit / K-pop / EDM without misfiring. Easy to retune here.
 */
const PREFERRED_MIN = 76
const PREFERRED_MAX = 152
/**
 * Bias for the octave sanity check (in normalized-variance units): the faster
 * alternative octave must be more self-consistent than the in-range fold by at
 * least this much to be chosen. Keeps the check from flip-flopping on noise.
 */
const OCTAVE_ALIGN_BIAS = 0.02

/**
 * If no beat arrives for this long (ms), treat the tempo as unknown and reset
 * it. Otherwise a slow/beatless passage would hold the previous song's BPM,
 * keeping the slow-tempo scoring term from ever engaging. Set above the slowest
 * accepted beat interval so a genuinely slow groove isn't wiped mid-song.
 */
const BPM_STALE_MS = 2000

/** Auto-gain (AGC) time constant, seconds — how quickly the peak reference fades. */
const AGC_TAU_SEC = 8
/** Beat-activity envelope time constant, seconds (rhythmic-drive decay). */
const BEAT_ACTIVITY_TAU_SEC = 1.5
/** Per-channel AGC floors — a small guard so silence reads low, not div-by-zero. */
const AGC_FLOOR = {
  bass: 0.02,
  mid: 0.02,
  treble: 0.02,
  loudness: 0.01,
  motion: 0.005,
}

export class FeatureExtractor {
  private readonly analyser: AnalyserNode
  private readonly sampleRate: number
  private readonly binWidth: number
  private readonly binCount: number

  // Reused per-frame buffers (allocated once, no per-frame GC).
  private readonly freq: Uint8Array<ArrayBuffer>
  private readonly time: Uint8Array<ArrayBuffer>
  private readonly prevMag: Float32Array

  // Precomputed inclusive bin ranges for each band.
  private readonly bassBins: [number, number]
  private readonly midBins: [number, number]
  private readonly trebleBins: [number, number]

  private readonly opts: Required<FeatureExtractorOptions>

  // Smoothing state.
  private readonly smoothed: ContinuousFeatures = {
    bass: 0,
    mid: 0,
    treble: 0,
    loudness: 0,
    brightness: 0,
    motion: 0,
  }

  // Auto-gained (AGC) values + one gain tracker per energy channel.
  private readonly normalized: ContinuousFeatures = {
    bass: 0,
    mid: 0,
    treble: 0,
    loudness: 0,
    brightness: 0,
    motion: 0,
  }
  private readonly agc = {
    bass: new AutoGain(AGC_FLOOR.bass, AGC_TAU_SEC),
    mid: new AutoGain(AGC_FLOOR.mid, AGC_TAU_SEC),
    treble: new AutoGain(AGC_FLOOR.treble, AGC_TAU_SEC),
    loudness: new AutoGain(AGC_FLOOR.loudness, AGC_TAU_SEC),
    motion: new AutoGain(AGC_FLOOR.motion, AGC_TAU_SEC),
  }

  // Beat / tempo state.
  private prevBass = 0 // previous frame's bass energy (for the rise / flux)
  private bassFluxAvg = 0 // running average of the positive bass rise
  private motionAvg = 0 // running average of spectral flux (for the beat gate)
  private lastBeatTime = 0 // performance.now() of the last beat
  private beatEnvelope = 0
  private beatActivity = 0 // slow-decay rhythmic-drive signal
  private beatCount = 0
  private bar = 0
  private bpm = 0
  private readonly intervals: number[] = [] // recent inter-beat gaps (ms)
  private firstFrame = true
  private prevNow = 0 // performance.now() of the previous frame, for dt

  // The single Features object we mutate and hand back each frame.
  private readonly out: Features = {
    raw: { bass: 0, mid: 0, treble: 0, loudness: 0, brightness: 0, motion: 0 },
    smoothed: this.smoothed,
    normalized: this.normalized,
    brightnessHz: 0,
    beat: false,
    beatEnvelope: 0,
    beatActivity: 0,
    beatCount: 0,
    bar: 0,
    bpm: 0,
    sinceLastBeatMs: 0,
  }

  constructor(analyser: AnalyserNode, options: FeatureExtractorOptions = {}) {
    this.analyser = analyser
    this.sampleRate = analyser.context.sampleRate
    this.binCount = analyser.frequencyBinCount // = fftSize / 2
    this.binWidth = this.sampleRate / analyser.fftSize

    this.freq = new Uint8Array(new ArrayBuffer(this.binCount))
    this.time = new Uint8Array(new ArrayBuffer(analyser.fftSize))
    this.prevMag = new Float32Array(this.binCount)

    this.bassBins = this.binRange(BANDS.bass[0], BANDS.bass[1])
    this.midBins = this.binRange(BANDS.mid[0], BANDS.mid[1])
    this.trebleBins = this.binRange(BANDS.treble[0], BANDS.treble[1])

    this.opts = {
      attack: options.attack ?? 0.5,
      decay: options.decay ?? 0.1,
      beatSensitivity: options.beatSensitivity ?? 1.7,
      beatDebounceMs: options.beatDebounceMs ?? 330,
      beatFloor: options.beatFloor ?? 0.03,
      beatFluxFactor: options.beatFluxFactor ?? 1.6,
    }
  }

  /** Map a Hz range to an inclusive [loBin, hiBin] clamped to valid bins. */
  private binRange(loHz: number, hiHz: number): [number, number] {
    const lo = Math.max(0, Math.floor(loHz / this.binWidth))
    const hi = Math.min(this.binCount - 1, Math.ceil(hiHz / this.binWidth))
    return [lo, hi]
  }

  /** Mean of freq bins in [lo, hi], scaled 0..1. */
  private bandEnergy([lo, hi]: [number, number]): number {
    let sum = 0
    let n = 0
    for (let i = lo; i <= hi; i++) {
      sum += this.freq[i]
      n++
    }
    return n > 0 ? sum / n / 255 : 0
  }

  /**
   * Compute all features for this frame. Pass performance.now() as `now`.
   * Returns a stable Features object (mutated in place each call).
   */
  update(now: number): Features {
    this.analyser.getByteFrequencyData(this.freq)
    this.analyser.getByteTimeDomainData(this.time)

    // Frame delta in seconds (for AGC/beat-activity decay). Clamp so a hitch or
    // background tab doesn't collapse the running references.
    const dt = this.prevNow > 0 ? Math.min(0.1, (now - this.prevNow) / 1000) : 0
    this.prevNow = now

    // --- Band energies (0..1) ---
    const bass = this.bandEnergy(this.bassBins)
    const mid = this.bandEnergy(this.midBins)
    const treble = this.bandEnergy(this.trebleBins)

    // --- Loudness (RMS) from the time-domain waveform ---
    let sumSq = 0
    for (let i = 0; i < this.time.length; i++) {
      const x = (this.time[i] - 128) / 128 // -1..1
      sumSq += x * x
    }
    const loudness = Math.sqrt(sumSq / this.time.length)

    // --- Brightness (spectral centroid) + Motion (spectral flux) ---
    // Single pass over the magnitude bins: accumulate the centroid weights and
    // the half-wave-rectified frame-to-frame difference at the same time.
    let weighted = 0 // sum(freq_i * mag_i)
    let magSum = 0 // sum(mag_i)
    let flux = 0 // sum(max(0, mag_i - prevMag_i))
    for (let i = 0; i < this.binCount; i++) {
      const mag = this.freq[i]
      weighted += i * this.binWidth * mag
      magSum += mag
      const diff = mag - this.prevMag[i]
      if (diff > 0) flux += diff
      this.prevMag[i] = mag
    }
    const brightnessHz = magSum > 0 ? weighted / magSum : 0
    const nyquist = this.sampleRate / 2
    const brightness = nyquist > 0 ? brightnessHz / nyquist : 0
    // Normalize flux: worst case every bin jumps a full 0->255 step.
    const motion = flux / (this.binCount * 255)

    // --- Beat detection: onsets from the RISE in bass energy (bass flux) ---
    // We key off the positive frame-to-frame increase in bass, not its absolute
    // level. On loud tracks the bass band sits near saturation, so an
    // absolute-vs-average test becomes unreachable (avg climbs to ~max, and
    // max * sensitivity > 1.0 can't be exceeded). The rise, by contrast, is ~0
    // while bass is held high and spikes on each kick, so the running average of
    // the rise stays low and onsets remain detectable.
    let beat = false
    if (this.firstFrame) {
      this.prevBass = bass
      this.firstFrame = false
    }
    const bassRise = Math.max(0, bass - this.prevBass)
    this.prevBass = bass

    // A real beat is a broadband transient: alongside the bass rise, this-frame
    // spectral flux must spike above its baseline. Tonal swells/arpeggios raise
    // bass but barely move the flux, so this gate rejects their false onsets.
    const fluxSpike = motion > this.motionAvg * this.opts.beatFluxFactor

    const sinceLast = now - this.lastBeatTime
    const threshold = this.bassFluxAvg * this.opts.beatSensitivity
    if (
      bassRise > threshold &&
      bassRise > this.opts.beatFloor &&
      fluxSpike &&
      (this.lastBeatTime === 0 || sinceLast >= this.opts.beatDebounceMs)
    ) {
      beat = true
      this.registerBeat(now)
    }
    // Update the running averages AFTER the test so a beat frame doesn't inflate
    // its own thresholds. EMAs — low between kicks, so they stay meaningful
    // baselines the next onset can clear.
    this.bassFluxAvg += (bassRise - this.bassFluxAvg) * 0.1
    this.motionAvg += (motion - this.motionAvg) * 0.1

    // Let the tempo estimate go stale when the beat stops, so slow/ambient
    // passages read as low-tempo instead of holding the last song's BPM.
    if (this.lastBeatTime > 0 && now - this.lastBeatTime > BPM_STALE_MS) {
      this.bpm = 0
      this.intervals.length = 0
    }

    // --- Envelopes ---
    this.smoothOne('bass', bass)
    this.smoothOne('mid', mid)
    this.smoothOne('treble', treble)
    this.smoothOne('loudness', loudness)
    this.smoothOne('brightness', brightness)
    this.smoothOne('motion', motion)

    // Beat flash envelope: snap to 1 on a beat, otherwise decay toward 0.
    this.beatEnvelope = beat ? 1 : this.beatEnvelope * 0.9
    // Rhythmic-drive envelope: snap to 1 on a beat, decay slowly so it stays
    // high through a steady groove and falls off when beats stop.
    this.beatActivity = beat
      ? 1
      : this.beatActivity * Math.exp(-dt / BEAT_ACTIVITY_TAU_SEC)

    // --- Auto-gain: normalize each energy channel against its recent peak ---
    const n = this.normalized
    n.bass = this.agc.bass.normalize(this.smoothed.bass, dt)
    n.mid = this.agc.mid.normalize(this.smoothed.mid, dt)
    n.treble = this.agc.treble.normalize(this.smoothed.treble, dt)
    n.loudness = this.agc.loudness.normalize(this.smoothed.loudness, dt)
    n.motion = this.agc.motion.normalize(this.smoothed.motion, dt)
    // Brightness is a spectral ratio already independent of level — pass through.
    n.brightness = this.smoothed.brightness

    // --- Pack the output object ---
    const raw = this.out.raw
    raw.bass = bass
    raw.mid = mid
    raw.treble = treble
    raw.loudness = loudness
    raw.brightness = brightness
    raw.motion = motion

    this.out.brightnessHz = brightnessHz
    this.out.beat = beat
    this.out.beatEnvelope = this.beatEnvelope
    this.out.beatActivity = this.beatActivity
    this.out.beatCount = this.beatCount
    this.out.bar = this.bar
    this.out.bpm = this.bpm
    this.out.sinceLastBeatMs = this.lastBeatTime === 0 ? 0 : now - this.lastBeatTime

    return this.out
  }

  /** Record a beat, advance the bar counter, and refresh the BPM estimate. */
  private registerBeat(now: number): void {
    if (this.lastBeatTime > 0) {
      const interval = now - this.lastBeatTime
      if (interval >= MIN_INTERVAL_MS && interval <= MAX_INTERVAL_MS) {
        this.intervals.push(interval)
        if (this.intervals.length > 8) this.intervals.shift()
        const med = median(this.intervals)
        if (med > 0) this.bpm = this.estimateBpm(med)
      }
    }
    this.lastBeatTime = now
    this.beatCount++
    // Every 4 beats marks a coarse "bar" / stand-in downbeat.
    this.bar = Math.floor(this.beatCount / 4)
  }

  /**
   * Turn a median inter-beat interval into a BPM, octave-folded into the
   * preferred musical range so subdivision over-fires don't double the tempo.
   */
  private estimateBpm(medianMs: number): number {
    const rawBpm = 60000 / medianMs

    // Fold into [PREFERRED_MIN, PREFERRED_MAX] (one octave).
    let folded = rawBpm
    while (folded > PREFERRED_MAX) folded /= 2
    while (folded < PREFERRED_MIN) folded *= 2

    // Octave sanity check: if a single fold happened (raw ~2x the folded value),
    // the true beat could be at either octave. Prefer whichever the observed
    // intervals align to most tightly. Variance is normalized by period so
    // doubling small intervals doesn't unfairly inflate the slower octave.
    const ratio = rawBpm / folded
    if (ratio > 1.5 && ratio < 2.5) {
      // We halved once; the faster alternative is the un-folded octave.
      const alt = folded * 2
      if (this.octaveAlignCv(60000 / alt) + OCTAVE_ALIGN_BIAS < this.octaveAlignCv(60000 / folded)) {
        folded = alt
      }
    } else if (ratio > 0.4 && ratio < 0.67) {
      // We doubled once; the slower alternative is the un-folded octave.
      const alt = folded / 2
      if (this.octaveAlignCv(60000 / alt) + OCTAVE_ALIGN_BIAS < this.octaveAlignCv(60000 / folded)) {
        folded = alt
      }
    }

    return Math.round(folded)
  }

  /**
   * Self-consistency of the recent intervals against a candidate beat period:
   * fold each interval to the nearest octave of `periodMs`, then return the
   * variance normalized by period^2 (a coefficient-of-variation squared, so it's
   * scale-independent). Lower = the onsets sit more cleanly at that period.
   */
  private octaveAlignCv(periodMs: number): number {
    const xs = this.intervals
    if (xs.length < 2 || periodMs <= 0) return Infinity
    let sum = 0
    let sumSq = 0
    for (const x of xs) {
      let v = x
      while (v > periodMs * 1.5) v *= 0.5
      while (v < periodMs * 0.75) v *= 2
      sum += v
      sumSq += v * v
    }
    const mean = sum / xs.length
    const variance = sumSq / xs.length - mean * mean
    return variance / (periodMs * periodMs)
  }

  /** Attack-decay update for one smoothed channel: rise fast, fall slow. */
  private smoothOne(key: keyof ContinuousFeatures, target: number): void {
    const cur = this.smoothed[key]
    const rate = target > cur ? this.opts.attack : this.opts.decay
    this.smoothed[key] = cur + (target - cur) * rate
  }
}

/** Median of a non-empty numeric array (does not mutate the input). */
function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

/**
 * Simple auto-gain (AGC): tracks a slowly-decaying "recent peak" reference and
 * reports each value as a fraction of it (0..1). The reference jumps up instantly
 * to new peaks and forgets old ones over ~tauSec, so a channel reads its own
 * dynamics regardless of absolute capture level. The floor keeps genuine silence
 * reading low (and avoids divide-by-zero).
 */
class AutoGain {
  private ceil: number

  constructor(
    private readonly floor: number,
    private readonly tauSec: number,
  ) {
    this.ceil = floor
  }

  normalize(value: number, dt: number): number {
    this.ceil *= Math.exp(-dt / this.tauSec) // forget old peaks
    if (value > this.ceil) this.ceil = value // ...but rise instantly to new ones
    if (this.ceil < this.floor) this.ceil = this.floor
    return this.ceil > 0 ? Math.min(1, value / this.ceil) : 0
  }
}
