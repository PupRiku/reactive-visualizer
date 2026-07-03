/**
 * v1.2 Stage 3 — client side of the provider seam.
 *
 * The active streaming provider is chosen by the backend (config). The widget
 * reads its labels and deep-link templates from /api/provider so nothing is
 * hardcoded to "Spotify" — a second provider later ships its own metadata.
 *
 * openTrack is the one provider method that lives in the browser (deep-linking
 * is a client concern). It builds the desktop URI + web URL from the provider's
 * templates and does the standard "try desktop, fall back to web" dance.
 */

export interface ProviderMeta {
  id: string
  label: string
  openLabel: string
  addLabel: string
  connectLabel: string
  /** Whether OAuth credentials are configured on the backend. */
  oauthConfigured: boolean
  track: {
    /** e.g. "spotify:track:{id}" — {id} is replaced with the streaming id. */
    uriTemplate: string
    /** e.g. "https://open.spotify.com/track/{id}". */
    urlTemplate: string
  }
}

/** Fetch active-provider metadata (labels + link templates). */
export async function fetchProvider(): Promise<ProviderMeta | null> {
  try {
    const res = await fetch('/api/provider')
    if (!res.ok) return null
    return (await res.json()) as ProviderMeta
  } catch {
    return null
  }
}

/** How long to wait for the desktop app before opening the web player. */
const FALLBACK_MS = 1200

/**
 * Open a track in the provider's desktop app, falling back to the web player.
 *
 * We trigger the custom-scheme URI via a hidden iframe (so the visualizer page
 * itself is never navigated away), then after a short timeout open the web URL
 * in a new tab. If the desktop app took over, the page is hidden by then and we
 * skip the fallback. As the spec notes, browsers can't reliably detect the
 * hand-off, so this occasionally opens both — which is acceptable.
 */
export function openTrack(meta: ProviderMeta, streamingId: string): void {
  const uri = meta.track.uriTemplate.replace('{id}', streamingId)
  const url = meta.track.urlTemplate.replace('{id}', streamingId)

  let handedOff = false
  const onHide = () => {
    if (document.hidden) handedOff = true
  }
  document.addEventListener('visibilitychange', onHide)

  // Trigger the desktop app without navigating the app away.
  const iframe = document.createElement('iframe')
  iframe.style.display = 'none'
  iframe.src = uri
  document.body.appendChild(iframe)

  window.setTimeout(() => {
    document.removeEventListener('visibilitychange', onHide)
    iframe.remove()
    if (!handedOff) window.open(url, '_blank', 'noopener')
  }, FALLBACK_MS)
}
