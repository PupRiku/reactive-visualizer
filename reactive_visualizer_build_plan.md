# Reactive Music Visualizer - Build Plan

## What we are building

A browser-based music visualizer for Windows that listens to the computer's system audio (any app, not one specific source) and automatically picks and morphs its visual style to match the song. No app in the render loop makes the frame-by-frame decisions; the reactivity is driven by audio analysis (DSP), and an optional AI classifier is a later upgrade for smarter, mood-aware switching.

## Core principle

About 90 percent of a great visualizer is good audio analysis mapped thoughtfully to motion. The "app decides" behavior comes from a small "director" layer reading audio features and choosing a style. AI is a top layer, not the engine. Nothing that adds model latency ever runs inside the 60fps render loop.

## Architecture (four layers)

1. **Capture** - grab the system audio stream.
2. **Analysis** - turn the stream into a set of numbers every frame (energy, bands, tempo, brightness, etc).
3. **Director** - read those numbers and decide which visual style fits right now.
4. **Renderers** - the actual visual styles, each reacting to the numbers. The director crossfades between them.

Data flows one direction: Capture to Analysis to Director to Renderers.

## Tech stack

- **Vite + React + TypeScript** for the app shell. (Not Next.js: this is a local, single-page, canvas-heavy tool with no server-side needs, and Next's SSR/hydration adds friction for a realtime canvas app. The audio and render code is identical either way, so use Next only if the familiarity is worth more to you than the leaner setup.)
- **Web Audio API** for both capture and analysis. FFT is built in via AnalyserNode, no library needed.
- **Three.js** for WebGL rendering. It handles particles (Points) and full-screen shader effects (a shader material on a full-screen quad) equally well.
- Runs on the Vite dev server at localhost, which counts as a secure context, so system audio capture works with no deployment. Deploying to Vercel later is optional and not needed for personal use.
- Later only: **tensorflow.js** with a small audio classifier (for example YAMNet) for the v2 AI layer.

## Layer 1: Capture

- Use `navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })`.
- The gotcha: to capture ALL system audio, share the whole screen (or a window) and tick the "Share system audio" checkbox in Chrome or Edge. Sharing a single browser tab only captures that tab's sound.
- Take the audio track from the resulting stream, feed it into an `AudioContext` via `createMediaStreamSource`, and connect it to an `AnalyserNode`. Do not connect the analyser to the destination, or you will echo the audio back out.
- You can drop the video track immediately; it is only requested because some capture paths require it to expose system audio.

## Layer 2: Analysis

Compute these each frame from the AnalyserNode, then smooth them (exponential smoothing / attack-decay envelopes) so the visuals do not jitter on raw noisy values:

- **Frequency spectrum** - `getByteFrequencyData` gives the raw FFT bins.
- **Band energies** - sum bins into bass (roughly 20 to 250 Hz), mid (250 to 4000 Hz), treble (4000 to 16000 Hz), then normalize.
- **Loudness / RMS** - from `getByteTimeDomainData`, the root-mean-square of the waveform. Overall "how loud right now."
- **Brightness (spectral centroid)** - magnitude-weighted mean frequency. High means bright/airy, low means dark/bassy.
- **Motion (spectral flux)** - frame-to-frame change in the spectrum. High means the sound is changing fast. Also the basis for beat detection.
- **Beat / tempo** - detect onsets as peaks in bass-band energy flux above a running threshold. Maintain a rough BPM estimate and, importantly, a "downbeat" signal the director can switch on.

Package these into a single `features` object passed to the director and renderers every frame.

## Layer 3: Director (the "app decides" logic)

- Give each style a preference profile describing the feature ranges it suits. Starting rules:
  - Fast + loud + percussive to **particle swarms**
  - Slow + quiet + dark to **fluid plasma**
  - Bright + harmonic + mid-tempo to **reactive geometry** (v1.1)
  - Steady + rhythmic to **elevated spectrum** (v1.1)
- Each frame, score every available style against the current smoothed features and find the highest.
- **Commitment / hysteresis (critical):** only switch if a different style has out-scored the current one for a minimum stretch (start with 8 to 15 seconds) AND beats it by a clear margin. Without this, borderline songs flicker between styles every second and look broken.
- **Switch on musical boundaries:** when a switch is warranted, wait for the next detected downbeat to actually trigger it, so every change lands like it was planned.
- **Transition:** crossfade opacity between the outgoing and incoming renderer over about 1 to 2 seconds rather than hard-cutting.

## Layer 4: Renderers

- Define one common interface every renderer implements so the director can swap them freely:
  - `init(context)` - set up scene/geometry/shaders
  - `update(features, dt)` - react to the latest audio features
  - `render()` - draw the frame
  - `setOpacity(value)` - for crossfades
  - `dispose()` - clean up
- **v1 renderers (build these two first, they are the most opposite so switching is obvious):**
  - **Particle swarms** - thousands of points that flow with energy and burst on beats. Bass drives size/count, treble drives sparkle, beats drive bursts.
  - **Fluid plasma** - a full-screen fragment shader of flowing color fields. Loudness drives intensity, brightness drives palette, slow motion for calm passages.

## Roadmap

- **v1** - Full pipeline, DSP director, particle swarms + fluid plasma, fully self-driving.
- **v1.1** - Manual controls for live use (lock the current style, force a specific style, intensity nudge slider) plus the reactive geometry and elevated spectrum renderers.
- **v1.2** - Song ID widget: a small, unobtrusive "now playing" tag that identifies the currently playing track via a music recognition API. See the detailed spec below.
- **v2** - AI classifier (tensorflow.js) running every 1 to 2 seconds, feeding genre/mood into the director so switching gets smarter than raw energy (for example, it stops treating a quiet buildup as a calm song).

## Suggested build order (visible win as early as possible)

1. **Capture proof** - get system audio into an AnalyserNode and draw a plain spectrum-bar display. Win: you see your music as moving bars.
2. **Feature extraction** - compute and smooth the full feature set, show them as on-screen debug readouts.
3. **Renderer 1** - build particle swarms reacting to the features.
4. **Renderer 2** - build fluid plasma reacting to the features.
5. **Director** - rule-based switching between the two, with crossfade.
6. **Polish** - add hysteresis, downbeat-aligned switching, and tune the feature-to-style mapping until it feels right.

## v1.2 spec: Song ID widget ("now playing")

A small, unobtrusive corner tag that identifies the currently playing track. Note: you cannot use Shazam itself (no public API). You use a music fingerprinting service instead.

### Service choice

- **AudD (recommended)** - simplest integration (single API token), results in about 2 seconds, and explicitly strong at background music and stream/DJ-mix audio, which matches happy-hour use.
- **ACRCloud (alternative)** - richer streaming-link metadata (Spotify, Apple Music, YouTube, Deezer IDs) and an ongoing free developer tier, but every request must be HMAC-signed with your secret, so it is a bit more work.
- Both have free tiers fine for light personal use. Confirm current limits at signup.

### Architecture (this adds the app's first backend piece)

The API credential cannot live in browser JavaScript (it would be exposed, plus CORS). So:

1. Browser grabs a short audio snippet from the existing captured stream.
2. Browser POSTs the snippet to a tiny proxy you control.
3. The proxy attaches the API key server-side, calls AudD (or ACRCloud), and returns clean JSON.
4. Widget renders the result.

Host the proxy as a single Vercel serverless function (you already use Vercel). Keep the key in an environment variable, never in client code.

### Snippet capture

- Use a `MediaRecorder` on the existing captured audio stream to grab a rolling 10 to 12 second clip on demand.
- Send it to the proxy as the request body; AudD accepts common encoded formats directly.

### Trigger (keep API usage tiny)

- **Primary: on-demand hotkey.** Press a key, it identifies the last ~10 seconds and shows the tag. Ideal for happy hours and economical on quota.
- **Optional later: auto on song change.** You already detect song boundaries via spectral flux in the analysis layer, so firing a single recognition call only when a new track likely starts is nearly free to add and still economical. Do NOT poll continuously.

### Widget

- Small corner overlay that fades in with title and artist (album art thumbnail optional), then fades back or stays subtle. Must not compete with the visuals.
- Since you screen-share the visualizer window in Zoom, the tag rides along automatically.

### Caveat

This only identifies music going through the system audio you are capturing. If you are playing the music, it works. If it is coming from another Zoom participant, it is only catchable if Zoom routes that incoming audio through the system output your capture sees, so test that setup before relying on it.

## Notes and gotchas

- Keep a debug overlay (toggleable) showing the live feature values and the director's current choice/scores. You will need it constantly while tuning.
- All heavy decisions stay out of the render loop. The director's scoring is cheap math; the future AI classifier runs on its own slow interval and only hands the director a label.
- getDisplayMedia audio can behave slightly differently across Chrome and Edge versions, so test the "Share system audio" flow early in step 1 before building anything on top of it.
