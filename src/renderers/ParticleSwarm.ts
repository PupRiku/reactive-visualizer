/**
 * Renderer 1: Particle swarms (build plan step 3).
 *
 * A single THREE.Points cloud of PARTICLE_COUNT particles. Each particle has a
 * home position, a live position (updated in place in one preallocated
 * Float32Array — geometry is never recreated), and a velocity. A spring pulls
 * each particle back toward its home while a gentle swirl keeps the swarm alive
 * even in silence; audio features modulate speed, size, color, turbulence, and
 * fire a radial burst on every beat.
 *
 * Feature mapping:
 *   loudness   -> overall motion speed / liveliness
 *   bass       -> particle size + swarm expansion (homes pushed outward)
 *   treble     -> per-particle sparkle (shader flicker)
 *   brightness -> palette shift, warm (dark) <-> cool (bright)
 *   motion     -> velocity turbulence
 *   beat       -> outward radial impulse that damps back ("pop")
 */

import * as THREE from 'three'
import type { Features } from '../audio/features'
import type { Renderer, RendererContext } from './types'
import { smoothstep, tempoNorm } from './scoring'
import { tuning } from '../tuning'

const PARTICLE_COUNT = 4000

// ParticleSwarm is the ENERGETIC style. Its director score leans on
// VOLUME-INDEPENDENT musical cues — fast tempo, a driving beat, and brighter
// timbre — rather than absolute loudness, which swings with capture level.
// (Loudness/bass/motion still drive the *visuals*, via the auto-gained values.)
// The score weights and the brightness window live in `tuning` so they can be
// adjusted live from the dev Tuning panel; defaults are in tuning.ts.

// Geometry / camera framing.
const SWARM_RADIUS = 6 // radius of the home sphere (world units)
const CAM_Z = 14 // camera distance from origin

// Motion model (all frame-rate independent — spring/damper integrated with dt).
const SPRING = 3.5 // pull back toward (expanded) home
const DAMP_PER_SEC = 2.4 // velocity decay: v *= exp(-DAMP_PER_SEC * dt)
const BASE_SWIRL = 0.25 // constant swirl so the swarm breathes when quiet
const SWIRL_LOUD = 1.1 // extra swirl from loudness
const EXPAND_BASS = 0.9 // how far bass pushes homes outward (fraction)
const TURB_SCALE = 9.0 // turbulence accel from spectral flux
const BURST_STRENGTH = 9.0 // outward velocity impulse on a beat
const LIVELINESS_MIN = 0.5 // motion-speed multiplier at silence
const LIVELINESS_LOUD = 1.6 // extra motion speed from loudness

// Size / color.
const BASE_SIZE = 0.6 // base shader point size before bass boost
const SIZE_BASS = 1.1 // extra size from bass
const WARM = new THREE.Color(0xff6a2a) // dark / bassy tracks
const COOL = new THREE.Color(0x2ad0ff) // bright / airy tracks

const VERTEX_SHADER = /* glsl */ `
  uniform float uSize;
  uniform float uTreble;
  uniform float uTime;
  uniform float uPixelRatio;
  attribute float aSeed;
  varying float vSparkle;
  varying float vSeed;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);

    // Per-particle flicker; treble scales how strongly it sparkles.
    float flick = sin(uTime * (4.0 + aSeed * 22.0) + aSeed * 99.0) * 0.5 + 0.5;
    vSparkle = uTreble * flick;

    float sizeVar = 0.5 + aSeed; // 0.5..1.5 spread so sizes aren't uniform
    // Perspective attenuation: divide by view-space depth.
    gl_PointSize = uSize * sizeVar * (1.0 + vSparkle * 1.8) * uPixelRatio * (220.0 / -mv.z);

    vSeed = aSeed;
    gl_Position = projectionMatrix * mv;
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uWarm;
  uniform vec3 uCool;
  uniform float uMix;     // 0 = warm, 1 = cool
  uniform float uOpacity; // for crossfades
  varying float vSparkle;
  varying float vSeed;

  void main() {
    // Soft round sprite: radial falloff, discard outside the disc.
    vec2 c = gl_PointCoord - vec2(0.5);
    float d = length(c);
    if (d > 0.5) discard;
    float soft = smoothstep(0.5, 0.0, d);

    // Palette shift with a little per-particle variance for richness.
    float m = clamp(uMix + (vSeed - 0.5) * 0.25, 0.0, 1.0);
    vec3 col = mix(uWarm, uCool, m);
    col += vSparkle; // additive blending reads the brightening as sparkle

    gl_FragColor = vec4(col * soft, soft * uOpacity);
  }
`

export class ParticleSwarm implements Renderer {
  private scene: THREE.Scene | null = null
  private camera: THREE.PerspectiveCamera | null = null
  private points: THREE.Points | null = null
  private geometry: THREE.BufferGeometry | null = null
  private material: THREE.ShaderMaterial | null = null

  // Preallocated particle state (never reallocated per frame).
  private readonly positions = new Float32Array(PARTICLE_COUNT * 3)
  private readonly home = new Float32Array(PARTICLE_COUNT * 3)
  private readonly vel = new Float32Array(PARTICLE_COUNT * 3)
  private readonly seed = new Float32Array(PARTICLE_COUNT)

  private time = 0 // accumulated seconds, drives shader flicker
  private lastBeatCount = 0 // edge-detect beats regardless of frame rate

  // The shared WebGLRenderer, captured at init so render() can draw.
  private hostRenderer: THREE.WebGLRenderer | null = null

  init(ctx: RendererContext): void {
    this.hostRenderer = ctx.renderer
    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(
      60,
      ctx.width / Math.max(1, ctx.height),
      0.1,
      1000,
    )
    this.camera.position.z = CAM_Z

    // Seed home positions uniformly inside a sphere; start live positions there.
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const idx = i * 3
      const r = SWARM_RADIUS * Math.cbrt(Math.random())
      const theta = Math.acos(2 * Math.random() - 1)
      const phi = 2 * Math.PI * Math.random()
      const sinT = Math.sin(theta)
      const x = r * sinT * Math.cos(phi)
      const y = r * sinT * Math.sin(phi)
      const z = r * Math.cos(theta)
      this.home[idx] = x
      this.home[idx + 1] = y
      this.home[idx + 2] = z
      this.positions[idx] = x
      this.positions[idx + 1] = y
      this.positions[idx + 2] = z
      this.seed[i] = Math.random()
    }

    this.geometry = new THREE.BufferGeometry()
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage),
    )
    this.geometry.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1))

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uSize: { value: BASE_SIZE },
        uTreble: { value: 0 },
        uTime: { value: 0 },
        uPixelRatio: { value: ctx.renderer.getPixelRatio() },
        uWarm: { value: WARM.clone() },
        uCool: { value: COOL.clone() },
        uMix: { value: 0 },
        uOpacity: { value: 1 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })

    this.points = new THREE.Points(this.geometry, this.material)
    // Particles can drift outside the initial sphere; skip frustum culling so
    // the cloud never blinks out when it expands on a beat.
    this.points.frustumCulled = false
    this.scene.add(this.points)
  }

  score(features: Features): number {
    const tempo = tempoNorm(features.bpm)
    const beat = features.beatActivity
    const bright = smoothstep(tuning.bright.lo, tuning.bright.hi, features.smoothed.brightness)
    const w = tuning.swarm
    return w.tempo * tempo + w.beat * beat + w.bright * bright
  }

  update(features: Features, dt: number): void {
    if (!this.material) return
    this.time += dt

    // Drive the visuals from the auto-gained (AGC) values so the swarm stays
    // lively regardless of how loud/quiet the capture actually is.
    const f = features.normalized
    const loud = f.loudness
    const bass = f.bass
    const treble = f.treble
    const flux = f.motion

    const expand = 1 + bass * EXPAND_BASS
    const liveliness = LIVELINESS_MIN + loud * LIVELINESS_LOUD
    const swirl = BASE_SWIRL + loud * SWIRL_LOUD
    const turb = flux * TURB_SCALE
    const damp = Math.exp(-DAMP_PER_SEC * dt)

    // Beat burst: edge-triggered on beatCount so a burst fires exactly once per
    // beat no matter how the render rate relates to the analysis rate.
    let burst = 0
    if (features.beatCount > this.lastBeatCount) {
      burst = BURST_STRENGTH * (0.5 + bass)
      this.lastBeatCount = features.beatCount
    }

    const pos = this.positions
    const vel = this.vel
    const home = this.home

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const idx = i * 3
      const px = pos[idx]
      const py = pos[idx + 1]
      const pz = pos[idx + 2]

      // Spring toward the (bass-expanded) home position.
      let vx = vel[idx] + (home[idx] * expand - px) * SPRING * dt
      let vy = vel[idx + 1] + (home[idx + 1] * expand - py) * SPRING * dt
      let vz = vel[idx + 2] + (home[idx + 2] * expand - pz) * SPRING * dt

      // Gentle swirl about the Y axis: v += (0,swirl,0) x pos.
      vx += swirl * pz * dt
      vz += -swirl * px * dt

      // Turbulence from spectral flux.
      if (turb > 0) {
        vx += (Math.random() * 2 - 1) * turb * dt
        vy += (Math.random() * 2 - 1) * turb * dt
        vz += (Math.random() * 2 - 1) * turb * dt
      }

      // Radial burst on the beat: outward impulse from the swarm center.
      if (burst > 0) {
        const len = Math.sqrt(px * px + py * py + pz * pz) + 1e-4
        vx += (px / len) * burst
        vy += (py / len) * burst
        vz += (pz / len) * burst
      }

      // Damp, then integrate. Loudness scales overall motion speed.
      vx *= damp
      vy *= damp
      vz *= damp
      vel[idx] = vx
      vel[idx + 1] = vy
      vel[idx + 2] = vz

      pos[idx] = px + vx * dt * liveliness
      pos[idx + 1] = py + vy * dt * liveliness
      pos[idx + 2] = pz + vz * dt * liveliness
    }

    ;(this.geometry!.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true

    // Drive shader uniforms.
    const u = this.material.uniforms
    u.uSize.value = BASE_SIZE * (0.6 + bass * SIZE_BASS)
    u.uTreble.value = treble
    u.uTime.value = this.time
    u.uMix.value = smoothstep(tuning.bright.lo, tuning.bright.hi, f.brightness)
  }

  render(): void {
    // Draw this renderer's own scene/camera through the shared WebGLRenderer.
    if (!this.scene || !this.camera || !this.hostRenderer) return
    this.hostRenderer.render(this.scene, this.camera)
  }

  setOpacity(value: number): void {
    if (this.material) {
      this.material.uniforms.uOpacity.value = Math.min(1, Math.max(0, value))
    }
  }

  resize(width: number, height: number): void {
    if (!this.camera) return
    this.camera.aspect = width / Math.max(1, height)
    this.camera.updateProjectionMatrix()
    if (this.material) {
      // Pixel ratio can change if the window moves to another monitor.
      this.material.uniforms.uPixelRatio.value = this.hostRenderer?.getPixelRatio() ?? 1
    }
  }

  dispose(): void {
    if (this.points && this.scene) this.scene.remove(this.points)
    this.geometry?.dispose()
    this.material?.dispose()
    this.geometry = null
    this.material = null
    this.points = null
    this.scene = null
    this.camera = null
    this.hostRenderer = null
  }
}
