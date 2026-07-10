/**
 * Renderer 3: Reactive geometry (build plan v1.3, stage 2).
 *
 * Owns the BRIGHT / MELODIC / STRUCTURED corner that neither the explosive
 * ParticleSwarm nor the calm FluidPlasma covers. Visually: a morphing crystal —
 * a noise-displaced icosahedron with a rim-lit (fresnel) shell, a wireframe skin
 * floating just outside it, and a slow counter-rotating geometric cage for depth.
 * Modern and clubby, structured rather than a cloud or a flowing field.
 *
 * Feature mapping:
 *   bass       -> overall scale / swell of the crystal
 *   brightness -> palette shift + material glow (dark indigo <-> bright mint)
 *   treble     -> fine edge shimmer on the fresnel rim
 *   beat       -> a crisp scale pulse (edge-triggered on beatCount)
 *   motion     -> displacement turbulence (how far the surface morphs)
 *
 * Anti-jitter (the plasma bug): every animation phase whose speed varies with
 * audio is INTEGRATED — `phase += dt * rate` each frame — never computed as
 * `elapsedTime * rate`, which would jump whenever the rate changed. Rotations
 * (`rotation += dt * rate`) are integrated the same way.
 */

import * as THREE from 'three'
import type { Features } from '../audio/features'
import type { Renderer, RendererContext } from './types'
import { buildFeatureVector, prototypeVector, scoreAgainstProfile, smoothstep } from './scoring'
import { tuning } from '../tuning'

// Camera / geometry framing (pulled back so the outer cage stays in frame even
// on tall/square aspect ratios).
const CAM_Z = 5.2
const CORE_RADIUS = 1.5
const CORE_DETAIL = 4 // icosa subdivisions: 20*4^4 = 5120 tris — modest, GPU-displaced
const CAGE_RADIUS = 2.5
const CAGE_DETAIL = 1 // a clean low-poly cage (20 faces)

// Rotation (rad/s). Bases keep it turning when silent; loudness adds liveliness.
const ROT_BASE = 0.16
const ROT_LOUD = 0.55
const CAGE_ROT_BASE = 0.09
const CAGE_ROT_LOUD = 0.3

// Noise-morph phase rate (integrated). Base breath + spectral-flux turbulence.
const MORPH_BASE = 0.15
const MORPH_FLUX = 1.2

// Displacement amplitude (fraction of radius). Base breath + flux turbulence.
const DISP_BASE = 0.08
const DISP_FLUX = 0.35
const NOISE_FREQ = 1.1
const CAGE_NOISE_FREQ = 0.7

// Scale response.
const SWELL_BASS = 0.35 // bass swells the whole form
const PULSE_BEAT = 0.18 // crisp pop on each beat
const BEAT_DECAY = 3.0 // beat-pulse decay per second

// Treble shimmer phase rate (integrated).
const SHIMMER_BASE = 2.0
const SHIMMER_TREB = 10.0

const FRESNEL_POW = 2.2

// Clubby palette: dark indigo when the timbre is dark, bright mint when bright.
const COL_A = new THREE.Color(0x3b1e8f) // low brightness
const COL_B = new THREE.Color(0x57f5c8) // high brightness
const WIRE_GLOW_CORE = 0.9
const WIRE_GLOW_CAGE = 0.35

// Shared displacement vertex shader (used by the shell, the wireframe, and the
// cage — they only differ in fragment + uniform values). ShaderMaterial injects
// position/normal, the matrices, and cameraPosition, so we don't redeclare them.
const VERTEX_SHADER = /* glsl */ `
  precision highp float;
  uniform float uPhase;
  uniform float uNoiseFreq;
  uniform float uDisp;
  uniform float uScale;
  varying vec3 vNormalW;
  varying vec3 vViewDirW;
  varying float vNoise;

  // Ashima 3D simplex noise (snoise) — compact, smooth, texture-free.
  vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
  vec4 mod289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
  vec4 permute(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
  vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
  float snoise(vec3 v){
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(
               i.z + vec4(0.0, i1.z, i2.z, 1.0))
             + i.y + vec4(0.0, i1.y, i2.y, 1.0))
             + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0)*2.0 + 1.0;
    vec4 s1 = floor(b1)*2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }

  void main() {
    // Two octaves of simplex, animated along the integrated uPhase.
    float n = snoise(position * uNoiseFreq + vec3(0.0, 0.0, uPhase));
    n += 0.5 * snoise(position * (uNoiseFreq * 2.0) + vec3(uPhase, 0.0, 0.0));
    vNoise = n;

    vec3 displaced = (position + normal * n * uDisp) * uScale;
    vec4 world = modelMatrix * vec4(displaced, 1.0);

    // Approximate the lit normal with the (rotated) geometric normal — cheap and
    // plenty for a rim/fresnel glow.
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDirW = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

// Rim-lit shell: dark core, bright fresnel edges, treble shimmer on the rim.
const SHELL_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uMix;        // brightness palette 0..1
  uniform vec3  uColA;
  uniform vec3  uColB;
  uniform float uTreble;     // already intensity-scaled on the CPU
  uniform float uShimmer;    // integrated shimmer phase
  uniform float uFresnelPow;
  uniform float uOpacity;
  varying vec3 vNormalW;
  varying vec3 vViewDirW;
  varying float vNoise;

  void main() {
    float fres = pow(1.0 - clamp(dot(normalize(vNormalW), normalize(vViewDirW)), 0.0, 1.0), uFresnelPow);
    vec3 base = mix(uColA, uColB, clamp(uMix, 0.0, 1.0));
    vec3 col = base * (0.12 + 1.35 * fres);
    // Fine edge shimmer keyed to the surface noise; strongest on the rim.
    float shim = sin(vNoise * 16.0 + uShimmer) * 0.5 + 0.5;
    col += uTreble * shim * fres * base * 1.2;
    // Additive blending: alpha fades the whole style for the director crossfade.
    gl_FragColor = vec4(col, uOpacity);
  }
`

// Flat glowing lines for the wireframe skin and the outer cage.
const WIRE_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uMix;
  uniform vec3  uColA;
  uniform vec3  uColB;
  uniform float uGlow;
  uniform float uOpacity;
  void main() {
    vec3 base = mix(uColA, uColB, clamp(uMix, 0.0, 1.0));
    gl_FragColor = vec4(base * uGlow, uOpacity);
  }
`

export class ReactiveGeometry implements Renderer {
  private hostRenderer: THREE.WebGLRenderer | null = null
  private scene: THREE.Scene | null = null
  private camera: THREE.PerspectiveCamera | null = null

  // Crystal (shell + wireframe) share a group so they rotate together; the cage
  // counter-rotates on its own for parallax/depth.
  private crystal: THREE.Group | null = null
  private cage: THREE.Mesh | null = null

  private coreGeo: THREE.IcosahedronGeometry | null = null
  private cageGeo: THREE.IcosahedronGeometry | null = null
  private shellMat: THREE.ShaderMaterial | null = null
  private wireMat: THREE.ShaderMaterial | null = null
  private cageMat: THREE.ShaderMaterial | null = null

  // Integrated phases (never elapsedTime * rate — see file header).
  private morphPhase = 0
  private shimmerPhase = 0
  private cagePhase = 0
  private beatPulse = 0
  private lastBeatCount = 0
  private intensity = 1 // v1.1 dial; scales reactive magnitude only (1 = neutral)

  init(ctx: RendererContext): void {
    this.hostRenderer = ctx.renderer
    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(55, ctx.width / Math.max(1, ctx.height), 0.1, 100)
    this.camera.position.z = CAM_Z

    this.coreGeo = new THREE.IcosahedronGeometry(CORE_RADIUS, CORE_DETAIL)
    this.cageGeo = new THREE.IcosahedronGeometry(CAGE_RADIUS, CAGE_DETAIL)

    this.shellMat = this.makeMaterial('shell')
    this.wireMat = this.makeMaterial('wire')
    this.cageMat = this.makeMaterial('cage')

    const shell = new THREE.Mesh(this.coreGeo, this.shellMat)
    const wire = new THREE.Mesh(this.coreGeo, this.wireMat)
    shell.frustumCulled = false
    wire.frustumCulled = false

    this.crystal = new THREE.Group()
    this.crystal.add(shell)
    this.crystal.add(wire)
    this.scene.add(this.crystal)

    this.cage = new THREE.Mesh(this.cageGeo, this.cageMat)
    this.cage.frustumCulled = false
    this.scene.add(this.cage)
  }

  private makeMaterial(kind: 'shell' | 'wire' | 'cage'): THREE.ShaderMaterial {
    const common = {
      uPhase: { value: 0 },
      uNoiseFreq: { value: kind === 'cage' ? CAGE_NOISE_FREQ : NOISE_FREQ },
      uDisp: { value: 0 },
      uScale: { value: 1 },
      uMix: { value: 0 },
      uColA: { value: COL_A.clone() },
      uColB: { value: COL_B.clone() },
      uOpacity: { value: 1 },
    }
    const uniforms =
      kind === 'shell'
        ? {
            ...common,
            uTreble: { value: 0 },
            uShimmer: { value: 0 },
            uFresnelPow: { value: FRESNEL_POW },
          }
        : { ...common, uGlow: { value: kind === 'cage' ? WIRE_GLOW_CAGE : WIRE_GLOW_CORE } }

    return new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: kind === 'shell' ? SHELL_FRAGMENT : WIRE_FRAGMENT,
      wireframe: kind !== 'shell',
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  }

  score(features: Features): number {
    // v1.3: proximity of the shared feature vector to the geometry prototype.
    return scoreAgainstProfile(buildFeatureVector(features), prototypeVector(tuning.geometryProto))
  }

  update(features: Features, dt: number): void {
    if (!this.shellMat || !this.wireMat || !this.cageMat || !this.crystal || !this.cage) return

    // Drive the visuals from the auto-gained (AGC) values so the form stays
    // lively regardless of absolute capture level.
    const f = features.normalized
    const loud = f.loudness
    const bass = f.bass
    const treble = f.treble
    const flux = f.motion
    const iv = this.intensity

    // Beat: edge-trigger on beatCount (do NOT re-detect), then decay softly.
    if (features.beatCount > this.lastBeatCount) {
      this.beatPulse = 1
      this.lastBeatCount = features.beatCount
    }
    this.beatPulse *= Math.exp(-BEAT_DECAY * dt)

    // Integrate every audio-varying phase/rotation (anti-jitter). Bases keep the
    // crystal alive and turning during quiet passages.
    this.morphPhase += (MORPH_BASE + flux * MORPH_FLUX * iv) * dt
    this.shimmerPhase += (SHIMMER_BASE + treble * SHIMMER_TREB * iv) * dt
    this.cagePhase += MORPH_BASE * 0.5 * dt

    const rot = (ROT_BASE + loud * ROT_LOUD * iv) * dt
    this.crystal.rotation.y += rot
    this.crystal.rotation.x += rot * 0.35
    const cageRot = (CAGE_ROT_BASE + loud * CAGE_ROT_LOUD * iv) * dt
    this.cage.rotation.y -= cageRot
    this.cage.rotation.z += cageRot * 0.4

    // Reactive magnitudes — intensity scales the reactive part only; baselines
    // (DISP_BASE, scale 1.0) stay put so intensity 0 is calm-but-alive.
    const disp = DISP_BASE + flux * DISP_FLUX * iv
    const scale = 1 + (bass * SWELL_BASS + this.beatPulse * PULSE_BEAT) * iv
    const mix = smoothstep(tuning.bright.lo, tuning.bright.hi, f.brightness)

    const s = this.shellMat.uniforms
    s.uPhase.value = this.morphPhase
    s.uDisp.value = disp
    s.uScale.value = scale
    s.uMix.value = mix
    s.uTreble.value = treble * iv
    s.uShimmer.value = this.shimmerPhase

    const w = this.wireMat.uniforms
    w.uPhase.value = this.morphPhase
    w.uDisp.value = disp
    w.uScale.value = scale * 1.02 // float the wire skin just outside the shell
    w.uMix.value = mix

    const c = this.cageMat.uniforms
    c.uPhase.value = this.cagePhase
    c.uDisp.value = disp * 0.25 // the cage is structured — it morphs far less
    c.uScale.value = 1 + this.beatPulse * 0.06 * iv
    c.uMix.value = mix
  }

  render(): void {
    if (!this.scene || !this.camera || !this.hostRenderer) return
    this.hostRenderer.render(this.scene, this.camera)
  }

  setOpacity(value: number): void {
    const v = Math.min(1, Math.max(0, value))
    if (this.shellMat) this.shellMat.uniforms.uOpacity.value = v
    if (this.wireMat) this.wireMat.uniforms.uOpacity.value = v
    if (this.cageMat) this.cageMat.uniforms.uOpacity.value = v
  }

  setIntensity(value: number): void {
    this.intensity = Math.min(2, Math.max(0, value))
  }

  resize(width: number, height: number): void {
    if (!this.camera) return
    this.camera.aspect = width / Math.max(1, height)
    this.camera.updateProjectionMatrix()
  }

  dispose(): void {
    if (this.scene) {
      if (this.crystal) this.scene.remove(this.crystal)
      if (this.cage) this.scene.remove(this.cage)
    }
    this.coreGeo?.dispose()
    this.cageGeo?.dispose()
    this.shellMat?.dispose()
    this.wireMat?.dispose()
    this.cageMat?.dispose()
    this.coreGeo = null
    this.cageGeo = null
    this.shellMat = null
    this.wireMat = null
    this.cageMat = null
    this.crystal = null
    this.cage = null
    this.scene = null
    this.camera = null
    this.hostRenderer = null
  }
}
