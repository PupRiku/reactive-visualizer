/**
 * Shared renderer contract (build plan layer 4).
 *
 * Every visual style implements this interface so the director (step 5) can
 * swap and crossfade between them freely. Renderers own their own scene and
 * camera; they share the single WebGLRenderer handed to them via init().
 */

import type * as THREE from 'three'
import type { Features } from '../audio/features'

/** What init() receives: the shared WebGL renderer and the current viewport. */
export interface RendererContext {
  /** The one WebGLRenderer for the whole app. Renderers draw into this. */
  renderer: THREE.WebGLRenderer
  /** Current drawing-buffer size in CSS pixels. */
  width: number
  height: number
}

export interface Renderer {
  /** Set up scene, geometry, and materials. Called once. */
  init(context: RendererContext): void
  /** React to the latest features. `dt` is the frame delta in seconds. */
  update(features: Features, dt: number): void
  /** Draw this renderer's scene with its camera. */
  render(): void
  /** Set overall opacity 0..1 (used by the director for crossfades). */
  setOpacity(value: number): void
  /** Release geometry, materials, and any other GPU resources. */
  dispose(): void

  /**
   * Optional: react to a viewport resize (update camera aspect, etc.). Not one
   * of the five core lifecycle methods, but the canvas host / director calls it
   * when present so renderers don't have to poll for size changes.
   */
  resize?(width: number, height: number): void
}
