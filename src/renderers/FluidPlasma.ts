/**
 * Renderer 2: Fluid plasma (build plan step 4).
 *
 * A full-screen fragment shader: fractal noise (fbm) with domain warping,
 * animated slowly so it reads as liquid rather than sine stripes. This is the
 * CALM, ambient counterpart to the energetic ParticleSwarm — best suited to
 * quiet / dark / smooth passages, so nothing here is frantic.
 *
 * Performance: the plasma is rendered into a resolution-capped WebGLRenderTarget
 * (max long side MAX_RENDER_DIM) and then upscaled to the screen with a cheap
 * textured quad. That decouples the expensive per-pixel fbm from the display's
 * native (possibly high-DPI) resolution, keeping it at a smooth 60fps. The soft
 * upscale also suits the liquid look.
 *
 * Feature mapping:
 *   loudness   -> overall intensity / brightness of the field
 *   bass       -> scale + slow swell of the large undulations
 *   motion     -> flow speed / turbulence of the warp
 *   treble     -> fine shimmer on top
 *   brightness -> palette: deep/dark when dark, brighter/cool when bright
 *   beat       -> a soft bloom + outward ripple (felt, not punchy)
 */

import * as THREE from 'three'
import type { Features } from '../audio/features'
import type { Renderer, RendererContext } from './types'
import { smoothstep, tempoNorm } from './scoring'
import { tuning } from '../tuning'

// Cap the fbm render resolution (longer side, in px) for a stable 60fps.
const MAX_RENDER_DIM = 1280

// FluidPlasma is the CALM style — the mirror of the swarm. Its director score
// leans on the same VOLUME-INDEPENDENT cues: it wins when the music is slow, has
// little/no beat, and is dark in timbre. The score weights and brightness window
// live in `tuning` for live adjustment; defaults are in tuning.ts.

// Field shaping.
const BASE_SCALE = 2.5 // base zoom of the large undulations
const WARP_AMT = 1.2 // domain-warp strength (organic flow)
const FLOW_BASE = 0.06 // baseline flow speed — deliberately slow (calm)
const FLOW_MOTION = 1.2 // extra flow speed from spectral flux
const BEAT_DECAY = 2.2 // beat pulse decay per second (soft, ~0.5s tail)

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    // Plane spans clip space directly (-1..1), so position.xy is gl_Position.
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const PLASMA_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform float uLoudness;
  uniform float uBass;
  uniform float uMid;
  uniform float uTreble;
  uniform float uBrightness;
  uniform float uFlowPhase;  // accumulated warp-flow phase (rate integrated on CPU)
  uniform float uBeat;       // decaying pulse 0..1
  uniform float uIntensity;  // v1.1 user dial (1 = neutral); scales the beat bloom
  uniform vec2  uResolution;

  #define OCTAVES 4

  // Cheap hash -> value noise -> fbm (no textures).
  float hash(vec2 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * (p.x + p.y));
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < OCTAVES; i++) {
      v += a * noise(p);
      p *= 2.0;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution.xy;
    vec2 p = uv - 0.5;
    p.x *= uResolution.x / uResolution.y; // aspect-correct so it isn't stretched

    float t = uTime;
    // The warp animates along uFlowPhase, a RATE integrated on the CPU. Using
    // t * flow would jump the phase whenever the audio-driven rate changed (and
    // worse as t grew), which read as jitter. Integrating the rate keeps motion
    // smooth while still speeding up / slowing down with the music.
    float fp = uFlowPhase;

    // Bass sets the scale and a slow swell of the big undulations.
    float scale = BASE_SCALE_CONST * (1.0 + uBass * 0.5);
    vec2 sp = p * scale;
    sp += uBass * 0.3 * vec2(sin(t * 0.15), cos(t * 0.12)); // slow drift

    // Domain warp: displace the sample point by another fbm so it flows.
    vec2 q = vec2(
      fbm(sp + vec2(0.0, fp)),
      fbm(sp + vec2(3.3, -fp) + 2.1)
    );
    vec2 warped = sp + WARP_AMT_CONST * q;

    float field = fbm(warped + vec2(-fp * 0.5, 0.0));

    // Treble adds fine shimmer on top (single cheap noise octave).
    field += uTreble * 0.12 * noise(warped * 6.0 + t * 0.8);
    field = clamp(field, 0.0, 1.0);

    // --- Color: deep/dark palette when the sound is dark, brighter/cool when
    // bright. Remap the (narrow) normalized centroid into a readable window. ---
    float mixv = smoothstep(0.05, 0.30, uBrightness);

    vec3 deep = mix(vec3(0.02, 0.03, 0.09), vec3(0.35, 0.10, 0.48), field);
    vec3 bright = mix(vec3(0.03, 0.18, 0.28), vec3(0.55, 0.95, 1.00), field);
    vec3 col = mix(deep, bright, mixv);

    // Loudness drives overall intensity (floor keeps idle visible but dim).
    col *= 0.25 + uLoudness * 1.5;

    // Beat: a soft central bloom plus a gentle outward ripple that expands as
    // the pulse fades. Felt, not punchy.
    float dist = length(p);
    float bloom = uBeat * exp(-dist * 3.0) * 0.35;
    float ringRadius = (1.0 - uBeat) * 0.9;
    float ring = smoothstep(0.07, 0.0, abs(dist - ringRadius)) * uBeat * 0.2;
    // uIntensity scales the beat response only (the field/flow keep going at 0).
    col += (bloom + ring) * uIntensity * mix(vec3(0.6, 0.5, 0.9), vec3(0.6, 0.95, 1.0), mixv);

    // Subtle vignette for depth.
    col *= 1.0 - 0.35 * dot(p, p);

    // Opaque into the render target; opacity is applied later in the blit so
    // the target can go uncleared each frame (autoClear off) without feedback.
    gl_FragColor = vec4(col, 1.0);
  }
`
  // Inline the JS constants so they read as GLSL literals (keeps one source of truth).
  .replace('BASE_SCALE_CONST', BASE_SCALE.toFixed(3))
  .replace('WARP_AMT_CONST', WARP_AMT.toFixed(3))

const BLIT_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D uTex;
  uniform float uOpacity; // final alpha multiply (for crossfades)
  varying vec2 vUv;
  void main() {
    // Upscale the low-res plasma target to the screen; fade via uOpacity so the
    // director can crossfade this whole style in/out.
    vec3 col = texture2D(uTex, vUv).rgb;
    gl_FragColor = vec4(col, uOpacity);
  }
`

export class FluidPlasma implements Renderer {
  private hostRenderer: THREE.WebGLRenderer | null = null
  private camera: THREE.OrthographicCamera | null = null

  private plasmaScene: THREE.Scene | null = null
  private plasmaMaterial: THREE.ShaderMaterial | null = null
  private plasmaGeo: THREE.BufferGeometry | null = null

  private screenScene: THREE.Scene | null = null
  private blitMaterial: THREE.ShaderMaterial | null = null
  private screenGeo: THREE.BufferGeometry | null = null

  private target: THREE.WebGLRenderTarget | null = null

  private time = 0
  private flowPhase = 0 // integrated warp-flow rate (smooth even as rate changes)
  private beatPulse = 0
  private lastBeatCount = 0
  private intensity = 1 // v1.1 user dial; scales flow + beat bloom only (1 = neutral)

  init(ctx: RendererContext): void {
    this.hostRenderer = ctx.renderer
    // A single ortho camera works for both the plasma pass and the blit; the
    // quads already live in clip space via their vertex shader.
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

    const { w, h } = targetSize(ctx.width, ctx.height)
    this.target = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    })

    // Plasma pass: full-screen quad running the fbm shader into the target.
    this.plasmaGeo = new THREE.PlaneGeometry(2, 2)
    this.plasmaMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uLoudness: { value: 0 },
        uBass: { value: 0 },
        uMid: { value: 0 },
        uTreble: { value: 0 },
        uBrightness: { value: 0 },
        uFlowPhase: { value: 0 },
        uBeat: { value: 0 },
        uIntensity: { value: 1 },
        uResolution: { value: new THREE.Vector2(w, h) },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: PLASMA_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    this.plasmaScene = new THREE.Scene()
    this.plasmaScene.add(new THREE.Mesh(this.plasmaGeo, this.plasmaMaterial))

    // Blit pass: upscale the target texture to the screen.
    this.screenGeo = new THREE.PlaneGeometry(2, 2)
    this.blitMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: this.target.texture },
        uOpacity: { value: 1 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: BLIT_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    this.screenScene = new THREE.Scene()
    this.screenScene.add(new THREE.Mesh(this.screenGeo, this.blitMaterial))
  }

  score(features: Features): number {
    const slow = 1 - tempoNorm(features.bpm)
    const sparse = 1 - features.beatActivity
    const dark = 1 - smoothstep(tuning.bright.lo, tuning.bright.hi, features.smoothed.brightness)
    const w = tuning.plasma
    return w.slow * slow + w.sparse * sparse + w.dark * dark
  }

  update(features: Features, dt: number): void {
    if (!this.plasmaMaterial) return
    this.time += dt

    // Drive the field from the auto-gained (AGC) values so intensity/flow read
    // the song's own dynamics regardless of absolute capture level.
    const f = features.normalized

    // Beat pulse: edge-trigger on beatCount, then decay softly (frame-rate
    // independent) so the bloom is felt rather than punchy.
    if (features.beatCount > this.lastBeatCount) {
      this.beatPulse = 1
      this.lastBeatCount = features.beatCount
    }
    this.beatPulse *= Math.exp(-BEAT_DECAY * dt)

    // Integrate the warp-flow RATE into a phase (the shader animates along it).
    // The rate rises with spectral flux; FLOW_BASE keeps it gently alive when
    // still. Integrating avoids the phase jumping when the rate changes.
    // Intensity (0..2, 1 = neutral) scales the reactive part of the flow only —
    // FLOW_BASE is left alone so the field still drifts at intensity 0.
    const flow = FLOW_BASE + f.motion * FLOW_MOTION * this.intensity
    this.flowPhase += flow * dt

    const u = this.plasmaMaterial.uniforms
    u.uTime.value = this.time
    u.uLoudness.value = f.loudness
    u.uBass.value = f.bass
    u.uMid.value = f.mid
    u.uTreble.value = f.treble
    u.uBrightness.value = f.brightness
    u.uFlowPhase.value = this.flowPhase
    u.uBeat.value = this.beatPulse
    u.uIntensity.value = this.intensity
  }

  render(): void {
    if (!this.hostRenderer || !this.camera) return
    if (!this.plasmaScene || !this.screenScene || !this.target) return

    // Pass 1: render the fbm into the low-res target.
    this.hostRenderer.setRenderTarget(this.target)
    this.hostRenderer.render(this.plasmaScene, this.camera)

    // Pass 2: upscale the target to the screen.
    this.hostRenderer.setRenderTarget(null)
    this.hostRenderer.render(this.screenScene, this.camera)
  }

  setOpacity(value: number): void {
    // Opacity lives on the blit pass (what actually reaches the screen).
    if (this.blitMaterial) {
      this.blitMaterial.uniforms.uOpacity.value = Math.min(1, Math.max(0, value))
    }
  }

  setIntensity(value: number): void {
    this.intensity = Math.min(2, Math.max(0, value))
  }

  resize(width: number, height: number): void {
    if (!this.target || !this.plasmaMaterial) return
    const { w, h } = targetSize(width, height)
    this.target.setSize(w, h)
    ;(this.plasmaMaterial.uniforms.uResolution.value as THREE.Vector2).set(w, h)
  }

  dispose(): void {
    this.target?.dispose()
    this.plasmaGeo?.dispose()
    this.plasmaMaterial?.dispose()
    this.screenGeo?.dispose()
    this.blitMaterial?.dispose()
    this.target = null
    this.plasmaGeo = null
    this.plasmaMaterial = null
    this.screenGeo = null
    this.blitMaterial = null
    this.plasmaScene = null
    this.screenScene = null
    this.camera = null
    this.hostRenderer = null
  }
}

/** Cap the longer side to MAX_RENDER_DIM, preserving aspect. Min 2px. */
function targetSize(width: number, height: number): { w: number; h: number } {
  const long = Math.max(width, height, 1)
  const scale = long > MAX_RENDER_DIM ? MAX_RENDER_DIM / long : 1
  return {
    w: Math.max(2, Math.round(width * scale)),
    h: Math.max(2, Math.round(height * scale)),
  }
}
