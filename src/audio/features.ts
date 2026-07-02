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

  /** Spectral centroid in Hz (the un-normalized brightness). */
  brightnessHz: number

  /** True only on the single frame a beat onset is detected. */
  beat: boolean
  /** Beat flash envelope: spikes to 1 on each beat, decays smoothly toward 0. */
  beatEnvelope: number
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
   * Beat sensitivity: bass must exceed its running average times this factor to
   * count as an onset. Higher = fewer beats. Default 1.4.
   */
  beatSensitivity?: number
  /** Minimum gap between beats in ms (debounce). Default 200. */
  beatDebounceMs?: number
  /** Bass floor below which we never fire a beat (ignore near-silence). Default 0.02. */
  beatFloor?: number
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

  // Beat / tempo state.
  private bassAvg = 0 // running average of bass energy
  private lastBeatTime = 0 // performance.now() of the last beat
  private beatEnvelope = 0
  private beatCount = 0
  private bar = 0
  private bpm = 0
  private readonly intervals: number[] = [] // recent inter-beat gaps (ms)
  private firstFrame = true

  // The single Features object we mutate and hand back each frame.
  private readonly out: Features = {
    raw: { bass: 0, mid: 0, treble: 0, loudness: 0, brightness: 0, motion: 0 },
    smoothed: this.smoothed,
    brightnessHz: 0,
    beat: false,
    beatEnvelope: 0,
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
      beatSensitivity: options.beatSensitivity ?? 1.4,
      beatDebounceMs: options.beatDebounceMs ?? 200,
      beatFloor: options.beatFloor ?? 0.02,
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

    // --- Beat detection: bass onset above a running average ---
    let beat = false
    if (this.firstFrame) {
      this.bassAvg = bass
      this.firstFrame = false
    }
    const sinceLast = now - this.lastBeatTime
    const isPeak = bass > this.bassAvg * this.opts.beatSensitivity
    if (
      isPeak &&
      bass > this.opts.beatFloor &&
      (this.lastBeatTime === 0 || sinceLast >= this.opts.beatDebounceMs)
    ) {
      beat = true
      this.registerBeat(now)
    }
    // Update the running average AFTER the test so a beat frame doesn't inflate
    // its own threshold. EMA — fast enough to track dynamics, slow enough to
    // stay a meaningful baseline.
    this.bassAvg += (bass - this.bassAvg) * 0.1

    // --- Envelopes ---
    this.smoothOne('bass', bass)
    this.smoothOne('mid', mid)
    this.smoothOne('treble', treble)
    this.smoothOne('loudness', loudness)
    this.smoothOne('brightness', brightness)
    this.smoothOne('motion', motion)

    // Beat flash envelope: snap to 1 on a beat, otherwise decay toward 0.
    this.beatEnvelope = beat ? 1 : this.beatEnvelope * 0.9

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
        if (med > 0) this.bpm = Math.round(60000 / med)
      }
    }
    this.lastBeatTime = now
    this.beatCount++
    // Every 4 beats marks a coarse "bar" / stand-in downbeat.
    this.bar = Math.floor(this.beatCount / 4)
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
