'use client'

import { useCallback, useEffect, useState, type ChangeEvent } from 'react'
import { Sparkles, Upload, X, Wand2, Download, RotateCcw } from 'lucide-react'
import Image from 'next/image'
import { downloadImage } from '@/lib/download'
import { TEXT_COLORS } from '@/lib/text-colors'
import { IMAGE_MODELS } from '@/lib/artwork-models'
// Type-only: erased at compile time, so the client bundle never pulls in
// artwork-history.ts's server-side dependency chain.
import type { ArtworkHistoryItem } from '@/lib/artwork-history'

type Position =
  | 'top-left' | 'top-center' | 'top-right'
  | 'middle-left' | 'middle-center' | 'middle-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right'
type Size = 'small' | 'medium' | 'large'
type Filter = 'none' | 'warm' | 'golden' | 'sepia' | 'cool' | 'icy' | 'vivid' | 'mono'
const FILTER_LABELS: { value: Filter; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'warm', label: 'Warm' },
  { value: 'golden', label: 'Golden' },
  { value: 'sepia', label: 'Sepia' },
  { value: 'cool', label: 'Cool' },
  { value: 'icy', label: 'Icy' },
  { value: 'vivid', label: 'Vivid' },
  { value: 'mono', label: 'B&W' },
]

const POSITION_GRID: Position[] = [
  'top-left', 'top-center', 'top-right',
  'middle-left', 'middle-center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right',
]

// The moodmixformat house style. This is the OWNER's personal aesthetic — it
// pre-fills the prompt only on the owner account (profiles.is_owner); every
// other artist starts from a blank prompt and their own ideas.
//
// Written the way a photographer captions a real building, not the way an
// AI-art prompt reads: concrete nouns, real materials, ordinary surroundings,
// nothing about "hyper-realistic" or "surreal" (the server strips those words
// anyway — they are what push a model into its CGI mode). The subject is the
// same cassette megastructure; only the language changed.
const OWNER_HOUSE_PROMPT =
  'a huge weathered concrete building whose long facade is shaped like a cassette tape, two enormous circular windows where the reels would be, streaked board-formed concrete, rust-stained steel, dirt and water marks, a cracked car park and an ordinary road in front of it, architectural photograph'

type Props = {
  projectId: string
  projectTitle: string
  genre?: string | null
  currentArtwork?: string | null
  currentFinalized?: string | null
  onArtworkUpdated: (url: string) => void
  onFinalizedUpdated: (url: string | null) => void
  // Finalize is a heavier action (Vision call + render) — keep it on the
  // dedicated Artwork tab, not on every embedded preview of this component.
  showFinalize?: boolean
  showActions?: boolean
  /** Pre-fill the owner's house-style prompt (owner account only) */
  ownerDefaults?: boolean
}

export default function ArtworkGenerator({
  projectId, projectTitle, genre,
  currentArtwork, currentFinalized,
  onArtworkUpdated, onFinalizedUpdated,
  showFinalize = true,
  showActions = true,
  ownerDefaults = false,
}: Props) {
  const [mode, setMode] = useState<'idle' | 'generate' | 'upload'>('idle')
  // Subject only — the photographic treatment (lens, light, weather, mood) is
  // layered on server-side by the Vary option so repeat runs look different.
  const [prompt, setPrompt] = useState(
    ownerDefaults
      ? `${OWNER_HOUSE_PROMPT} — ${projectTitle}${genre ? `, ${genre}` : ''}`
      : ''
  )
  const [model, setModel] = useState<string>(IMAGE_MODELS[0].id)
  const [vary, setVary] = useState(true)
  // Film finish (server-side grain / vignette / muted palette) — on by default;
  // it's the pass that takes the AI sheen off. `finish: 'none'` opts out.
  const [filmFinish, setFilmFinish] = useState(true)
  const [lastLook, setLastLook] = useState<string | null>(null)
  const [lastPrompt, setLastPrompt] = useState<string | null>(null)
  const [showLastPrompt, setShowLastPrompt] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [finalizing, setFinalizing] = useState(false)
  const [position, setPosition] = useState<Position>('top-left')
  const [size, setSize] = useState<Size>('medium')
  const [showRule, setShowRule] = useState(true)
  const [filter, setFilter] = useState<Filter>('none')
  const [color, setColor] = useState('#FFFFFF')
  // Artwork History. Deliberately a separate error slot from `error` above:
  // that one is shared by generate / upload / finalize and is rendered in two
  // places, so a failed history load would have surfaced as a spurious
  // "generate failed" message under the Generate panel.
  const [history, setHistory] = useState<ArtworkHistoryItem[]>([])
  const [historyError, setHistoryError] = useState('')
  const [restoring, setRestoring] = useState<string | null>(null)

  // Source artwork (Generate / Upload result) — what the renderer reads.
  const sourceUrl = currentArtwork ?? null
  // Preview prefers the finalized render when present so the user sees the
  // exported version. If they Generate or Upload again the parent clears
  // currentFinalized and we fall back to the new source.
  const previewUrl = currentFinalized ?? sourceUrl

  // Refetched whenever the live artwork changes, because every Generate,
  // Upload and Finalize adds an object to this project's prefix — the strip
  // would otherwise be stale the moment the user does the thing it documents.
  const loadHistory = useCallback(async () => {
    if (!showActions) return
    try {
      const res = await fetch(`/api/projects/${projectId}/artwork-history`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Could not load artwork history.')
      setHistory(data.items ?? [])
      setHistoryError('')
    } catch (err) {
      // Never speculative: an empty strip is indistinguishable from "no
      // history", so a failure has to say so rather than silently render
      // nothing and imply the user's past artwork does not exist.
      setHistory([])
      setHistoryError(err instanceof Error ? err.message : 'Could not load artwork history.')
    }
  }, [projectId, showActions])

  useEffect(() => { void loadHistory() }, [loadHistory, currentArtwork, currentFinalized])

  async function handleRestore(item: ArtworkHistoryItem) {
    setRestoring(item.path)
    setHistoryError('')
    try {
      const res = await fetch(`/api/projects/${projectId}/artwork-history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: item.path }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Could not restore that artwork.')
      // Mirror the server's own rule (artworkRestorePatch): a finalized render
      // IS the finished cover, so it replaces only the finalized slot; a source
      // image replaces artwork_url and clears the finalized render made from
      // the old source. Same callback pair Generate and Upload use.
      if (data.restored === 'finalized') {
        onFinalizedUpdated(data.finalized_artwork_url)
      } else {
        onArtworkUpdated(data.artwork_url)
        onFinalizedUpdated(null)
      }
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : 'Could not restore that artwork.')
    } finally {
      setRestoring(null)
    }
  }

  async function handleFinalize() {
    if (!sourceUrl) return
    setFinalizing(true)
    setError('')
    // Guard the JSON parse: a gateway error (e.g. a Railway 502 during a deploy)
    // returns an HTML body, so res.json() would throw. Without the try/finally
    // the spinner would stay stuck "Finalizing…" forever with no error shown.
    // Same shape as generateCover() in collections/[id]/CollectionClient.tsx.
    try {
      const res = await fetch('/api/finalize-artwork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          position,
          size,
          showRule,
          filter,
          color,
        }),
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data?.finalized_artwork_url) {
        onFinalizedUpdated(data.finalized_artwork_url)
      } else {
        setError(data?.error ?? 'Finalize failed. Try again.')
      }
    } catch {
      setError('Network error. Try again.')
    } finally {
      setFinalizing(false)
    }
  }

  async function handleGenerate() {
    setGenerating(true)
    setError('')

    // Same gateway-HTML guard as handleFinalize above: generation is the
    // longest-running call on this screen, so it is the most likely to be in
    // flight across a deploy and the worst one to leave spinning.
    try {
      const res = await fetch('/api/generate-artwork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, prompt, model, vary, finish: filmFinish ? 'film' : 'none', title: projectTitle }),
      })

      const data = await res.json().catch(() => null)
      if (res.ok && data?.artwork_url) {
        onArtworkUpdated(data.artwork_url)
        // Server cleared finalized_artwork_url; mirror that in client state.
        onFinalizedUpdated(null)
        setLastLook(data.look ?? null)
        setLastPrompt(typeof data.prompt_used === 'string' ? data.prompt_used : null)
        setMode('idle')
      } else {
        setError(data?.error ?? 'Generation failed. Try again.')
      }
    } catch {
      setError('Network error. Try again.')
    } finally {
      setGenerating(false)
    }
  }

  async function handleUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    // Reset the file input so re-uploading the same filename still triggers onChange
    e.target.value = ''
    if (!file) return

    if (file.size > 50 * 1024 * 1024) {
      setError('Image too large — maximum size is 50 MB.')
      return
    }

    setUploading(true)
    setError('')

    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
    const filename = `${projectId}/${Date.now()}.${ext}`
    const contentType = file.type || 'image/jpeg'

    try {
      // Signed upload URL → PUT straight to Supabase. Never routes the image
      // bytes through Railway, whose proxy truncates request bodies at 10 MB.
      const urlRes = await fetch('/api/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, contentType, bucket: 'mf-artwork' }),
      })
      const urlData = await urlRes.json()
      if (!urlRes.ok) throw new Error(urlData.error ?? 'Could not get upload URL')

      const putRes = await fetch(urlData.signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType, 'x-upsert': 'true' },
        body: file,
      })
      if (!putRes.ok) throw new Error('Upload failed — please try again.')

      const artworkUrl = urlData.publicUrl as string
      // Persist artwork URL to DB — PATCH also nulls finalized_artwork_url.
      const patchRes = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artwork_url: artworkUrl }),
      })
      if (!patchRes.ok) throw new Error('Could not save artwork.')

      onArtworkUpdated(artworkUrl)
      onFinalizedUpdated(null)
      setMode('idle')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed. Try again.')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-3">
      {/* Current artwork preview */}
      <div className="relative w-full aspect-square rounded-xl overflow-hidden bg-[#111] border border-[#1e1e1e]">
        {previewUrl ? (
          <Image src={previewUrl} alt="Project artwork" fill className="object-cover" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <div className="w-12 h-12 rounded-full bg-[#1a1a1a] flex items-center justify-center mx-auto mb-2">
                <Sparkles size={20} className="text-[#444]" />
              </div>
              <p className="text-xs text-[#444]">No artwork</p>
            </div>
          </div>
        )}
      </div>

      {/* Applied vary treatment — tells the user why this shot looks the way
          it does, and what to re-roll for */}
      {lastLook && mode === 'idle' && (
        <p className="text-[10px] text-[#666] leading-snug">Look: {lastLook}</p>
      )}
      {/* The exact prompt that ran — so the artist can see what the server
          added (and stripped) and steer the next run. */}
      {lastPrompt && mode === 'idle' && (
        <div className="text-[10px] text-[#666] leading-snug">
          <button
            type="button"
            onClick={() => setShowLastPrompt(v => !v)}
            className="underline decoration-dotted hover:text-[#999] transition-colors"
          >
            {showLastPrompt ? 'Hide prompt sent' : 'Show prompt sent'}
          </button>
          {showLastPrompt && <p className="mt-1 break-words">{lastPrompt}</p>}
        </div>
      )}

      {/* Download — generated/source image and the finalized render (with
          baked-in text) are separate exports. Only shown on the full Artwork
          tab, not the compact project-header thumbnail. */}
      {showActions && mode === 'idle' && (sourceUrl || currentFinalized) && (
        <div className="flex gap-2">
          {sourceUrl && (
            <button
              onClick={() => downloadImage(sourceUrl, `${projectTitle} artwork`)}
              className="flex-1 flex items-center justify-center gap-2 py-2 text-xs font-medium bg-[#1e1e1e] border border-[#333] text-white rounded-xl hover:bg-[#2a2a2a] transition-colors"
            >
              <Download size={13} />
              {currentFinalized ? 'Download Original' : 'Download Image'}
            </button>
          )}
          {currentFinalized && (
            <button
              onClick={() => downloadImage(currentFinalized, `${projectTitle} finalized`)}
              className="flex-1 flex items-center justify-center gap-2 py-2 text-xs font-medium bg-[#1e1e1e] border border-[#333] text-white rounded-xl hover:bg-[#2a2a2a] transition-colors"
            >
              <Download size={13} />
              Download Finalized
            </button>
          )}
        </div>
      )}

      {/* Action buttons */}
      {showActions && mode === 'idle' && (
        <div className="flex gap-2">
          <button
            onClick={() => setMode('generate')}
            disabled={uploading}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 text-xs font-semibold bg-[#2dd4bf] text-[#0a0a0a] rounded-xl hover:bg-[#14b8a6] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Sparkles size={13} />
            Generate with AI
          </button>
          <label className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-xs font-semibold bg-[#1e1e1e] border border-[#333] text-white rounded-xl transition-colors ${uploading ? 'opacity-50 cursor-wait' : 'hover:bg-[#2a2a2a] cursor-pointer'}`}>
            {uploading ? (
              <><span className="w-3 h-3 border border-white/30 border-t-white rounded-full animate-spin" />Uploading...</>
            ) : (
              <><Upload size={13} />Upload</>
            )}
            <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={handleUpload} disabled={uploading} className="hidden" />
          </label>
        </div>
      )}
      {error && !generating && <p className="text-red-400 text-xs">{error}</p>}

      {/* Previous artwork — every image this project has had, live one flagged.
          Restoring never deletes: the cover it replaces drops back into this
          strip. Hidden entirely when the only images are the live ones, so a
          project with a single cover gains no empty chrome. */}
      {showActions && mode === 'idle' && (historyError || history.some(i => !i.current)) && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#777] mb-1.5">
            Previous artwork
          </p>
          {historyError ? (
            <p className="text-red-400 text-xs" role="alert">{historyError}</p>
          ) : (
            <>
              <div className="grid grid-cols-4 gap-2">
                {history.map(item => (
                  <button
                    key={item.path}
                    type="button"
                    onClick={() => handleRestore(item)}
                    disabled={item.current || restoring !== null}
                    aria-label={
                      item.current
                        ? 'Current artwork'
                        : `Restore ${item.kind === 'finalized' ? 'finalized' : item.kind === 'generated' ? 'generated' : 'uploaded'} artwork${item.createdAt ? ` from ${new Date(item.createdAt).toLocaleDateString()}` : ''}`
                    }
                    title={item.current ? 'Current artwork' : 'Restore this artwork'}
                    className={`relative aspect-square rounded-lg overflow-hidden border transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[#2dd4bf] ${
                      item.current
                        ? 'border-[#2dd4bf] cursor-default'
                        : 'border-[#333] hover:border-[#2dd4bf] disabled:opacity-40 disabled:cursor-wait'
                    }`}
                  >
                    {/* alt="" — the button already carries the accessible name,
                        so naming the image too would double-announce it. */}
                    <Image src={item.url} alt="" fill unoptimized className="object-cover" />
                    {item.current && (
                      <span className="absolute inset-x-0 bottom-0 bg-[#2dd4bf] text-[#0a0a0a] text-[9px] font-semibold text-center py-0.5">
                        Current
                      </span>
                    )}
                    {restoring === item.path && (
                      <span className="absolute inset-0 flex items-center justify-center bg-black/60">
                        <span className="w-3 h-3 border border-[#2dd4bf]/30 border-t-[#2dd4bf] rounded-full animate-spin" />
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-[#777] flex items-center gap-1">
                <RotateCcw size={10} />
                Tap any image to make it current again. Nothing here is ever deleted.
              </p>
            </>
          )}
        </div>
      )}


      {/* Finalize button + guidance — gated on showFinalize so the project
          header thumbnail doesn't expose this heavy action. */}
      {showFinalize && mode === 'idle' && previewUrl && (
        <div className="space-y-2.5">
          {/* Placement — 3×3 anchor grid */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[#777] mb-1.5">Text placement</p>
            <div className="grid grid-cols-3 gap-1 w-28">
              {POSITION_GRID.map(pos => {
                const active = position === pos
                const [v, h] = pos.split('-')
                const justify = h === 'left' ? 'justify-start' : h === 'right' ? 'justify-end' : 'justify-center'
                const align = v === 'top' ? 'items-start' : v === 'bottom' ? 'items-end' : 'items-center'
                return (
                  <button
                    key={pos}
                    onClick={() => setPosition(pos)}
                    title={pos.replace('-', ' ')}
                    className={`aspect-square rounded-md border flex ${justify} ${align} p-1 transition-colors ${
                      active ? 'border-[#2dd4bf] bg-[#2dd4bf]/15' : 'border-[#2a2a2a] bg-[#0f0f0f] hover:border-[#444]'
                    }`}
                  >
                    <span className={`block w-1.5 h-1.5 rounded-full ${active ? 'bg-[#2dd4bf]' : 'bg-[#555]'}`} />
                  </button>
                )
              })}
            </div>
          </div>

          {/* Size */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[#777] mb-1.5">Size</p>
            <div className="flex gap-1 p-0.5 bg-[#0f0f0f] border border-[#222] rounded-xl">
              {(['small', 'medium', 'large'] as Size[]).map(s => (
                <button
                  key={s}
                  onClick={() => setSize(s)}
                  className={`flex-1 py-1.5 text-[10px] font-medium rounded-lg capitalize transition-colors ${
                    size === s ? 'bg-[#2dd4bf]/20 text-[#2dd4bf]' : 'text-[#555] hover:text-[#888]'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Filter — whole-image color grades */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[#777] mb-1.5">Filter</p>
            <div className="grid grid-cols-4 gap-1">
              {FILTER_LABELS.map(f => (
                <button
                  key={f.value}
                  onClick={() => setFilter(f.value)}
                  className={`py-1.5 text-[10px] font-medium rounded-lg border transition-colors ${
                    filter === f.value
                      ? 'bg-[#2dd4bf]/20 text-[#2dd4bf] border-[#2dd4bf]/40'
                      : 'text-[#777] border-[#222] bg-[#0f0f0f] hover:text-[#aaa]'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Text color — preset swatches + free picker, white by default */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[#777] mb-1.5">Text color</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              {TEXT_COLORS.map(c => {
                const active = color.toUpperCase() === c.value
                return (
                  <button
                    key={c.value}
                    onClick={() => setColor(c.value)}
                    title={c.label}
                    aria-label={`Text color ${c.label}`}
                    className={`w-7 h-7 rounded-full border-2 transition-all ${
                      active ? 'border-[#2dd4bf] scale-110' : 'border-[#333] hover:border-[#555]'
                    }`}
                    style={{ backgroundColor: c.value }}
                  />
                )
              })}
              <label
                title="Custom color"
                className={`relative w-7 h-7 rounded-full border-2 cursor-pointer overflow-hidden transition-all ${
                  TEXT_COLORS.some(c => c.value === color.toUpperCase())
                    ? 'border-[#333] hover:border-[#555]'
                    : 'border-[#2dd4bf] scale-110'
                }`}
                style={{ background: 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' }}
              >
                <input
                  type="color"
                  value={color}
                  onChange={e => setColor(e.target.value.toUpperCase())}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                  aria-label="Custom text color"
                />
              </label>
              <span className="text-[10px] text-[#666] font-mono ml-1">{color.toUpperCase()}</span>
            </div>
          </div>

          {/* Divider line toggle */}
          <button
            onClick={() => setShowRule(v => !v)}
            className="flex items-center gap-2 text-[11px] text-[#999] hover:text-white transition-colors"
          >
            <span className={`w-8 h-4 rounded-full relative transition-colors ${showRule ? 'bg-[#2dd4bf]' : 'bg-[#2a2a2a]'}`}>
              <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${showRule ? 'left-4' : 'left-0.5'}`} />
            </span>
            Divider line between name &amp; title
          </button>

          <button
            onClick={handleFinalize}
            disabled={finalizing}
            className="w-full flex items-center justify-center gap-2 py-2.5 text-xs font-semibold bg-[#0f0f0f] border border-[#2dd4bf]/40 text-[#2dd4bf] rounded-xl hover:bg-[#2dd4bf]/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {finalizing ? (
              <>
                <span className="w-3 h-3 border border-[#2dd4bf]/30 border-t-[#2dd4bf] rounded-full animate-spin" />
                Finalizing...
              </>
            ) : (
              <>
                <Wand2 size={13} />
                Finalize Artwork
              </>
            )}
          </button>
        </div>
      )}
      {/* Generate mode */}
      {showActions && mode === 'generate' && (
        <div className="space-y-2">
          {/* Model selector */}
          <div className="grid grid-cols-3 gap-1 p-0.5 bg-[#0f0f0f] border border-[#222] rounded-xl">
            {IMAGE_MODELS.map(m => (
              <button
                key={m.id}
                onClick={() => setModel(m.id)}
                className={`py-1.5 px-1 text-[10px] font-medium rounded-lg transition-colors ${
                  model === m.id ? 'bg-[#2dd4bf]/20 text-[#2dd4bf]' : 'text-[#555] hover:text-[#888]'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* Vary toggle — server appends a random lens/light/weather/mood
              treatment so repeat generations don't all share one look */}
          <button
            onClick={() => setVary(v => !v)}
            className="flex items-center gap-2 text-[11px] text-[#999] hover:text-white transition-colors"
          >
            <span className={`w-8 h-4 rounded-full relative transition-colors ${vary ? 'bg-[#2dd4bf]' : 'bg-[#2a2a2a]'}`}>
              <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${vary ? 'left-4' : 'left-0.5'}`} />
            </span>
            Vary the look (random camera, light &amp; weather each run)
          </button>
          {/* Film finish toggle — server adds grain, a soft vignette and a
              slightly muted palette after generation. Off = untouched pixels. */}
          <button
            onClick={() => setFilmFinish(v => !v)}
            className="flex items-center gap-2 text-[11px] text-[#999] hover:text-white transition-colors"
          >
            <span className={`w-8 h-4 rounded-full relative transition-colors ${filmFinish ? 'bg-[#2dd4bf]' : 'bg-[#2a2a2a]'}`}>
              <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${filmFinish ? 'left-4' : 'left-0.5'}`} />
            </span>
            Film finish (grain, vignette &amp; muted colour — hides the AI sheen)
          </button>
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            rows={3}
            placeholder="Describe it like a photo caption — what, where, light (e.g. 'an old cassette on a car dashboard, overcast light, faded colours'). Skip words like 8k or hyper-realistic; they make it look AI."
            className="w-full bg-[#0f0f0f] border border-[#222] rounded-xl px-3 py-2 text-xs text-white placeholder-[#444] focus:outline-none focus:border-[#2dd4bf]/40 resize-none"
          />
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={handleGenerate}
              disabled={generating || !prompt.trim()}
              className="flex-1 py-2 text-xs bg-[#2dd4bf] hover:bg-[#14b8a6] disabled:opacity-40 disabled:cursor-not-allowed text-[#0a0a0a] rounded-xl transition-colors font-medium"
            >
              {generating ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-3 h-3 border border-white/30 border-t-white rounded-full animate-spin" />
                  Generating...
                </span>
              ) : 'Generate'}
            </button>
            <button
              onClick={() => setMode('idle')}
              className="px-3 py-2 text-xs text-[#555] hover:text-white rounded-xl transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
