'use client'

import { useState, useRef } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Play, Plus, Trash2, Search, X, GripVertical, ImageIcon, ChevronDown, FileText, Check, Sparkles, Share2, Pencil } from 'lucide-react'
import CassetteIcon from '@/components/CassetteIcon'
import { usePlayer } from '@/contexts/PlayerContext'
import { buildCollectionExport, COLLECTION_TYPE_LABEL } from '@/lib/collection-export'
import { IMAGE_MODELS } from '@/lib/artwork-models'
import { copyToClipboard } from '@/lib/clipboard'
import { albumShareUrl } from '@/lib/share-url'
import AlbumPlayer, { type AlbumPlayerTrack } from '@/components/AlbumPlayer'

type Collection = { id: string; title: string; type: string; cover_url: string | null }
type CollectionItem = {
  id: string
  collection_id: string
  project_id: string
  position: number
  mb_projects: { title: string; artwork_url: string | null; genre: string | null } | null
}
type Project = { id: string; title: string; genre?: string | null; artwork_url: string | null }

// Latest-version playback data per project, keyed by project id (server-built).
export type TrackMeta = {
  audioUrl: string | null
  duration: number | null
  visualizerUrl: string | null
}

// User-facing type labels live in collection-export.ts so the pill and the
// exported document can't drift apart.
const TYPE_LABEL = COLLECTION_TYPE_LABEL
const TYPES = ['album', 'ep', 'playlist'] as const

type Props = {
  collection: Collection
  initialItems: CollectionItem[]
  allProjects: Project[]
  trackMeta: Record<string, TrackMeta>
  artistName: string
}

export default function CollectionClient({ collection, initialItems, allProjects, trackMeta, artistName }: Props) {
  const router = useRouter()
  const { playTrack, setQueue } = usePlayer()
  const [items, setItems] = useState(initialItems)
  // Player view is the default experience (same look as the public share
  // page); Edit switches to the management list. Empty collections start in
  // edit mode so there's something to do.
  const [view, setView] = useState<'player' | 'edit'>(initialItems.length > 0 ? 'player' : 'edit')
  const [showPicker, setShowPicker] = useState(false)
  const [showCoverPicker, setShowCoverPicker] = useState(false)
  const [search, setSearch] = useState('')
  const [coverSearch, setCoverSearch] = useState('')
  const [adding, setAdding] = useState<string | null>(null)
  const [coverUrl, setCoverUrl] = useState(collection.cover_url)
  const [type, setType] = useState(collection.type)
  const [showTypePicker, setShowTypePicker] = useState(false)
  const [mediaItems, setMediaItems] = useState<Project[]>([])
  const [loadingMedia, setLoadingMedia] = useState(false)
  // In-modal cover generation
  const [coverGenMode, setCoverGenMode] = useState(false)
  const [coverPrompt, setCoverPrompt] = useState('')
  // Same photorealism-first lineup + vary toggle as the project Artwork tab,
  // single-sourced from IMAGE_MODELS so the two selectors can't drift apart.
  const [coverModel, setCoverModel] = useState<string>(IMAGE_MODELS[0].id)
  const [coverVary, setCoverVary] = useState(true)
  // Film finish (server-side grain / vignette / muted palette) — on by default.
  const [coverFilm, setCoverFilm] = useState(true)
  const [generatingCover, setGeneratingCover] = useState(false)
  const [coverError, setCoverError] = useState('')

  // Drag-to-reorder state
  const dragItem = useRef<number | null>(null)
  const dragOver = useRef<number | null>(null)
  // Snapshot of the order before a drag started, so we can roll back if the
  // reorder PATCH fails (otherwise the UI keeps the new order while the DB
  // keeps the old one — a silent desync that only shows up on reload).
  const preDragOrder = useRef<CollectionItem[] | null>(null)

  // Transient error toast for failed mutations.
  const [error, setError] = useState<string | null>(null)
  function flashError(msg: string) {
    setError(msg)
    setTimeout(() => setError(null), 4000)
  }

  const inCollection = new Set(items.map(i => i.project_id))
  const available = allProjects.filter(
    p => !inCollection.has(p.id) &&
      (!search.trim() || p.title.toLowerCase().includes(search.toLowerCase()))
  )

  // ── Cover picker ─────────────────────────────────────────────────────────────
  async function openCoverPicker() {
    setShowCoverPicker(true)
    if (!coverPrompt) {
      setCoverPrompt(`album cover art for "${collection.title}", cinematic, high detail, no text`)
    }
    setLoadingMedia(true)
    // Always reset the loading flag, even if the fetch rejects (e.g. the device
    // drops connectivity) — otherwise the grid stays stuck on "Loading…".
    try {
      const res = await fetch('/api/media')
      if (res.ok) setMediaItems(await res.json())
    } catch {
      // leave mediaItems as-is; the grid shows its empty/"no artwork" state
    } finally {
      setLoadingMedia(false)
    }
  }

  function closeCoverPicker() {
    setShowCoverPicker(false)
    setCoverSearch('')
    setCoverGenMode(false)
    setCoverError('')
  }

  async function setCover(url: string | null) {
    const res = await fetch(`/api/collections/${collection.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cover_url: url }),
    })
    if (res.ok) {
      setCoverUrl(url)
      closeCoverPicker()
    } else {
      flashError('Could not update the cover — try again.')
    }
  }

  // Generate a brand-new cover (not tied to any project) — the API uploads it
  // and sets cover_url server-side; we just reflect it and close.
  async function generateCover() {
    if (!coverPrompt.trim() || generatingCover) return
    setGeneratingCover(true)
    setCoverError('')
    // Guard the JSON parse: a gateway error (e.g. a Railway 502 during a deploy)
    // returns an HTML body, so res.json() would throw. Without the try/finally
    // the spinner would stay stuck "Generating…" forever, forcing a modal close.
    try {
      const res = await fetch('/api/generate-artwork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection_id: collection.id, prompt: coverPrompt.trim(), model: coverModel, vary: coverVary, finish: coverFilm ? 'film' : 'none' }),
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data?.artwork_url) {
        setCoverUrl(data.artwork_url)
        closeCoverPicker()
      } else {
        setCoverError(data?.error ?? 'Generation failed. Try again.')
      }
    } catch {
      setCoverError('Network error. Try again.')
    } finally {
      setGeneratingCover(false)
    }
  }

  // ── Change collection type ────────────────────────────────────────────────────
  async function changeType(newType: string) {
    setShowTypePicker(false)
    if (newType === type) return
    const prev = type
    setType(newType) // optimistic — roll back if the PATCH fails
    const res = await fetch(`/api/collections/${collection.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: newType }),
    })
    if (!res.ok) setType(prev)
  }

  // ── Add / remove tracks ───────────────────────────────────────────────────────
  async function addProject(projectId: string) {
    setAdding(projectId)
    const res = await fetch(`/api/collections/${collection.id}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, position: items.length }),
    })
    if (res.ok) {
      const newItem = await res.json()
      const project = allProjects.find(p => p.id === projectId)
      setItems(prev => [...prev, {
        ...newItem,
        mb_projects: project
          ? { title: project.title, artwork_url: project.artwork_url, genre: project.genre ?? null }
          : null,
      }])
    }
    setAdding(null)
  }

  async function removeItem(itemId: string) {
    const res = await fetch(`/api/collections/${collection.id}/items?itemId=${itemId}`, { method: 'DELETE' })
    if (res.ok) setItems(prev => prev.filter(i => i.id !== itemId))
  }

  // ── Drag-to-reorder ───────────────────────────────────────────────────────────
  function onDragStart(e: React.DragEvent, idx: number) {
    dragItem.current = idx
    preDragOrder.current = items  // snapshot the pre-drag order for rollback
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', '')
  }

  function onDragEnter(idx: number) {
    dragOver.current = idx
    if (dragItem.current === null || dragItem.current === idx) return
    const from = dragItem.current
    dragItem.current = idx  // Update ref before setItems so the updater is pure
    setItems(prev => {
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(idx, 0, moved)
      return next
    })
  }

  async function onDragEnd() {
    dragItem.current = null
    dragOver.current = null
    const snapshot = preDragOrder.current
    preDragOrder.current = null
    // Persist new order to API; roll back to the pre-drag order if it fails so
    // the UI never silently diverges from the saved order.
    const reordered = items.map((item, i) => ({ id: item.id, position: i }))
    try {
      const res = await fetch(`/api/collections/${collection.id}/items`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: reordered }),
      })
      if (!res.ok) throw new Error('reorder failed')
    } catch {
      if (snapshot) setItems(snapshot)
      flashError('Could not save the new track order — reverted.')
    }
  }

  // ── Delete collection ─────────────────────────────────────────────────────────
  async function deleteCollection() {
    if (!confirm(`Delete "${collection.title}"? This can't be undone.`)) return
    // Only navigate away once the delete actually succeeds — otherwise the user
    // is redirected to /collections while the collection still exists, and it
    // reappears in the list as if nothing happened.
    const res = await fetch(`/api/collections/${collection.id}`, { method: 'DELETE' }).catch(() => null)
    if (res?.ok) {
      router.push('/collections')
    } else {
      flashError('Could not delete the collection — try again.')
    }
  }

  // ── Share link ────────────────────────────────────────────────────────────────
  // Copies the public album player link. The API mints the token
  // on first use, so this works for collections created before migration 019.
  const [shareCopied, setShareCopied] = useState(false)
  const [sharing, setSharing] = useState(false)
  async function copyShareLink() {
    if (sharing) return
    setSharing(true)
    try {
      const res = await fetch(`/api/collections/${collection.id}/share`, { method: 'POST' })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.share_token) {
        flashError('Could not create the share link — try again.')
        return
      }
      // The API builds the canonical mixbase.app/album/<artist>/<title>/<token>
      // URL server-side; never use window.location.origin here — it leaks the
      // Railway host when the app is opened via the deployment URL.
      const url: string = data.url ?? albumShareUrl(null, collection.title, data.share_token)
      if (await copyToClipboard(url)) {
        setShareCopied(true)
        setTimeout(() => setShareCopied(false), 2000)
      } else {
        // Clipboard blocked (insecure origin / some iOS webviews) — surface the
        // link so Share isn't a silent dead button.
        alert(`Couldn't copy automatically. Copy this link:\n${url}`)
      }
    } catch {
      flashError('Could not create the share link — try again.')
    } finally {
      setSharing(false)
    }
  }

  // ── Export tracklist as Markdown ──────────────────────────────────────────────
  // Copies the collection's ordered tracklist as one Markdown doc (heading +
  // track count + numbered tracks) so it can leave the app — release notes, a
  // distributor submission, a message to a collaborator. Mirrors the feedback /
  // release-plan exports: clipboard first, falling back to a .md download where
  // the Clipboard API is unavailable (iOS wrapper / non-secure contexts).
  const [exported, setExported] = useState(false)
  async function exportTracklist() {
    const md = buildCollectionExport(
      { title: collection.title, type },
      items.map(i => ({ title: i.mb_projects?.title ?? null, genre: i.mb_projects?.genre })),
    )
    const filename = `${collection.title} — tracklist.md`
    try {
      await navigator.clipboard.writeText(md)
      setExported(true)
      setTimeout(() => setExported(false), 2000)
    } catch {
      const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }))
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    }
  }

  const filteredMedia = mediaItems.filter(m =>
    !coverSearch.trim() || m.title.toLowerCase().includes(coverSearch.toLowerCase())
  )

  const errorToast = error ? (
    <div
      className="fixed bottom-24 md:bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg"
      style={{ backgroundColor: 'var(--surface)', color: '#f87171', border: '1px solid var(--surface-2)' }}
      role="alert"
    >
      {error}
    </div>
  ) : null

  // ── Player view (default): same experience as the public share page ────────────
  const playerTracks: AlbumPlayerTrack[] = items.map(item => {
    const meta = trackMeta[item.project_id]
    return {
      id: item.project_id,
      title: item.mb_projects?.title ?? 'Untitled',
      genre: item.mb_projects?.genre ?? null,
      artworkUrl: item.mb_projects?.artwork_url ?? null,
      visualizerUrl: meta?.visualizerUrl ?? null,
      audioUrl: meta?.audioUrl ?? null,
      duration: meta?.duration ?? null,
    }
  })

  if (view === 'player' && items.length > 0) {
    return (
      <div className="min-h-screen bg-black flex flex-col pb-28 md:pb-6">
        {errorToast}

        {/* Toolbar */}
        <div className="relative z-20 w-full max-w-6xl mx-auto px-5 sm:px-8 pt-4 flex items-center gap-2">
          <Link
            href="/collections"
            className="p-1.5 rounded-lg transition-colors text-white/50 hover:text-white"
            title="Back to collections"
          >
            <ArrowLeft size={18} />
          </Link>
          <span
            className="text-xs font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full"
            style={{ backgroundColor: 'var(--accent-dim)', color: 'var(--accent)' }}
          >
            {TYPE_LABEL[type] ?? type}
          </span>
          <span className="flex-1" />
          <button
            onClick={copyShareLink}
            disabled={sharing}
            className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium transition-colors disabled:opacity-60"
            style={{ backgroundColor: 'var(--accent-dim)', color: 'var(--accent)' }}
            title={shareCopied ? 'Link copied!' : 'Copy public share link'}
          >
            {shareCopied ? <Check size={14} /> : <Share2 size={14} />}
            <span className="hidden sm:inline">{shareCopied ? 'Copied!' : 'Share'}</span>
          </button>
          <button
            onClick={exportTracklist}
            className="p-2 rounded-lg transition-colors"
            style={{ color: exported ? 'var(--accent)' : 'rgba(255,255,255,0.5)' }}
            title={exported ? 'Copied!' : 'Export tracklist as Markdown'}
          >
            {exported ? <Check size={16} /> : <FileText size={16} />}
          </button>
          <button
            onClick={() => setView('edit')}
            className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium transition-colors text-white/70 hover:text-white"
            style={{ backgroundColor: 'rgba(255,255,255,0.08)' }}
            title="Edit tracks, cover, and details"
          >
            <Pencil size={13} />
            <span className="hidden sm:inline">Edit</span>
          </button>
          <button
            onClick={deleteCollection}
            className="p-2 rounded-lg transition-colors text-white/40 hover:text-white/70"
            title="Delete collection"
          >
            <Trash2 size={16} />
          </button>
        </div>

        <AlbumPlayer
          title={collection.title}
          typeLabel={TYPE_LABEL[type] ?? type}
          coverUrl={coverUrl}
          artistName={artistName}
          tracks={playerTracks}
          sourceId="collection-player"
        />
      </div>
    )
  }

  // ── Edit view: track management ────────────────────────────────────────────────
  return (
    <div className="min-h-screen pb-36 md:pb-12" style={{ backgroundColor: 'var(--bg-page)' }}>
      {errorToast}
      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-16 sm:pt-20">

        {/* Header */}
        <div className="flex items-start gap-3 mb-8 pt-4">
          <Link
            href="/collections"
            className="mt-0.5 p-1.5 rounded-lg transition-colors flex-shrink-0"
            style={{ color: 'var(--text-muted)' }}
          >
            <ArrowLeft size={18} />
          </Link>

          {/* Cover art */}
          <div className="flex-shrink-0 relative group">
            <div
              className="w-20 h-20 rounded-xl overflow-hidden cursor-pointer"
              style={{ backgroundColor: 'var(--surface-2)', border: '1px solid var(--surface-2)' }}
              onClick={openCoverPicker}
            >
              {coverUrl ? (
                <Image src={coverUrl} alt="Cover" fill className="object-cover" unoptimized />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center gap-1">
                  <CassetteIcon size={22} style={{ color: 'var(--surface-3)' }} />
                </div>
              )}
              {/* Hover overlay */}
              <div className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <ImageIcon size={16} className="text-white" />
              </div>
            </div>
          </div>

          <div className="flex-1 min-w-0">
            <div className="relative inline-block mb-1.5">
              <button
                onClick={() => setShowTypePicker(v => !v)}
                className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full transition-opacity hover:opacity-80"
                style={{ backgroundColor: 'var(--accent-dim)', color: 'var(--accent)' }}
                title="Change type"
              >
                {TYPE_LABEL[type] ?? type}
                <ChevronDown size={11} />
              </button>
              {showTypePicker && (
                <div
                  className="absolute left-0 top-full mt-1 z-20 rounded-lg overflow-hidden py-1 min-w-[7rem]"
                  style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--surface-2)' }}
                >
                  {TYPES.map(t => (
                    <button
                      key={t}
                      onClick={() => changeType(t)}
                      className="block w-full text-left px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/5"
                      style={{ color: t === type ? 'var(--accent)' : 'var(--text)' }}
                    >
                      {TYPE_LABEL[t]}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <h1 className="text-2xl font-bold leading-tight" style={{ color: 'var(--text)' }}>{collection.title}</h1>
            <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {items.length} {items.length === 1 ? 'track' : 'tracks'}
            </p>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0 mt-1">
            {items.length > 0 && (
              <button
                onClick={() => setView('player')}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors"
                style={{ backgroundColor: 'var(--accent)', color: 'var(--bg-page)' }}
                title="Back to the player"
              >
                <Play size={14} fill="currentColor" />
                <span className="hidden sm:inline">Done</span>
              </button>
            )}
            {items.length > 0 && (
              <button
                onClick={exportTracklist}
                className="p-2 rounded-lg transition-colors"
                style={{ color: exported ? 'var(--accent)' : 'var(--text-muted)' }}
                title={exported ? 'Copied!' : 'Export tracklist as Markdown'}
              >
                {exported ? <Check size={16} /> : <FileText size={16} />}
              </button>
            )}
            <button
              onClick={deleteCollection}
              className="p-2 rounded-lg transition-colors"
              style={{ color: 'var(--text-muted)' }}
              title="Delete collection"
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>

        {/* Cover picker modal */}
        {showCoverPicker && (
          <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4"
            style={{ backgroundColor: 'rgba(0,0,0,0.75)' }}
            onClick={e => { if (e.target === e.currentTarget) closeCoverPicker() }}
          >
            <div
              className="w-full sm:max-w-2xl max-h-[88vh] sm:max-h-[82vh] rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col"
              style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--surface-2)' }}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0" style={{ borderColor: 'var(--surface-2)' }}>
                <h3 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Choose cover</h3>
                <button onClick={closeCoverPicker} className="p-1 rounded-lg transition-colors" style={{ color: 'var(--text-muted)' }}>
                  <X size={18} />
                </button>
              </div>

              {/* Toolbar */}
              <div className="flex items-center gap-2 px-4 py-2.5 border-b flex-shrink-0" style={{ borderColor: 'var(--surface-2)' }}>
                <Search size={14} style={{ color: 'var(--text-muted)' }} />
                <input
                  type="text"
                  value={coverSearch}
                  onChange={e => setCoverSearch(e.target.value)}
                  placeholder="Search artwork…"
                  className="flex-1 bg-transparent text-sm outline-none min-w-0"
                  style={{ color: 'var(--text)' }}
                />
                {coverUrl && (
                  <button
                    onClick={() => setCover(null)}
                    className="text-xs px-2 py-1 rounded-md transition-colors flex-shrink-0"
                    style={{ color: '#f87171' }}
                  >
                    Remove
                  </button>
                )}
                <button
                  onClick={() => setCoverGenMode(v => !v)}
                  className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-lg transition-colors flex-shrink-0"
                  style={coverGenMode
                    ? { backgroundColor: 'var(--accent)', color: 'var(--bg-page)' }
                    : { backgroundColor: 'var(--surface-2)', color: 'var(--text)' }}
                >
                  <Sparkles size={13} />
                  Generate
                </button>
              </div>

              {/* Generate panel */}
              {coverGenMode && (
                <div className="px-4 py-3 border-b flex-shrink-0 space-y-2" style={{ borderColor: 'var(--surface-2)' }}>
                  <div className="grid grid-cols-3 gap-1 p-0.5 rounded-xl" style={{ backgroundColor: 'var(--surface-2)' }}>
                    {IMAGE_MODELS.map(m => (
                      <button
                        key={m.id}
                        onClick={() => setCoverModel(m.id)}
                        className="py-1.5 px-1 text-[10px] font-medium rounded-lg transition-colors"
                        style={coverModel === m.id
                          ? { backgroundColor: 'var(--accent-dim)', color: 'var(--accent)' }
                          : { color: 'var(--text-muted)' }}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                  {/* Vary toggle — server appends a random lens/light/weather/mood
                      treatment so repeat covers don't all share one look */}
                  <button
                    onClick={() => setCoverVary(v => !v)}
                    className="flex items-center gap-2 text-[11px] transition-colors"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <span
                      className="w-8 h-4 rounded-full relative transition-colors flex-shrink-0"
                      style={{ backgroundColor: coverVary ? 'var(--accent)' : 'var(--surface-2)' }}
                    >
                      <span
                        className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all"
                        style={{ left: coverVary ? '1rem' : '0.125rem' }}
                      />
                    </span>
                    Vary the look (random camera, light &amp; weather)
                  </button>
                  {/* Film finish toggle — server adds grain, a soft vignette and a
                      slightly muted palette after generation. Off = untouched pixels. */}
                  <button
                    onClick={() => setCoverFilm(v => !v)}
                    className="flex items-center gap-2 text-[11px] transition-colors"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <span
                      className="w-8 h-4 rounded-full relative transition-colors flex-shrink-0"
                      style={{ backgroundColor: coverFilm ? 'var(--accent)' : 'var(--surface-2)' }}
                    >
                      <span
                        className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all"
                        style={{ left: coverFilm ? '1rem' : '0.125rem' }}
                      />
                    </span>
                    Film finish (grain, vignette &amp; muted colour)
                  </button>
                  <textarea
                    value={coverPrompt}
                    onChange={e => setCoverPrompt(e.target.value)}
                    rows={3}
                    placeholder="Describe the cover…"
                    className="w-full rounded-xl px-3 py-2 text-xs outline-none resize-none"
                    style={{ backgroundColor: 'var(--bg-page)', color: 'var(--text)', border: '1px solid var(--surface-2)' }}
                  />
                  {coverError && <p className="text-xs" style={{ color: '#f87171' }}>{coverError}</p>}
                  <button
                    onClick={generateCover}
                    disabled={generatingCover || !coverPrompt.trim()}
                    className="w-full flex items-center justify-center gap-2 py-2 text-xs font-semibold rounded-xl transition-colors disabled:opacity-40"
                    style={{ backgroundColor: 'var(--accent)', color: 'var(--bg-page)' }}
                  >
                    {generatingCover ? (
                      <><span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />Generating…</>
                    ) : (
                      <><Sparkles size={13} />Generate cover</>
                    )}
                  </button>
                </div>
              )}

              {/* Grid */}
              <div className="flex-1 overflow-y-auto p-3">
                {loadingMedia ? (
                  <div className="py-10 text-sm text-center" style={{ color: 'var(--text-muted)' }}>Loading…</div>
                ) : filteredMedia.length === 0 ? (
                  <p className="py-10 text-sm text-center" style={{ color: 'var(--text-muted)' }}>
                    {coverSearch ? 'No artwork found.' : 'No generated artwork yet — use Generate above.'}
                  </p>
                ) : (
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                    {filteredMedia.map(m => (
                      <button
                        key={m.id}
                        onClick={() => m.artwork_url && setCover(m.artwork_url)}
                        className="relative aspect-square rounded-lg overflow-hidden group transition-transform hover:scale-[1.03]"
                        style={{
                          backgroundColor: 'var(--surface-2)',
                          outline: coverUrl === m.artwork_url ? '2px solid var(--accent)' : '2px solid transparent',
                          outlineOffset: 2,
                        }}
                        title={m.title}
                      >
                        {m.artwork_url && (
                          <Image src={m.artwork_url} alt={m.title} fill className="object-cover" unoptimized />
                        )}
                        <div className="absolute inset-0 bg-black/60 flex items-end p-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <p className="text-[10px] text-white font-medium leading-tight text-left line-clamp-2">{m.title}</p>
                        </div>
                        {coverUrl === m.artwork_url && (
                          <div className="absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center" style={{ backgroundColor: 'var(--accent)' }}>
                            <span className="text-black text-xs font-bold">✓</span>
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Track list */}
        <div className="space-y-1 mb-5">
          {items.length === 0 && (
            <p className="py-10 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              No tracks yet — add some below.
            </p>
          )}
          {items.map((item, idx) => (
            <div
              key={item.id}
              draggable
              onDragStart={e => onDragStart(e, idx)}
              onDragEnter={() => onDragEnter(idx)}
              onDragEnd={onDragEnd}
              onDragOver={e => e.preventDefault()}
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl group transition-colors cursor-default"
              style={{ backgroundColor: 'var(--surface)' }}
            >
              {/* Drag handle — drag only initiates from here */}
              <GripVertical
                data-drag-handle
                size={14}
                className="flex-shrink-0 cursor-grab active:cursor-grabbing opacity-30 group-hover:opacity-70 transition-opacity"
                style={{ color: 'var(--text-muted)' }}
              />

              {/* Track number */}
              <span
                className="w-4 text-right text-xs font-mono flex-shrink-0"
                style={{ color: 'var(--text-muted)' }}
              >
                {idx + 1}
              </span>

              {/* Artwork + title — tap to open the song's project page */}
              <Link
                draggable={false}
                href={`/projects/${item.project_id}`}
                className="flex items-center gap-3 flex-1 min-w-0 group/open"
              >
                <div
                  className="w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 relative"
                  style={{ backgroundColor: 'var(--surface-2)' }}
                >
                  {item.mb_projects?.artwork_url ? (
                    <Image src={item.mb_projects.artwork_url} alt="" fill className="object-cover" unoptimized />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <CassetteIcon size={14} style={{ color: 'var(--surface-3)' }} />
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate transition-colors group-hover/open:text-[var(--accent)]" style={{ color: 'var(--text)' }}>
                    {item.mb_projects?.title ?? 'Untitled'}
                  </p>
                  {item.mb_projects?.genre && (
                    <p className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>{item.mb_projects.genre}</p>
                  )}
                </div>
              </Link>

              {/* Actions — draggable={false} prevents the row's drag from swallowing clicks */}
              <button
                draggable={false}
                onClick={() => {
                  // Playing from a collection: next/prev/auto-advance must follow the
                  // collection's track order, not the app-wide list. Only queue tracks
                  // that actually have an uploaded mix — PlayerContext.next() has no
                  // skip-non-playable logic, so a queued mix-less project would stall
                  // auto-advance (playTrack no-ops on an id absent from /api/tracks).
                  setQueue(items.filter(i => trackMeta[i.project_id]?.audioUrl).map(i => i.project_id))
                  playTrack(item.project_id)
                }}
                className="opacity-60 group-hover:opacity-100 p-1.5 rounded-lg transition-all flex-shrink-0"
                style={{ color: 'var(--accent)' }}
                title="Play"
              >
                <Play size={14} fill="currentColor" />
              </button>
              <button
                draggable={false}
                onClick={() => removeItem(item.id)}
                className="opacity-60 group-hover:opacity-100 p-1.5 rounded-lg transition-all flex-shrink-0"
                style={{ color: '#f87171' }}
                title="Remove from collection"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>

        {/* Add track */}
        {!showPicker ? (
          <button
            onClick={() => setShowPicker(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
            style={{ backgroundColor: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--surface-2)' }}
          >
            <Plus size={16} />
            Add Track
          </button>
        ) : (
          <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--surface-2)' }}>
            <div
              className="flex items-center gap-2 px-3 py-2.5"
              style={{ backgroundColor: 'var(--surface)' }}
            >
              <Search size={14} style={{ color: 'var(--text-muted)' }} />
              <input
                autoFocus
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search tracks…"
                className="flex-1 bg-transparent text-sm outline-none"
                style={{ color: 'var(--text)' }}
              />
              <button
                onClick={() => { setShowPicker(false); setSearch('') }}
                className="text-xs px-2 py-1 rounded-md transition-colors"
                style={{ color: 'var(--text-muted)' }}
              >
                Done
              </button>
            </div>
            <div className="max-h-64 overflow-y-auto">
              {available.length === 0 ? (
                <p className="px-4 py-4 text-sm" style={{ color: 'var(--text-muted)' }}>
                  {search ? 'No matches.' : 'All projects are already in this collection.'}
                </p>
              ) : (
                available.map(p => (
                  <button
                    key={p.id}
                    onClick={() => addProject(p.id)}
                    disabled={adding === p.id}
                    className="w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-white/5 disabled:opacity-50"
                    style={{ borderTop: '1px solid var(--surface-2)' }}
                  >
                    <div
                      className="w-8 h-8 rounded-md overflow-hidden flex-shrink-0 relative"
                      style={{ backgroundColor: 'var(--surface-2)' }}
                    >
                      {p.artwork_url ? (
                        <Image src={p.artwork_url} alt="" fill className="object-cover" unoptimized />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <CassetteIcon size={11} style={{ color: 'var(--surface-3)' }} />
                        </div>
                      )}
                    </div>
                    <span className="flex-1 text-sm truncate" style={{ color: 'var(--text)' }}>{p.title}</span>
                    {adding === p.id
                      ? <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Adding…</span>
                      : <Plus size={14} style={{ color: 'var(--text-muted)' }} />
                    }
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
