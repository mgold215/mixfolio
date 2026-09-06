// Artwork-generation model registry + prompt composer.
//
// Extracted from src/app/api/generate-artwork/route.ts so the model-key
// resolution and prompt composition are pure and unit-testable off the server
// route (scripts/artwork-models-test.mjs). No server-only imports live here —
// keep it that way so the test can import it under Node type-stripping.
//
// THE GOAL OF EVERYTHING IN THIS FILE IS A PICTURE THAT PASSES AS A REAL PHOTO.
// The artist's music is not AI-made and the artwork must not read as AI-made
// either. Three levers, all applied server-side so every client (web, iOS)
// gets them for free:
//
//   1. Model lineup — only models with a documented natural-photography mode
//      (FLUX 1.1 Ultra `raw`, FLUX Krea, Nano Banana Pro, Seedream 4, FLUX 2 Pro,
//      Nano Banana 2). Recraft V3 was dropped: it is an illustration-first
//      model whose "realistic" style still carries the glossy render look.
//   2. Prompt language — a real photographer describes camera, lens, light and
//      mundane detail; they never say "8k hyper-detailed masterpiece". Those
//      hype tokens are exactly what pull a model toward the CGI/"AI art" mode
//      of its training data, so composePrompt strips them and appends a
//      documentary-photography treatment instead. Constraints are phrased
//      POSITIVELY ("deserted street") for the diffusion models, which do not
//      reliably understand "no X"; the Gemini-based Nano Banana family follows
//      plain instructions, so it gets an instruction block.
//   3. Film finish — src/lib/film-finish.ts adds grain, a soft vignette and a
//      slightly muted palette after generation. Spotless, noise-free pixels
//      are the single biggest "this is AI" tell.

// The Google slots run the Nano Banana (Gemini image) family — NOT Imagen.
// Google retired every Imagen 4 API endpoint on 2026-08-17
// (imagen-4.0-{generate,ultra-generate,fast-generate}-001), so Replicate's
// google/imagen-4[-ultra] wrappers hard-404 out of Vertex for every caller.
// Stale clients that still send 'imagen'/'imagen-ultra'/'recraft' collapse to
// the default via resolveModelKey — no crash, no burned quota.
//
// `satisfies` (not a `Record<string, string>` annotation) keeps the literal keys
// so `keyof typeof MODEL_ENDPOINTS` is the real id union, not `string` — that's
// what lets IMAGE_MODELS and resolveModelKey be checked against the registry at
// compile time instead of only at runtime.
export const MODEL_ENDPOINTS = {
  'flux-ultra': 'https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro-ultra/predictions',
  'nano-pro':   'https://api.replicate.com/v1/models/google/nano-banana-pro/predictions',
  'flux-krea':  'https://api.replicate.com/v1/models/black-forest-labs/flux-krea-dev/predictions',
  seedream:     'https://api.replicate.com/v1/models/bytedance/seedream-4/predictions',
  flux:         'https://api.replicate.com/v1/models/black-forest-labs/flux-2-pro/predictions',
  nano:         'https://api.replicate.com/v1/models/google/nano-banana-2/predictions',
} satisfies Record<string, string>

// The registry's real ids as a literal union. Everything model-keyed downstream
// (the resolver's return type, the UI list) is checked against this.
export type ModelKey = keyof typeof MODEL_ENDPOINTS

// Per-model inputs, tuned for photographic output:
//  - flux-ultra: `raw: true` is BFL's documented "less synthetic, more natural
//    aesthetic" mode — candid-photography look, natural imperfections kept.
//  - flux-krea: FLUX.1 Krea [dev], the BFL × Krea model built specifically to
//    remove the "AI look". Krea's recommended settings are 28–32 steps and
//    guidance 3.5–5.0; lower guidance reads more natural, so 4.0. `go_fast`
//    off keeps the bf16 weights (the fp8 path is non-deterministic and softer).
//  - nano-pro / nano: minimal documented core schema on purpose — Replicate
//    422s unknown properties. jpg output because Google's own docs recommend
//    it for photographic images.
//  - seedream: 2K, the model's native photographic resolution.
//  - flux: FLUX 2 Pro, highest-fidelity general model of the set.
export const MODEL_INPUTS = {
  'flux-ultra': (prompt: string) => ({ prompt, aspect_ratio: '1:1', raw: true, output_format: 'jpg' }),
  'nano-pro':   (prompt: string) => ({ prompt, aspect_ratio: '1:1', resolution: '2K', output_format: 'jpg' }),
  'flux-krea':  (prompt: string) => ({ prompt, aspect_ratio: '1:1', guidance: 4, num_inference_steps: 30, go_fast: false, output_format: 'jpg', output_quality: 95 }),
  seedream:     (prompt: string) => ({ prompt, aspect_ratio: '1:1', size: '2K' }),
  flux:         (prompt: string) => ({ prompt, aspect_ratio: '1:1', output_format: 'jpg', output_quality: 95 }),
  nano:         (prompt: string) => ({ prompt, aspect_ratio: '1:1', output_format: 'jpg' }),
} satisfies Record<ModelKey, (prompt: string) => Record<string, unknown>>

// Bare-minimum inputs, used by the route ONLY if Replicate rejects the tuned
// input above with a 422 (schema validation). Provider schemas move without
// notice — a renamed or removed optional field must degrade to a plain
// generation, never to a hard error on a call the user has already paid a
// quota slot for. Every entry is the documented core (`prompt` + aspect).
export const MODEL_INPUTS_MINIMAL = {
  'flux-ultra': (prompt: string) => ({ prompt, aspect_ratio: '1:1', raw: true }),
  'nano-pro':   (prompt: string) => ({ prompt, aspect_ratio: '1:1' }),
  'flux-krea':  (prompt: string) => ({ prompt, aspect_ratio: '1:1' }),
  seedream:     (prompt: string) => ({ prompt, aspect_ratio: '1:1' }),
  flux:         (prompt: string) => ({ prompt, aspect_ratio: '1:1' }),
  nano:         (prompt: string) => ({ prompt, aspect_ratio: '1:1' }),
} satisfies Record<ModelKey, (prompt: string) => Record<string, unknown>>

// Default model when the caller sends nothing (or something unusable). The
// most photographic model in the lineup, and the same one the UI selectors
// open on (IMAGE_MODELS[0]) so a stale or missing id lands on the best choice.
export const DEFAULT_MODEL: ModelKey = 'flux-ultra'

/**
 * Resolve a client-supplied `model` value to a real registry key.
 *
 * Why not just `MODEL_ENDPOINTS[model] ?? MODEL_ENDPOINTS.flux`: a hand-crafted
 * request naming an INHERITED Object.prototype member — `__proto__`,
 * `constructor`, `toString`, `valueOf`, `hasOwnProperty` — makes that lookup
 * resolve to a TRUTHY value (the prototype object / a built-in function), so the
 * `??` fallback never fires. The route would then call `inputFn(prompt)` on a
 * non-function (or `fetch()` a non-URL endpoint) and throw — a 500 that lands
 * AFTER the monthly artwork slot was reserved and is NOT on a refund path, so it
 * silently burns the user's quota. An own-property gate lets only the six real
 * keys through; everything else (crafted names, unknown strings, non-strings)
 * collapses to the default, keeping endpoint + input paired and the route crash-free.
 */
export function resolveModelKey(model: unknown): ModelKey {
  return typeof model === 'string' && Object.prototype.hasOwnProperty.call(MODEL_ENDPOINTS, model)
    ? (model as ModelKey)
    : DEFAULT_MODEL
}

// UI-facing model list — the single source for every client model selector
// (the Artwork tab + the collection cover picker) so they can't drift from the
// endpoint/input registry. `satisfies` proves each id is a real ModelKey at
// compile time (a typo or a removed model fails the build); the runtime contract
// test additionally proves the list stays 1:1 with the registry. The first
// entry is the selectors' default — ordered most-photographic-first.
export const IMAGE_MODELS = [
  { id: 'flux-ultra', label: 'FLUX Ultra Raw' },
  { id: 'nano-pro',   label: 'Nano Banana Pro' },
  { id: 'flux-krea',  label: 'FLUX Krea' },
  { id: 'seedream',   label: 'Seedream 4' },
  { id: 'flux',       label: 'Flux 2 Pro' },
  { id: 'nano',       label: 'Nano Banana 2' },
] satisfies { id: ModelKey; label: string }[]

// The Gemini-based models take plain-English instructions (and honour "do not
// include…"); the diffusion models take photographer's descriptions.
export function isInstructionModel(key: ModelKey): boolean {
  return key === 'nano-pro' || key === 'nano'
}

// ---------------------------------------------------------------------------
// Vary: a randomized photographic treatment, appended when the client asks to
// vary the look. One pick per axis — camera × light × weather × place — so
// consecutive generations of the same subject land on visibly different
// photographs instead of the model's single house style.
//
// Every phrase is something a working photographer would actually write in a
// caption. None of them contain render/CGI vocabulary ("8k", "razor-sharp",
// "extreme detail", "surreal", "dystopian") — those pull the model toward
// concept art. The contract test greps the pools for HYPE_RE and PEOPLE_RE.
// ---------------------------------------------------------------------------
export const LOOK_VANTAGE = [
  'shot on 35mm film, Kodak Portra 400, soft natural grain',
  'shot on a Fujifilm X-T4 with a 23mm lens, handheld',
  'shot on a Canon 5D Mark IV with a 24-70mm lens at f/8',
  'shot on expired Fujicolor Superia 200, slightly faded colors',
  'shot on a disposable camera, small flash falloff, slight softness',
  'photographed from a parked car across the street, 50mm lens',
  'medium-format Pentax 67 on Kodak Ektar 100, tripod, level horizon',
  'photographed from a neighbouring rooftop with a 135mm lens, compressed perspective',
]
export const LOOK_LIGHT = [
  'overcast afternoon, flat soft daylight, no hard shadows',
  'late golden hour, long warm shadows across the ground',
  'harsh midday sun, deep shadows, slightly blown-out sky',
  'blue hour just after sunset, a few windows lit, sodium streetlights coming on',
  'early morning, low sun raking across the facade',
  'grey winter light, everything a little washed out',
  'night, lit only by a few orange streetlights, wet ground reflecting them',
]
export const LOOK_WEATHER = [
  'thin fog softening the distance',
  'light drizzle, wet asphalt, puddles',
  'hazy summer air',
  'clear dry air after rain',
  'low heavy cloud',
  'a few scattered clouds, mild breeze',
]
// Ordinary surroundings are what sell the photo. A megastructure floating in a
// void reads as concept art; the same building behind a chain-link fence with
// a dumpster next to it reads as a Tuesday.
export const LOOK_MOOD = [
  'an ordinary quiet industrial estate, chain-link fence, a parked delivery van, weeds along the kerb',
  'a deserted suburban car park in the foreground, faded parking lines, a single shopping trolley',
  'the far end of an empty commuter parking lot, power lines and a bus stop in frame',
  'abandoned for years, weeds through the tarmac, water stains down the concrete, tagged with faded graffiti',
  'weekday afternoon with nobody around, a few parked cars, road signs, bins, ordinary street furniture',
  'photographed from a motorway overpass, crash barrier in the foreground, traffic cones',
]

export function composeLook(): string {
  const pick = (pool: string[]) => pool[Math.floor(Math.random() * pool.length)]
  return [pick(LOOK_VANTAGE), pick(LOOK_LIGHT), pick(LOOK_WEATHER), pick(LOOK_MOOD)].join(', ')
}

// ---------------------------------------------------------------------------
// De-hype: the vocabulary that makes an image look AI-generated.
//
// These tokens are the house style of AI-art prompt sites, so in every model's
// training data they co-occur with the glossy, over-lit, over-sharpened render
// aesthetic — asking for "8k hyper-detailed masterpiece" is asking for exactly
// the look we're trying to escape. Photographers never write them, so they
// are removed from the artist's prompt. Exported so the contract test can
// prove the vary pools stay clean.
// ---------------------------------------------------------------------------
export const HYPE_RE = /\b(?:hyper[- ]?realistic|ultra[- ]?realistic|hyper[- ]?real|photo[- ]?realistic|photoreal|hyper[- ]?detailed|ultra[- ]?detailed|highly[- ]detailed|insanely[- ]detailed|extreme(?:ly)?[- ]detail(?:ed)?|intricate[- ]detail(?:s|ed)?|razor[- ]sharp|8k|4k|16k|uhd|hdr|masterpiece|trending on artstation|artstation|octane(?: render)?|unreal engine|ray[- ]?trac(?:ed|ing)|cgi|3d render(?:ed|ing)?|cinematic|epic|surreal|dystopian|uncanny|unsettling|breathtaking|stunning|award[- ]winning|dramatic lighting|volumetric(?: lighting| light)?|god rays|looks like a real photo)\b/gi

/**
 * Strip AI-art vocabulary from an artist's prompt and tidy the punctuation the
 * deletions leave behind. "Photorealistic" and friends are deleted rather than
 * rewritten: every composed prompt already carries the documentary-photograph
 * treatment, so the intent survives without the trigger word. Nothing else is
 * touched — the subject, colours, place and mood are the artist's words and
 * stay verbatim.
 */
export function softenPrompt(userPrompt: string): string {
  return userPrompt
    .replace(HYPE_RE, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*(?:,\s*)+/g, ', ')   // ", , ," → ", "
    .replace(/,\s*(?=[.!?]|$)/g, '')      // trailing comma before a period / end
    .replace(/^[\s,.;]+/, '')             // leading punctuation
    .replace(/\(\s*\)/g, '')              // emptied parentheses
    .replace(/\s+([,.;:!?])/g, '$1')      // space before punctuation
    .replace(/\s+/g, ' ')
    .trim()
}

// Words that mean the artist ASKED for a person — the no-people guard must
// never fight an explicit request.
export const PEOPLE_RE = /\b(people|person|man|men|woman|women|girl|boy|kid|child|children|face|faces|portrait|crowd|figure|figures|silhouette|silhouettes|dancer|dancers|artist|band|dj|singer|musician|model|couple|hand|hands|body)\b/i

// The photographic treatment that every generation carries. Deliberately
// mundane: a real photo has a camera, natural light, a slightly imperfect
// exposure, and real-world clutter. Nothing here names a lens or a time of
// day, so it never fights a vary look (which owns those axes).
const REALISM_DIFFUSION =
  'candid documentary photograph, natural available light, true-to-life muted colours, straight-out-of-camera with no retouching, subtle sensor noise, slight lens vignetting, real-world wear and small imperfections, everyday surroundings'

// Used only when the vary look is off, so a plain prompt still gets a camera.
const REALISM_DIFFUSION_CAMERA = 'shot on a full-frame DSLR with a 35mm lens'

// Instruction block for the Gemini-based models: they read this as a brief,
// not as tags, so it is written as one.
const REALISM_INSTRUCTION =
  'Render this as an authentic, unretouched photograph taken by a documentary photographer: a real camera, natural available light, true-to-life muted colours, subtle sensor noise, slight lens vignetting, real-world wear and ordinary surroundings. It must not look like digital art, concept art, computer graphics or an illustration.'

/**
 * Hard constraints appended to EVERY generation prompt, after any vary-look.
 *
 * The text clause is unconditional: the title/artist lockup is rendered later
 * by /api/finalize-artwork, so any lettering the model bakes into the pixels
 * is wrong by construction. The people clause applies only when the artist's
 * own prompt doesn't mention anyone — asking for "a portrait of a dancer"
 * must not carry a contradictory "no people" rider.
 *
 * Phrasing differs by model family. Diffusion models (FLUX, Seedream) do not
 * reliably parse negation — "no cars" can put cars in the frame — so they are
 * told what IS there ("deserted", "plain unmarked surfaces"), with a terse
 * "no text" tail that FLUX's text encoder does treat as a weak signal. The
 * Gemini-based Nano Banana models follow explicit instructions, so they get
 * the direct "Do not include…" form.
 */
export function composeConstraints(userPrompt: string, modelKey: ModelKey = DEFAULT_MODEL): string {
  const wantsPeople = PEOPLE_RE.test(userPrompt)
  if (isInstructionModel(modelKey)) {
    const items = ['any text, lettering, typography, logos or watermarks']
    if (!wantsPeople) items.push('any people or human figures')
    return `Do not include ${items.join(', and do not include ')}.`
  }
  const parts = ['every surface plain and unmarked, no text, no lettering, no logos, no watermark']
  if (!wantsPeople) parts.push('the scene is completely deserted, empty of people')
  return parts.join(', ')
}

export type ComposeOptions = {
  userPrompt: string
  modelKey: ModelKey
  /** Vary-look string from composeLook(), or null when the client turned it off. */
  look: string | null
}

/**
 * Build the prompt actually sent to the model.
 *
 * Order matters to diffusion models (earlier = more weight): the artist's
 * subject first, then the look/camera, then the realism treatment, then the
 * constraints. For the instruction models the same content is written as a
 * brief with the constraints as a closing instruction.
 */
export function composePrompt({ userPrompt, modelKey, look }: ComposeOptions): string {
  const subject = softenPrompt(userPrompt)
  const constraints = composeConstraints(userPrompt, modelKey)
  if (isInstructionModel(modelKey)) {
    return [
      `Photograph: ${subject}.`,
      look ? `Shooting conditions: ${look}.` : null,
      REALISM_INSTRUCTION,
      constraints,
    ].filter(Boolean).join(' ')
  }
  return [
    subject,
    look ?? REALISM_DIFFUSION_CAMERA,
    REALISM_DIFFUSION,
    constraints,
  ].join(', ')
}
