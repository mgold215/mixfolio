import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { checkAndIncrementUsage, refundUsage } from '@/lib/tier'
import { artworkLimiter, rateLimitHeaders , checkUserLimit } from '@/lib/rate-limit'
import { canonicalUuid } from '@/lib/validators'
import { MODEL_ENDPOINTS, MODEL_INPUTS, MODEL_INPUTS_MINIMAL, resolveModelKey, composeLook, composePrompt } from '@/lib/artwork-models'
import { applyFilmFinish } from '@/lib/film-finish'

// Allow up to 2 minutes — Flux 2 Pro can take 30-60s
export const maxDuration = 120

// Poll budget. Each probe carries its OWN timeout: Node's fetch (undici) waits
// up to ~5 minutes on a stalled socket, so a single hung poll could pin this
// handler — and the artwork slot it has already reserved — far past the nominal
// 2-minute budget. A wall-clock deadline bounds the loop regardless of how slow
// individual probes are; the old fixed 24 iterations bounded only the count.
// (`maxDuration` above is advisory here: Railway runs `next start`, a plain Node
// server, which does not enforce it — so nothing else would ever cut this off.)
const POLL_TIMEOUT_MS = 15_000
const POLL_BUDGET_MS = 120_000
// The two calls the poll fix left bare. Both are already wrapped in a catch
// that refunds — the gap was that nothing ever aborted them, so the refund
// could not run.
const CREATE_TIMEOUT_MS = 60_000
const DOWNLOAD_TIMEOUT_MS = 60_000

async function pollPrediction(predictionUrl: string, token: string): Promise<string | null> {
  const deadline = Date.now() + POLL_BUDGET_MS
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000))
    let p: { status?: string; output?: string | string[] | null; error?: unknown }
    try {
      const res = await fetch(predictionUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      })
      p = await res.json()
    } catch {
      // A timed-out or malformed probe is transient — Replicate may still be
      // working. Retry on the next tick rather than throwing: one flaky poll
      // must not cancel (and charge for) a generation that is about to succeed.
      // Falling out of the loop returns null, which the CALLER refunds — so this
      // branch adds no new refund path and cannot double-refund. (refundUsage is
      // not idempotent; a second call would double-decrement.)
      continue
    }
    if (p.status === 'succeeded') return Array.isArray(p.output) ? p.output[0] : p.output ?? null
    if (p.status === 'failed' || p.status === 'canceled') throw new Error(String(p.error ?? 'Prediction failed'))
  }
  return null
}

// POST /api/generate-artwork
export async function POST(request: NextRequest) {
  const userId = request.headers.get('X-User-Id')
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // Rate limit: 10/hour per user (defence-in-depth alongside the monthly tier gate)
  const limit = await checkUserLimit(artworkLimiter, userId)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Rate limit exceeded. Try again later.' }, { status: 429, headers: rateLimitHeaders(limit) })
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  const { project_id, collection_id, prompt, model, vary = false } = body

  if (!prompt?.trim()) {
    return NextResponse.json({ error: 'Prompt is required' }, { status: 400 })
  }

  // Film finish (grain / vignette / muted palette — see src/lib/film-finish.ts)
  // is ON unless the client explicitly sends `finish: 'none'`. Default-on so
  // clients that don't know the field (the iOS app) get the realism pass too.
  const finish: 'film' | 'none' = body.finish === 'none' ? 'none' : 'film'

  // resolveModelKey collapses any unknown / crafted model (incl. inherited
  // Object.prototype names like "__proto__") to a real key, so endpoint + input
  // stay paired and neither can be a non-function/non-URL that throws below.
  const modelKey = resolveModelKey(model)

  // Prompt composition (src/lib/artwork-models.ts): the artist's subject with
  // AI-art vocabulary stripped, an optional randomized vary-look so repeat runs
  // of the same subject produce visibly different shots, the documentary-
  // photography treatment, and the constraints last — no baked-in text ever
  // (finalize renders the lockup), no people unless the artist asked for them.
  // Composed before the paid call; echoed back so the UI can show what ran.
  const look = vary ? composeLook() : null
  const finalPrompt = composePrompt({ userPrompt: prompt.trim(), modelKey, look })

  // Two targets: a project's artwork, or a collection's cover. Exactly one id.
  const isCollection = !!collection_id
  // Canonical, not merely valid: targetId is BOTH the DB key and the storage
  // key prefix (`<targetId>/ai-…` or `covers/<targetId>/ai-…`), and only one of
  // those two normalises case. Postgres would match an uppercase spelling on the
  // ownership select below; Storage would keep it, minting an object outside
  // every reaper's reach. Canonicalising here means the id that clears the gate
  // is the same string that reaches both.
  const targetId = canonicalUuid(isCollection ? collection_id : project_id)

  // Reject malformed ids before they reach a storage key or DB write.
  if (!targetId) {
    return NextResponse.json(
      { error: `Valid ${isCollection ? 'collection_id' : 'project_id'} is required` },
      { status: 400 }
    )
  }

  // Ownership check: the write below targets this row, so confirm the caller
  // owns it. Without this an authenticated user could overwrite another user's
  // artwork/cover by passing their id (IDOR).
  const ownerTable = isCollection ? 'mb_collections' : 'mb_projects'
  const { data: ownerRow, error: ownerErr } = await supabaseAdmin
    .from(ownerTable)
    .select('id')
    .eq('id', targetId)
    .eq('user_id', userId)
    .single()
  if (ownerErr || !ownerRow) {
    return NextResponse.json({ error: `${isCollection ? 'Collection' : 'Project'} not found` }, { status: 404 })
  }

  // Gate: check monthly artwork limit before hitting Replicate
  const gate = await checkAndIncrementUsage(userId, 'artwork')
  if (gate.error) {
    // Couldn't reserve a slot (usage RPC failed) — don't run the paid call.
    return NextResponse.json({ error: 'Could not reserve a generation slot. Please try again.' }, { status: 503 })
  }
  if (!gate.allowed) {
    return NextResponse.json(
      { error: `Monthly artwork limit reached (${gate.used}/${gate.limit}). Your quota resets at the start of next month.`, upgrade: true },
      { status: 403 }
    )
  }

  // The artwork slot is now reserved (checkAndIncrementUsage incremented it).
  // Every failure path below must release it, or a provider/config hiccup would
  // permanently burn the user's monthly quota with nothing to show for it.
  // Refund the SAME month that was reserved (gate.month) so a generation that
  // straddles a UTC month boundary can't refund the wrong month.
  const refund = () => refundUsage(userId, 'artwork', gate.month)

  const replicateToken = process.env.REPLICATE_API_TOKEN?.trim().replace(/^["']|["']$/g, '')
  if (!replicateToken) {
    await refund()
    console.error('[generate-artwork] REPLICATE_API_TOKEN is not set')
    return NextResponse.json({ error: 'AI artwork generation is temporarily unavailable.' }, { status: 503 })
  }
  if (!replicateToken.startsWith('r8_')) {
    await refund()
    // Keep the diagnostic detail in the server log only — never echo token
    // characteristics back to the client.
    console.error('[generate-artwork] Token looks wrong, starts with:', replicateToken.slice(0, 4))
    return NextResponse.json({ error: 'AI artwork generation is temporarily unavailable.' }, { status: 503 })
  }

  const endpoint = MODEL_ENDPOINTS[modelKey]

  // The slot is already reserved, so a network/JSON failure on the paid call must
  // refund — matching pollPrediction's catch below. Without this an outbound
  // hiccup would throw uncaught (500) and silently burn the user's monthly quota.
  let replicateRes: Response
  let prediction: {
    error?: unknown
    detail?: string
    output?: string | string[] | null
    status?: string
    urls?: { get?: string }
  }
  const createPrediction = (input: Record<string, unknown>) => fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${replicateToken}`,
      'Content-Type': 'application/json',
      Prefer: 'wait',
    },
    body: JSON.stringify({ input }),
    // `Prefer: wait` makes Replicate hold the connection open until the
    // prediction settles, so this call is long-lived BY DESIGN — which is
    // exactly why it needs an explicit ceiling. undici enforces no response
    // timeout of its own; without this a stalled socket pins the handler and
    // the reserved slot indefinitely. A throw here is already refunded by the
    // enclosing catch.
    signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
  })
  try {
    replicateRes = await createPrediction(MODEL_INPUTS[modelKey](finalPrompt))
    // 422 = Replicate rejected the INPUT SHAPE (an optional tuning field the
    // provider renamed or dropped), not the prompt. Provider schemas move
    // without notice, and the tuned inputs carry realism knobs (raw mode,
    // guidance, steps) that can't be exercised from CI. Retry once with the
    // documented core schema so the user gets a plain generation instead of a
    // hard error; log loudly so the tuning gets fixed.
    if (replicateRes.status === 422) {
      const detail = await replicateRes.text().catch(() => '')
      console.error(`[generate-artwork] ${modelKey} rejected tuned input (422), retrying minimal:`, detail.slice(0, 500))
      replicateRes = await createPrediction(MODEL_INPUTS_MINIMAL[modelKey](finalPrompt))
    }
    prediction = await replicateRes.json()
  } catch (err) {
    await refund()
    console.error('[generate-artwork] Replicate request failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Image generation failed. Please try again.' }, { status: 502 })
  }

  if (!replicateRes.ok || prediction.error) {
    await refund()
    console.error('[generate-artwork] Replicate error:', replicateRes.status, JSON.stringify(prediction))
    return NextResponse.json({ error: prediction.detail ?? prediction.error ?? 'Image generation failed' }, { status: 500 })
  }

  let outputUrl: string | null = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output ?? null

  // Poll if still processing
  if (!outputUrl && prediction.urls?.get) {
    try {
      outputUrl = await pollPrediction(prediction.urls.get, replicateToken)
    } catch (err) {
      await refund()
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Generation failed' }, { status: 500 })
    }
  }

  if (!outputUrl) {
    await refund()
    console.error('[generate-artwork] No output. Status:', prediction.status, 'Full:', JSON.stringify(prediction))
    return NextResponse.json({ error: `No image returned (status: ${prediction.status ?? 'unknown'})` }, { status: 500 })
  }

  // Download generated image — no stamping. Any text overlay belongs in
  // /api/finalize-artwork, not here, so Finalize never has to deal with text
  // already burned into the source. The only pass applied before saving is
  // the (opt-out) film finish below, which changes tone and texture, never
  // content.
  //
  // The slot is reserved, so a throw fetching/reading the image (CDN blip,
  // stream reset) between Replicate's succeeded prediction and the byte download
  // must refund — the create/poll paths above already do, this was the one
  // remaining un-guarded step that would 500 uncaught and burn the slot.
  let imageBytes: Buffer
  let contentType: string
  try {
    // The catch below refunds, but nothing was ever cancelling this: a CDN that
    // accepts the connection and then drips bytes keeps `arrayBuffer()` pending
    // forever, so the refund never runs and a free-tier user loses 1 of 3
    // monthly generations with no image and no error. The deadline is what
    // turns that hang into the refund path that already exists.
    const imageRes = await fetch(outputUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!imageRes.ok) {
      await refund()
      return NextResponse.json({ error: 'Failed to download generated image' }, { status: 500 })
    }
    imageBytes = Buffer.from(await imageRes.arrayBuffer())
    contentType = imageRes.headers.get('content-type') ?? 'image/jpeg'
  } catch (err) {
    await refund()
    console.error('[generate-artwork] image download failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to download generated image. Please try again.' }, { status: 502 })
  }

  // Film finish: grain, soft vignette, slightly muted palette. Best-effort —
  // the generation is already paid for, so a decode failure here must never
  // turn a successful prediction into an error; the untouched bytes are saved
  // instead and the response says so.
  let finishApplied = false
  if (finish === 'film') {
    try {
      // Seed from the storage timestamp-ish so each generation's grain differs
      // but any given output is reproducible from its inputs.
      imageBytes = await applyFilmFinish(imageBytes, { seed: (Date.now() % 2147483647) >>> 0 })
      contentType = 'image/jpeg'
      finishApplied = true
    } catch (err) {
      console.error('[generate-artwork] film finish failed, saving untouched bytes:', err instanceof Error ? err.message : err)
    }
  }

  const extension = contentType.includes('webp') ? 'webp'
    : contentType.includes('png') ? 'png'
    : 'jpg'

  const filename = `${isCollection ? `covers/${targetId}` : targetId}/ai-${Date.now()}.${extension}`
  // supabaseAdmin (service role) — see the twin comment in
  // /api/finalize-artwork. This route used the ANON-key SSR client until
  // 2026-08-21; migration 029 narrowing the mf-artwork INSERT policy to
  // `authenticated` turned that into a hard RLS denial. The failure mode here
  // was the more expensive of the two: Replicate is billed BEFORE this upload,
  // so every attempt and every retry spent real money and then 500'd.
  const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
    .from('mf-artwork')
    .upload(filename, imageBytes, { contentType, upsert: false })

  if (uploadError) {
    // Don't hand back the raw Replicate URL as a fallback: it expires within
    // ~1 hour and is never persisted (the DB write below only runs on success),
    // so the client would show artwork that 404s on the next reload. Fail loudly
    // so the user retries instead of saving a dead link.
    await refund()
    console.error('[generate-artwork] Supabase upload error:', uploadError.message)
    return NextResponse.json({ error: 'Failed to save generated image. Please try again.' }, { status: 500 })
  }

  const { data: urlData } = supabaseAdmin.storage.from('mf-artwork').getPublicUrl(uploadData.path)
  const artworkUrl = urlData.publicUrl

  // Persist the URL. For a collection we just set its cover; for a project we
  // set the new source artwork and drop any prior finalized render so the next
  // Finalize pass starts from this fresh source instead of stacking on stale output.
  const { error: dbError } = isCollection
    ? await supabaseAdmin
        .from('mb_collections')
        .update({ cover_url: artworkUrl, updated_at: new Date().toISOString() })
        .eq('id', targetId)
        .eq('user_id', userId)
    : await supabaseAdmin
        .from('mb_projects')
        .update({
          artwork_url: artworkUrl,
          finalized_artwork_url: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', targetId)
        .eq('user_id', userId) // defense-in-depth: scope the write to the owner
  if (dbError) {
    // The image uploaded fine but the URL didn't persist — the next page load
    // would show stale artwork. Hand the reserved slot back and fail loudly so
    // the user retries instead of silently losing a paid generation. Mirrors
    // every other failure path above and finalize-artwork's dbError handling.
    await refund()
    console.error('[generate-artwork] DB update error:', dbError.message)
    return NextResponse.json({ error: 'Saved image but failed to update project. Please retry.' }, { status: 500 })
  }

  return NextResponse.json({
    artwork_url: artworkUrl,
    look,
    prompt_used: finalPrompt,
    model: modelKey,
    finish: finishApplied ? 'film' : 'none',
  })
}
