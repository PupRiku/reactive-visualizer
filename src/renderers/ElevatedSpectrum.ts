/**
 * Renderer 4: Elevated spectrum (build plan v1.3, stage 3).
 *
 * Owns the STEADY RHYTHMIC GROOVE corner — high pulse but LOW volatility, the
 * locked-in four-on-the-floor pocket, as opposed to the swarm's explosive
 * high-flux energy. Visually an art-directed RADIAL spectrum: FFT bins mapped
 * around a circle on a LOG-frequency scale, each a glowing bar extending outward
 * from a base ring that pulses cleanly on the beat. Composed and elegant — not a
 * Winamp bar graph.
 *
 * FFT source: the shared analyser's bins, read from `features.spectrum` (filled
 * by the feature extractor each frame). This renderer opens NO second
 * AnalyserNode.
 *
 * Feature mapping:
 *   spectrum   -> per-bar heights (log-frequency bins, attack-decay smoothed)
 *   bass       -> base ring radius / overall swell
 *   brightness -> palette (warm/dark <-> cool/bright)
 *   beat       -> a clean ring pulse (edge-triggered on beatCount; not re-detected)
 *   flux       -> subtle only (a touch of extra rotation) — this style is steady
 *
 * Anti-jitter: the slow rotation is integrated (`rotation += dt * rate`), never
 * `elapsedTime * rate`, so an audio-varying rate can't jump the phase.
 */

import * as THREE from 'three'
import type { Features } from '../audio/features'
import type { Renderer, RendererContext } from './types'
import { buildFeatureVector, clamp01, prototypeVector, scoreAgainstProfile, smoothstep } from './scoring'
import { tuning } from '../tuning'

// Composition (world units; the ortho camera spans y in [-WORLD_S, WORLD_S]).
const WORLD_S = 1.0
const N_BARS = 128
const BASE_RADIUS = 0.42 // radius of the base ring at rest
const HEIGHT_FLOOR = 0.03 // every bar keeps this length, so it never flat-lines
const HEIGHT_SPAN = 0.42 // reactive bar extension (scaled by intensity)
const BAR_FILL = 0.6 // fraction of each angular slot the bar occupies (gaps between)
const GAIN = 1.7 // gentle boost on raw bin energy before clamping

// Ring swell / pulse.
const BASS_SWELL = 0.1 // bass grows the base radius
const BEAT_SWELL = 0.05 // clean radius pop on the beat
const BEAT_DECAY = 3.5 // beat-pulse decay per second

// Rotation (rad/s). Slow base keeps it alive; flux adds a subtle-only nudge.
const ROT_BASE = 0.05
const ROT_FLUX = 0.14

// Per-bar attack-decay (rise fast, fall slow) so heights read musical, not noisy.
const ATTACK = 0.55
const DECAY = 0.12

// Log-frequency window the ring spans.
const F_MIN = 30
const F_MAX = 16000

const BAR_VERTEX = /* glsl */ `
  precision highp float;
  attribute float aEnd;   // 0 at the bar base (on the ring), 1 at the glowing tip
  varying float vT;
  void main() {
    vT = aEnd;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const BAR_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uMix;     // brightness palette 0..1
  uniform float uOpacity;
  varying float vT;
  void main() {
    // Warm (dark timbre) <-> cool (bright timbre); dark base -> glowing tip.
    vec3 warmBase = vec3(0.25, 0.02, 0.14);
    vec3 warmTip  = vec3(1.00, 0.55, 0.15);
    vec3 coolBase = vec3(0.10, 0.03, 0.32);
    vec3 coolTip  = vec3(0.30, 0.95, 1.00);
    vec3 base = mix(warmBase, coolBase, clamp(uMix, 0.0, 1.0));
    vec3 tip  = mix(warmTip,  coolTip,  clamp(uMix, 0.0, 1.0));
    vec3 col = mix(base, tip, vT) * (0.35 + 0.95 * vT);
    gl_FragColor = vec4(col, uOpacity);
  }
`

const RING_VERTEX = /* glsl */ `
  precision highp float;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const RING_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uMix;
  uniform float uBeat;    // decaying beat pulse 0..1 (already intensity-scaled)
  uniform float uOpacity;
  void main() {
    vec3 warm = vec3(1.0, 0.55, 0.2);
    vec3 cool = vec3(0.35, 0.95, 1.0);
    vec3 col = mix(warm, cool, clamp(uMix, 0.0, 1.0));
    gl_FragColor = vec4(col * (0.55 + 2.2 * uBeat), uOpacity);
  }
`

export class ElevatedSpectrum implements Renderer {
  private hostRenderer: THREE.WebGLRenderer | null = null
  private scene: THREE.Scene | null = null
  private camera: THREE.OrthographicCamera | null = null

  private bars: THREE.Mesh | null = null
  private barsGeo: THREE.BufferGeometry | null = null
  private barsMat: THREE.ShaderMaterial | null = null

  private ring: THREE.Mesh | null = null
  private ringGeo: THREE.RingGeometry | null = null
  private ringMat: THREE.ShaderMaterial | null = null

  // Preallocated bar state.
  private readonly positions = new Float32Array(N_BARS * 6 * 3) // 2 tris * 3 verts
  private readonly barSmooth = new Float32Array(N_BARS) // attack-decay heights
  private readonly dirCos = new Float32Array(N_BARS * 2) // [cosL, cosR] per bar
  private readonly dirSin = new Float32Array(N_BARS * 2) // [sinL, sinR] per bar
  private barLo: Int32Array | null = null // per-bar FFT bin range (log mapping)
  private barHi: Int32Array | null = null
  private binsBuilt = false

  private rotation = 0 // integrated ring rotation
  private beatPulse = 0
  private lastBeatCount = 0
  private intensity = 1

  init(ctx: RendererContext): void {
    this.hostRenderer = ctx.renderer
    this.scene = new THREE.Scene()
    this.camera = this.makeCamera(ctx.width, ctx.height)

    // Precompute each bar's angular direction (cos/sin of its two edges). The
    // whole ring rotates via mesh.rotation, so these stay constant.
    const slot = (Math.PI * 2) / N_BARS
    const hw = (slot * BAR_FILL) / 2
    for (let j = 0; j < N_BARS; j++) {
      const a = j * slot
      this.dirCos[j * 2] = Math.cos(a - hw)
      this.dirSin[j * 2] = Math.sin(a - hw)
      this.dirCos[j * 2 + 1] = Math.cos(a + hw)
      this.dirSin[j * 2 + 1] = Math.sin(a + hw)
    }

    // aEnd: 0 for the two base verts, 1 for the tip verts. Vert order per bar:
    // [innerL, innerR, outerR,  innerL, outerR, outerL].
    const aEnd = new Float32Array(N_BARS * 6)
    for (let j = 0; j < N_BARS; j++) {
      const o = j * 6
      aEnd[o] = 0
      aEnd[o + 1] = 0
      aEnd[o + 2] = 1
      aEnd[o + 3] = 0
      aEnd[o + 4] = 1
      aEnd[o + 5] = 1
    }

    this.barsGeo = new THREE.BufferGeometry()
    this.barsGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage),
    )
    this.barsGeo.setAttribute('aEnd', new THREE.BufferAttribute(aEnd, 1))

    this.barsMat = new THREE.ShaderMaterial({
      uniforms: { uMix: { value: 0 }, uOpacity: { value: 1 } },
      vertexShader: BAR_VERTEX,
      fragmentShader: BAR_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    })
    this.bars = new THREE.Mesh(this.barsGeo, this.barsMat)
    this.bars.frustumCulled = false
    this.scene.add(this.bars)

    // Base ring: a thin unit annulus, scaled to the live base radius each frame.
    this.ringGeo = new THREE.RingGeometry(0.985, 1.015, 192)
    this.ringMat = new THREE.ShaderMaterial({
      uniforms: { uMix: { value: 0 }, uBeat: { value: 0 }, uOpacity: { value: 1 } },
      vertexShader: RING_VERTEX,
      fragmentShader: RING_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    })
    this.ring = new THREE.Mesh(this.ringGeo, this.ringMat)
    this.ring.frustumCulled = false
    this.scene.add(this.ring)
  }

  private makeCamera(width: number, height: number): THREE.OrthographicCamera {
    const aspect = width / Math.max(1, height)
    const cam = new THREE.OrthographicCamera(
      -aspect * WORLD_S,
      aspect * WORLD_S,
      WORLD_S,
      -WORLD_S,
      0.1,
      100,
    )
    cam.position.z = 5
    return cam
  }

  score(features: Features): number {
    // v1.3: proximity of the shared feature vector to the spectrum prototype.
    return scoreAgainstProfile(buildFeatureVector(features), prototypeVector(tuning.spectrumProto))
  }

  /** Build per-bar FFT bin ranges once we know the spectrum layout (log scale). */
  private buildBins(binCount: number, binWidth: number): void {
    const nyquist = binCount * binWidth
    const fMax = Math.min(F_MAX, nyquist * 0.95)
    const fMin = Math.min(F_MIN, fMax * 0.5)
    const ratio = fMax / fMin
    this.barLo = new Int32Array(N_BARS)
    this.barHi = new Int32Array(N_BARS)
    for (let j = 0; j < N_BARS; j++) {
      const f0 = fMin * Math.pow(ratio, j / N_BARS)
      const f1 = fMin * Math.pow(ratio, (j + 1) / N_BARS)
      const lo = Math.min(binCount - 1, Math.max(1, Math.floor(f0 / binWidth)))
      const hi = Math.min(binCount - 1, Math.max(lo, Math.ceil(f1 / binWidth)))
      this.barLo[j] = lo
      this.barHi[j] = hi
    }
    this.binsBuilt = true
  }

  update(features: Features, dt: number): void {
    if (!this.barsMat || !this.ringMat || !this.bars || !this.ring) return

    const f = features.normalized
    const iv = this.intensity
    const spec = features.spectrum

    // Lazily learn the FFT layout (constant once capture starts).
    if (!this.binsBuilt && spec.length > 0 && features.spectrumBinWidth > 0) {
      this.buildBins(spec.length, features.spectrumBinWidth)
    }

    // Beat pulse: edge-trigger on beatCount (do NOT re-detect), then decay.
    if (features.beatCount > this.lastBeatCount) {
      this.beatPulse = 1
      this.lastBeatCount = features.beatCount
    }
    this.beatPulse *= Math.exp(-BEAT_DECAY * dt)

    // Slow rotation, integrated. Flux adds only a subtle nudge (steady style).
    this.rotation += (ROT_BASE + f.motion * ROT_FLUX * iv) * dt
    this.bars.rotation.z = this.rotation
    this.ring.rotation.z = this.rotation

    // Base radius: swells with bass and pops cleanly on the beat.
    const r0 = BASE_RADIUS + (f.bass * BASS_SWELL + this.beatPulse * BEAT_SWELL) * iv
    this.ring.scale.setScalar(r0)

    // Per-bar heights from the log-mapped FFT bins, attack-decay smoothed.
    const pos = this.positions
    for (let j = 0; j < N_BARS; j++) {
      let target = 0
      if (this.binsBuilt && this.barLo && this.barHi && spec.length > 0) {
        const lo = this.barLo[j]
        const hi = this.barHi[j]
        let sum = 0
        for (let b = lo; b <= hi; b++) sum += spec[b]
        target = clamp01((sum / (hi - lo + 1) / 255) * GAIN)
      }
      const cur = this.barSmooth[j]
      this.barSmooth[j] = cur + (target - cur) * (target > cur ? ATTACK : DECAY)

      const h = HEIGHT_FLOOR + this.barSmooth[j] * HEIGHT_SPAN * iv
      const rOut = r0 + h
      const cL = this.dirCos[j * 2]
      const sL = this.dirSin[j * 2]
      const cR = this.dirCos[j * 2 + 1]
      const sR = this.dirSin[j * 2 + 1]

      // Two triangles: [innerL, innerR, outerR, innerL, outerR, outerL].
      const o = j * 18
      // innerL
      pos[o] = r0 * cL
      pos[o + 1] = r0 * sL
      pos[o + 2] = 0
      // innerR
      pos[o + 3] = r0 * cR
      pos[o + 4] = r0 * sR
      pos[o + 5] = 0
      // outerR
      pos[o + 6] = rOut * cR
      pos[o + 7] = rOut * sR
      pos[o + 8] = 0
      // innerL
      pos[o + 9] = r0 * cL
      pos[o + 10] = r0 * sL
      pos[o + 11] = 0
      // outerR
      pos[o + 12] = rOut * cR
      pos[o + 13] = rOut * sR
      pos[o + 14] = 0
      // outerL
      pos[o + 15] = rOut * cL
      pos[o + 16] = rOut * sL
      pos[o + 17] = 0
    }
    ;(this.barsGeo!.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true

    const mix = smoothstep(tuning.bright.lo, tuning.bright.hi, f.brightness)
    this.barsMat.uniforms.uMix.value = mix
    this.ringMat.uniforms.uMix.value = mix
    this.ringMat.uniforms.uBeat.value = this.beatPulse * iv
  }

  render(): void {
    if (!this.scene || !this.camera || !this.hostRenderer) return
    this.hostRenderer.render(this.scene, this.camera)
  }

  setOpacity(value: number): void {
    const v = Math.min(1, Math.max(0, value))
    if (this.barsMat) this.barsMat.uniforms.uOpacity.value = v
    if (this.ringMat) this.ringMat.uniforms.uOpacity.value = v
  }

  setIntensity(value: number): void {
    this.intensity = Math.min(2, Math.max(0, value))
  }

  resize(width: number, height: number): void {
    if (!this.camera) return
    const aspect = width / Math.max(1, height)
    this.camera.left = -aspect * WORLD_S
    this.camera.right = aspect * WORLD_S
    this.camera.top = WORLD_S
    this.camera.bottom = -WORLD_S
    this.camera.updateProjectionMatrix()
  }

  dispose(): void {
    if (this.scene) {
      if (this.bars) this.scene.remove(this.bars)
      if (this.ring) this.scene.remove(this.ring)
    }
    this.barsGeo?.dispose()
    this.barsMat?.dispose()
    this.ringGeo?.dispose()
    this.ringMat?.dispose()
    this.barsGeo = null
    this.barsMat = null
    this.ringGeo = null
    this.ringMat = null
    this.bars = null
    this.ring = null
    this.scene = null
    this.camera = null
    this.hostRenderer = null
  }
}
