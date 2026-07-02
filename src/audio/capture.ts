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
  /** Stop capture and release the display-media stream + audio graph. */
  stop: () => void
}

export interface StartCaptureOptions {
  /** AnalyserNode FFT size. Must be a power of two, 32..32768. Default 2048. */
  fftSize?: number
  /** Analyser smoothing 0..1. Higher = smoother/slower bars. Default 0.8. */
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
  const { fftSize = 2048, smoothingTimeConstant = 0.8 } = options

  // Request BOTH audio and video. Video is only requested to unlock the
  // system-audio path; we discard the video track right after.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    audio: true,
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

  return { analyser, context, stop }
}
