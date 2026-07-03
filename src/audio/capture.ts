/**
 * Layer 1: Capture (build plan step 1)
 *
 * Grabs Windows system audio via getDisplayMedia and routes it into a Web Audio
 * AnalyserNode. The AnalyserNode is deliberately NOT connected to the
 * AudioContext destination, so the captured audio is analysed but not played
 * back out the speakers (which would echo).
 *
 * Windows Chrome / Edge gotcha: to capture ALL system audio you must share the
 * whole screen (or a window) and tick "Share system audio" in the picker.
 * Sharing a single browser tab only captures that tab. That is why we request
 * both audio AND video below — some capture paths only expose the system-audio
 * option when video is also requested. We drop the video track immediately once
 * we have the stream.
 */

export interface AudioCapture {
  /** The Web Audio analyser. Read frequency/time-domain data from this. */
  analyser: AnalyserNode
  /** Underlying context, exposed so callers can inspect sampleRate etc. */
  context: AudioContext
  /**
   * The live captured stream (audio only — the video track is dropped during
   * setup). v1.2 song ID reuses this exact stream to record a short snippet
   * with MediaRecorder, so it never has to prompt getDisplayMedia again.
   */
  stream: MediaStream
  /** Stop capture and release the display-media stream + audio graph. */
  stop: () => void
}

export interface StartCaptureOptions {
  /** AnalyserNode FFT size. Must be a power of two, 32..32768. Default 2048. */
  fftSize?: number
  /**
   * Analyser smoothing 0..1. This averages each frequency bin across frames.
   * Keep it LOW: the feature extractor derives spectral flux (frame-to-frame
   * change) and bass onsets from this data, and heavy smoothing flattens the
   * very transients they depend on. We do our own attack-decay smoothing on the
   * derived features instead, so a small value here just denoises the raw bins.
   * Default 0.2.
   */
  smoothingTimeConstant?: number
}

/**
 * Prompt the user to pick a screen/window with system audio, then wire the
 * audio into an AnalyserNode. Resolves once the audio graph is live.
 *
 * Throws if the browser returns no audio track (usually because the user did
 * not tick "Share system audio", or picked a single tab).
 */
export async function startCapture(
  options: StartCaptureOptions = {},
): Promise<AudioCapture> {
  const { fftSize = 2048, smoothingTimeConstant = 0.2 } = options

  // Request BOTH audio and video. Video is only requested to unlock the
  // system-audio path; we discard the video track right after.
  //
  // Disable Chrome's audio processing on the captured track. By default
  // getDisplayMedia may apply automatic gain control, noise suppression, and
  // echo cancellation — meant for microphones, not music. AGC in particular
  // adapts over time and drags the captured level way down (near-silent RMS
  // while the song plays normally), so we turn it all off to get the raw,
  // full-level system audio the analysis depends on.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: true,
  })

  const audioTracks = stream.getAudioTracks()
  if (audioTracks.length === 0) {
    // No system audio was shared. Clean up whatever we did get, then explain.
    stream.getTracks().forEach((t) => t.stop())
    throw new Error(
      'No audio track was captured. In the share dialog, choose "Entire Screen" ' +
        '(or a window) and make sure "Share system audio" is checked. Sharing a ' +
        'single browser tab or leaving that box unchecked yields no audio.',
    )
  }

  // Drop the video track immediately — we never render it.
  stream.getVideoTracks().forEach((track) => {
    track.stop()
    stream.removeTrack(track)
  })

  const context = new AudioContext()
  // Autoplay policy can leave the context suspended until a user gesture.
  // startCapture is triggered by a click, so resuming here is safe.
  if (context.state === 'suspended') {
    await context.resume()
  }

  const source = context.createMediaStreamSource(stream)
  const analyser = context.createAnalyser()
  analyser.fftSize = fftSize
  analyser.smoothingTimeConstant = smoothingTimeConstant

  // Source -> Analyser ONLY. Do NOT connect analyser -> context.destination,
  // or the captured system audio would be played back out and echo.
  source.connect(analyser)

  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    source.disconnect()
    analyser.disconnect()
    stream.getTracks().forEach((t) => t.stop())
    void context.close()
  }

  // If the user ends the share via Chrome's "Stop sharing" bar, the audio
  // track ends — tear the graph down so we don't leak a dead context.
  audioTracks[0].addEventListener('ended', stop)

  return { analyser, context, stream, stop }
}
