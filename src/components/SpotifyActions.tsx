import { useCallback, useEffect, useRef, useState } from 'react'
import type { IdentifiedTrack } from '../song/identify'
import { fetchProvider, openTrack, type ProviderMeta } from '../song/provider'

interface SpotifyActionsProps {
  track: IdentifiedTrack
}

interface Playlist {
  id: string
  name: string
}

/** Sentinel <select> value for the "create a new playlist" option. */
const NEW_PLAYLIST = '__new__'

// --- Session memory (survives the widget unmounting between identifies) -----
// Provider metadata never changes during a run; the chosen target playlist is
// remembered so adding several songs in a row during a set is one click each.
let cachedProvider: ProviderMeta | null = null
let rememberedPlaylistId: string | null = null

/**
 * v1.2 Stage 3 — the two streaming-service buttons on the now-playing tag.
 *
 * Part A: "Open in <provider>" — pure client-side deep link, shown whenever the
 * song has a streaming id. No auth.
 * Part B: "Add to Playlist" — backed by the local backend's OAuth. Shows a
 * "Connect" action until linked, then a playlist dropdown + Add button.
 *
 * Everything is read from the active provider (labels, link templates), so
 * nothing here is hardcoded to Spotify beyond the streaming-id field name.
 */
export default function SpotifyActions({ track }: SpotifyActionsProps) {
  const [provider, setProvider] = useState<ProviderMeta | null>(cachedProvider)
  const [connected, setConnected] = useState<boolean | null>(null)
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null)
  const [selectedId, setSelectedId] = useState<string>(rememberedPlaylistId ?? '')
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const pollRef = useRef<number | null>(null)

  const streamingId = track.streaming.spotify?.id ?? null

  // Load provider metadata once (cached across remounts).
  useEffect(() => {
    if (cachedProvider) {
      setProvider(cachedProvider)
      return
    }
    let alive = true
    void fetchProvider().then((p) => {
      if (!alive || !p) return
      cachedProvider = p
      setProvider(p)
    })
    return () => {
      alive = false
    }
  }, [])

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/spotify/status')
      const data = await res.json()
      setConnected(Boolean(data.connected))
      return Boolean(data.connected)
    } catch {
      setConnected(false)
      return false
    }
  }, [])

  const loadPlaylists = useCallback(async () => {
    try {
      const res = await fetch('/api/spotify/playlists')
      if (res.status === 401) {
        setConnected(false)
        return
      }
      const data = await res.json()
      const list: Playlist[] = data.playlists ?? []
      setPlaylists(list)
      // Restore the remembered target if it still exists; else pick the first.
      setSelectedId((cur) => {
        if (cur && list.some((p) => p.id === cur)) return cur
        if (rememberedPlaylistId && list.some((p) => p.id === rememberedPlaylistId)) {
          return rememberedPlaylistId
        }
        return list[0]?.id ?? ''
      })
    } catch {
      /* leave playlists null; the UI shows a load hint */
    }
  }, [])

  // Initial status check + refresh when the window regains focus (so returning
  // from the OAuth popup updates the UI without a manual reload).
  useEffect(() => {
    if (!provider?.oauthConfigured) return
    void refreshStatus()
    const onFocus = () => void refreshStatus()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [provider, refreshStatus])

  // Once connected, load the playlist list if we don't have it yet.
  useEffect(() => {
    if (connected && playlists === null) void loadPlaylists()
  }, [connected, playlists, loadPlaylists])

  useEffect(
    () => () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current)
    },
    [],
  )

  const startConnect = useCallback(() => {
    window.open('/api/spotify/login', 'provider-auth', 'width=520,height=720')
    // Poll status until the popup completes the exchange (bounded to ~2 min).
    if (pollRef.current !== null) window.clearInterval(pollRef.current)
    let ticks = 0
    pollRef.current = window.setInterval(async () => {
      ticks++
      const ok = await refreshStatus()
      if (ok || ticks > 80) {
        if (pollRef.current !== null) window.clearInterval(pollRef.current)
        pollRef.current = null
        if (ok) void loadPlaylists()
      }
    }, 1500)
  }, [refreshStatus, loadPlaylists])

  const like = useCallback(async () => {
    if (!streamingId || busy) return
    setBusy(true)
    setNotice(null)
    try {
      const res = await fetch('/api/spotify/like', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackId: streamingId }),
      })
      if (res.status === 401) {
        setConnected(false)
        throw new Error('Spotify disconnected — please reconnect.')
      }
      if (!res.ok) throw new Error((await res.json()).error || 'Could not save the track.')
      setNotice({ kind: 'ok', text: `♥ Added to Liked Songs` })
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : 'Like failed.' })
    } finally {
      setBusy(false)
    }
  }, [streamingId, busy])

  const disconnect = useCallback(async () => {
    try {
      await fetch('/api/spotify/logout', { method: 'POST' })
    } catch {
      /* best effort */
    }
    setConnected(false)
    setPlaylists(null)
    setNotice(null)
  }, [])

  const onSelectChange = (value: string) => {
    setSelectedId(value)
    if (value !== NEW_PLAYLIST) rememberedPlaylistId = value
  }

  const handleAdd = useCallback(async () => {
    if (!streamingId || busy) return
    setBusy(true)
    setNotice(null)
    try {
      let targetId = selectedId
      let targetName = playlists?.find((p) => p.id === targetId)?.name ?? 'playlist'

      // Create-and-target path.
      if (selectedId === NEW_PLAYLIST) {
        const name = newName.trim()
        if (!name) {
          setNotice({ kind: 'err', text: 'Enter a name for the new playlist.' })
          setBusy(false)
          return
        }
        const res = await fetch('/api/spotify/playlists', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        })
        if (!res.ok) throw new Error((await res.json()).error || 'Could not create playlist.')
        const created: Playlist = await res.json()
        targetId = created.id
        targetName = created.name
        // Add to the dropdown and remember it as the session target.
        setPlaylists((cur) => (cur ? [created, ...cur] : [created]))
        setSelectedId(created.id)
        rememberedPlaylistId = created.id
        setNewName('')
      }

      if (!targetId) {
        setNotice({ kind: 'err', text: 'Pick a playlist first.' })
        setBusy(false)
        return
      }

      const res = await fetch('/api/spotify/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackId: streamingId, playlistId: targetId }),
      })
      if (res.status === 401) {
        setConnected(false)
        throw new Error('Spotify disconnected — please reconnect.')
      }
      if (!res.ok) throw new Error((await res.json()).error || 'Could not add the track.')
      setNotice({ kind: 'ok', text: `Added to ${targetName}` })
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : 'Add failed.' })
    } finally {
      setBusy(false)
    }
  }, [streamingId, busy, selectedId, playlists, newName])

  if (!provider) return null

  const canOpen = Boolean(streamingId)
  const canAdd = provider.oauthConfigured && Boolean(streamingId)

  return (
    <div style={wrapStyle}>
      <div style={buttonRow}>
        {canOpen && (
          <button
            style={primaryBtn}
            onClick={() => streamingId && openTrack(provider, streamingId)}
          >
            {provider.openLabel}
          </button>
        )}

        {canAdd && connected && (
          <button style={likeBtn} onClick={like} disabled={busy} title={provider.likeLabel}>
            ♥ {provider.likeLabel}
          </button>
        )}

        {canAdd && connected === false && (
          <button style={ghostBtn} onClick={startConnect}>
            {provider.connectLabel}
          </button>
        )}
      </div>

      {canAdd && connected && (
        <div style={addRow}>
          <select
            value={selectedId}
            onChange={(e) => onSelectChange(e.target.value)}
            // Keep keystrokes from reaching the app's global hotkeys (f/h/i/…).
            onKeyDown={(e) => e.stopPropagation()}
            style={selectStyle}
            disabled={busy}
          >
            {playlists === null && <option value="">Loading…</option>}
            {playlists?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value={NEW_PLAYLIST}>＋ New playlist…</option>
          </select>

          {selectedId === NEW_PLAYLIST && (
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                // Don't let typed letters trigger the app's global hotkeys.
                e.stopPropagation()
                if (e.key === 'Enter') void handleAdd()
              }}
              placeholder="New playlist name"
              style={inputStyle}
              disabled={busy}
            />
          )}

          <button style={primaryBtn} onClick={handleAdd} disabled={busy}>
            {busy ? 'Adding…' : provider.addLabel}
          </button>

          <button
            style={linkBtn}
            onClick={disconnect}
            disabled={busy}
            title="Unlink Spotify (e.g. to re-grant playlist permissions)"
          >
            Disconnect
          </button>
        </div>
      )}

      {notice && (
        <div style={{ ...noticeStyle, color: notice.kind === 'ok' ? '#7cfc9b' : '#ffb4b4' }}>
          {notice.text}
        </div>
      )}
    </div>
  )
}

const wrapStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  marginTop: 8,
}

const buttonRow: React.CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap' }

const addRow: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  alignItems: 'center',
  flexWrap: 'wrap',
}

const baseBtn: React.CSSProperties = {
  appearance: 'none',
  border: '1px solid rgba(255,255,255,0.18)',
  fontSize: 12,
  fontWeight: 600,
  padding: '5px 10px',
  borderRadius: 7,
  cursor: 'pointer',
  color: 'white',
}

const primaryBtn: React.CSSProperties = { ...baseBtn, background: '#1db954', borderColor: 'transparent' }
const ghostBtn: React.CSSProperties = { ...baseBtn, background: 'rgba(255,255,255,0.08)' }
const likeBtn: React.CSSProperties = { ...baseBtn, background: 'rgba(255,255,255,0.08)', color: '#ff6b8b' }

const selectStyle: React.CSSProperties = {
  ...baseBtn,
  fontWeight: 500,
  background: 'rgba(20,24,34,0.95)',
  maxWidth: 150,
  cursor: 'pointer',
}

const inputStyle: React.CSSProperties = {
  ...baseBtn,
  fontWeight: 500,
  background: 'rgba(20,24,34,0.95)',
  cursor: 'text',
  minWidth: 120,
}

const linkBtn: React.CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'none',
  color: '#8f9bb3',
  fontSize: 11,
  textDecoration: 'underline',
  cursor: 'pointer',
  padding: 0,
}

const noticeStyle: React.CSSProperties = { fontSize: 11, fontWeight: 600 }
