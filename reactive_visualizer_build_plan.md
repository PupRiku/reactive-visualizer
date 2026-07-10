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
  - Bright + harmonic + mid-tempo to **reactive geometry** (v1.3)
  - Steady + rhythmic to **elevated spectrum** (v1.3)
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
- **v1.1** - Manual controls for live use only: an auto-hiding control bar with an auto on/off lock, style selection, an intensity nudge, and a fullscreen toggle. No new renderers and no scoring changes.
- **v1.2** - Song ID widget: a small, unobtrusive "now playing" tag that identifies the currently playing track via a music recognition API. See the detailed spec below.
- **v1.3** - More visualizations: the reactive geometry and elevated spectrum renderers, plus the scoring rework. The two v1 styles are near-opposites, so a single energy axis works; new styles need genuinely multi-dimensional scoring (brightness/harmonic content as their own axes, not just energy) or they will never win a comparison.
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

### Architecture (this adds a small LOCAL backend)

The API credential cannot live in browser JavaScript (it would be exposed, plus CORS). And two features here (writing recaps to a local folder, holding Spotify OAuth tokens) can only be done by a server running on your own machine. So the backend is a small local Node server you run alongside the app, NOT a cloud/Vercel function. It has three jobs: proxy the recognition call, persist recaps to disk, and handle Spotify.

1. Browser grabs a short audio snippet from the existing captured stream.
2. Browser POSTs the snippet to the local backend.
3. The backend attaches the recognition API key server-side, calls AudD (or ACRCloud) with streaming IDs requested (AudD: `&return=spotify`; ACRCloud returns them in external_metadata), and returns clean JSON that already includes the Spotify track ID.
4. Widget renders the result and its buttons.

Keep all secrets (recognition key, Spotify client secret, Spotify tokens) in the backend's environment/config, never in client code.

### Snippet capture

- Use a `MediaRecorder` on the existing captured audio stream to grab a rolling 10 to 12 second clip on demand.
- Send it to the proxy as the request body; AudD accepts common encoded formats directly.

### Trigger (keep API usage tiny)

- **Primary: on-demand hotkey.** Press a key, it identifies the last ~10 seconds and shows the tag. Ideal for happy hours and economical on quota.
- **Optional later: auto on song change.** You already detect song boundaries via spectral flux in the analysis layer, so firing a single recognition call only when a new track likely starts is nearly free to add and still economical. Do NOT poll continuously.

### Widget

- Small corner overlay that fades in with title and artist (album art thumbnail optional), then fades back or stays subtle. Must not compete with the visuals.
- Since you screen-share the visualizer window in Zoom, the tag rides along automatically.

### Recaps (set-list memory + file export)

- As each song is identified, the backend adds it to the current session's list and appends it to a timestamped session file in `recaps/` (for example `recaps/2026-07-02_2130.txt`), written the moment the song is identified.
- Do NOT rely on a browser "on close" event to save; those are unreliable for file writes, so you can lose the list exactly when you want it. Appending incrementally means the file is always current and survives a crash, and closing the app needs no special handling.
- De-duplicate consecutive repeats so a song identified twice in a row is not listed twice. Include a timestamp per entry so the file reads like a set list.

### Open in Spotify (button)

- Uses the Spotify track ID that already came back on the recognition result, so no extra lookup.
- Desktop first, browser fallback: open the `spotify:track:ID` URI to hand off to the desktop app, and after a short timeout fall back to `https://open.spotify.com/track/ID`.
- Honest caveat: browsers cannot reliably detect whether the desktop app opened, so the timeout fallback occasionally opens both. This is the standard behavior for deep-link-with-fallback and is acceptable.
- This button is pure client-side once it has the ID; it does not need the backend.

### Add to Spotify Playlist (button)

- This is the heaviest piece. It needs Spotify OAuth (Authorization Code flow), all handled by the LOCAL backend. Scopes: `playlist-modify-public` and `playlist-modify-private` (add tracks, create playlists) plus `playlist-read-private` (list your playlists for the dropdown).
- One-time setup: register a dev app in the Spotify Developer Dashboard for a client ID and secret; register `http://127.0.0.1:PORT/callback` as the redirect URI (Spotify allows localhost). Authorize once; the backend stores the refresh token so it keeps working without re-auth.
- The client secret and tokens live ONLY in the backend, never in the browser.
- Adding a track is one API call (`POST /v1/playlists/{playlist_id}/tracks`) using the Spotify track ID from the recognition result.
- Target playlist: a dropdown of your existing playlists (`GET /v1/me/playlists`) plus a "New playlist..." option that takes a name and creates one (`POST /v1/users/{user_id}/playlists`), then targets it. Both are one API call each.

### Extensibility (Spotify now, other services later)

The intent is Spotify-forward for now, but open to other services (Apple Music, YouTube Music, etc.) later. Design for that cheaply now without over-building:

- On each identified song, store ALL streaming IDs the recognition response returns (Spotify, Apple, YouTube, Deezer), not just Spotify. Then adding a service later never requires re-identifying anything.
- Put the service calls behind a thin provider interface: openTrack, addToPlaylist, listPlaylists, createPlaylist. Spotify is the single implementation for now; a second service becomes a new implementation, not a refactor.
- The Open and Add buttons read their label and behavior from the active provider (config-selected), rather than hardcoding "Spotify".
- OAuth and credentials are per-provider and stay in the backend. Do NOT build the other providers yet; just leave the one clean seam.

### Caveat

This only identifies music going through the system audio you are capturing. If you are playing the music, it works. If it is coming from another Zoom participant, it is only catchable if Zoom routes that incoming audio through the system output your capture sees, so test that setup before relying on it.

## v1.3 spec: More visualizations + multi-axis scoring

Adds two renderers and, more importantly, reworks how the director chooses. The two v1 styles are near-perfect opposites, so a single energy threshold works. Four styles need a genuinely multi-dimensional decision or the new two will never win.

### The scoring model (the core change)

Replace the per-style ad-hoc weighted sums with a shared feature vector plus a per-style prototype (its ideal point in that space). Each frame, build the vector; each style scores by proximity to its prototype. This scales cleanly: a new style is just a new point, not new bespoke math. Centralize the proximity math in one helper; each renderer's score() delegates to it with its own prototype. The director's timing and hysteresis are UNCHANGED - they just consume the new scores.

Feature vector (each axis 0..1):
- energy - blend of loudness and tempo (overall intensity)
- pulse - rhythmic drive (beatActivity)
- bright - spectral centroid (smoothstep)
- flux - normalized spectral flux (volatility; separates explosive from steady groove)

Starting prototypes [energy, pulse, bright, flux]:
- ParticleSwarm (explosive/energetic): [0.90, 0.85, 0.60, 0.85]
- ElevatedSpectrum (steady rhythmic groove): [0.55, 0.80, 0.50, 0.35]
- ReactiveGeometry (bright/melodic/structured): [0.55, 0.40, 0.85, 0.40]
- FluidPlasma (calm/ambient/dark): [0.20, 0.20, 0.30, 0.25]

Score = 1 minus the weighted normalized distance to the prototype (higher = closer = better fit). If the four scores bunch too close for the margin to bite, switch to a softmax over negative distance with a tunable temperature. Expect to retune SWITCH_MARGIN, since the score spread changes from the old complementary 0/1 sums.

### Build order (3 stages)

1. Scoring rework only, keeping the existing two renderers (swarm + plasma prototypes). Extend the debug overlay to show the feature vector and every style's proximity score, and the tuning panel to edit prototypes and axis params. Verify the feel matches or beats v1.2 before adding any style.
2. Add ReactiveGeometry (bright/melodic): implements the full interface (including setIntensity/setOpacity/resize), registered as style 3, with a control-bar button and key '3'. Tune its prototype in, especially against plasma and the mid-energy region.
3. Add ElevatedSpectrum (steady groove): registered as style 4, button and key '4'. Tune its prototype in, especially the steady-groove versus explosive-swarm distinction, which is the hardest to separate.

### Unchanged (generalizes for free)

The director's selection, hysteresis, and crossfade compositing already loop over N styles and blend any pair, so no changes there. Intensity (v1.1) applies via each new renderer's setIntensity. Recaps and Spotify (v1.2) are untouched.

## Notes and gotchas

- Keep a debug overlay (toggleable) showing the live feature values and the director's current choice/scores. You will need it constantly while tuning.
- All heavy decisions stay out of the render loop. The director's scoring is cheap math; the future AI classifier runs on its own slow interval and only hands the director a label.
- getDisplayMedia audio can behave slightly differently across Chrome and Edge versions, so test the "Share system audio" flow early in step 1 before building anything on top of it.
