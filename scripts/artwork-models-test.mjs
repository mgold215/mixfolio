#!/usr/bin/env node
// Contract test for the artwork-generation model registry, resolver and prompt
// composer (src/lib/artwork-models.ts).
//
// Two things are locked here:
//
// 1. Crash-proof model selection. The route reserves a monthly artwork slot
//    BEFORE the paid Replicate call, then selects the model endpoint + input
//    builder from a client-supplied `model` string. The old selection —
//    `MODEL_ENDPOINTS[model] ?? MODEL_ENDPOINTS.flux` — looked safe but a
//    crafted `model` naming an inherited Object.prototype member resolves
//    TRUTHY, so `??` never falls back; the route then threw AFTER the slot was
//    reserved and off any refund path, silently BURNING quota. resolveModelKey
//    closes this with an own-property gate. A "witness" assert reproduces the
//    old pattern and proves it WOULD have crashed.
//
// 2. The realism contract. The artwork must pass as a real photograph. The
//    composer strips AI-art vocabulary ("8k", "hyper-realistic", "surreal"),
//    appends a documentary-photography treatment, phrases constraints
//    positively for diffusion models and as instructions for the Gemini-based
//    ones, and the vary pools must never smuggle hype words, people or signage
//    back in.
//
// Runs on Node 22 native TS type-stripping, same as the other renderer tests.
// Run: node scripts/artwork-models-test.mjs  (also part of `npm run test:renderers`)

import {
  MODEL_ENDPOINTS,
  MODEL_INPUTS,
  MODEL_INPUTS_MINIMAL,
  IMAGE_MODELS,
  resolveModelKey,
  isInstructionModel,
  composeLook,
  composeConstraints,
  composePrompt,
  softenPrompt,
  HYPE_RE,
  PEOPLE_RE,
  DEFAULT_MODEL,
  LOOK_VANTAGE,
  LOOK_LIGHT,
  LOOK_WEATHER,
  LOOK_MOOD,
} from '../src/lib/artwork-models.ts'

let failures = 0
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

// HYPE_RE is a /g regex (softenPrompt uses it with replace); a /g regex's
// .test() is stateful across calls, so every membership check here goes
// through a stateless copy.
const hype = new RegExp(HYPE_RE.source, 'i')
const hasHype = s => hype.test(s)

console.log('artwork-models: registry integrity')

const KEYS = Object.keys(MODEL_ENDPOINTS)
check('6 models registered', KEYS.length === 6, `${KEYS.length}`)
check('default model is a real key', KEYS.includes(DEFAULT_MODEL), DEFAULT_MODEL)
check('default model is the most photographic one (FLUX Ultra raw)', DEFAULT_MODEL === 'flux-ultra', DEFAULT_MODEL)
check(
  'endpoints and inputs have identical key sets',
  KEYS.length === Object.keys(MODEL_INPUTS).length && KEYS.every(k => k in MODEL_INPUTS),
)
check(
  'endpoints and MINIMAL inputs have identical key sets',
  KEYS.length === Object.keys(MODEL_INPUTS_MINIMAL).length && KEYS.every(k => k in MODEL_INPUTS_MINIMAL),
)
check(
  'every endpoint is an https Replicate URL',
  KEYS.every(k => typeof MODEL_ENDPOINTS[k] === 'string'
    && MODEL_ENDPOINTS[k].startsWith('https://api.replicate.com/')),
)
check(
  'every input builder returns an object carrying the prompt',
  KEYS.every(k => {
    const out = MODEL_INPUTS[k]('the-prompt')
    return out && typeof out === 'object' && out.prompt === 'the-prompt'
  }),
)
check(
  'every minimal input builder returns an object carrying the prompt',
  KEYS.every(k => {
    const out = MODEL_INPUTS_MINIMAL[k]('the-prompt')
    return out && typeof out === 'object' && out.prompt === 'the-prompt'
  }),
)
check(
  'minimal inputs are a strict subset of the tuned inputs (only ever REMOVE knobs on fallback)',
  KEYS.every(k => {
    const full = MODEL_INPUTS[k]('p'), min = MODEL_INPUTS_MINIMAL[k]('p')
    return Object.keys(min).every(f => f in full && JSON.stringify(full[f]) === JSON.stringify(min[f]))
      && Object.keys(min).length <= Object.keys(full).length
  }),
)
check('every model generates square (1:1) artwork',
  KEYS.every(k => MODEL_INPUTS[k]('p').aspect_ratio === '1:1'))

console.log('\nartwork-models: realism knobs per model')

check('flux-ultra runs BFL raw mode (natural, less synthetic aesthetic)', MODEL_INPUTS['flux-ultra']('p').raw === true)
check('flux-ultra minimal fallback keeps raw mode (it IS the point of the model)', MODEL_INPUTS_MINIMAL['flux-ultra']('p').raw === true)
check('flux-krea is in the lineup (the BFL × Krea model built to remove the AI look)',
  /black-forest-labs\/flux-krea-dev/.test(MODEL_ENDPOINTS['flux-krea']))
{
  const krea = MODEL_INPUTS['flux-krea']('p')
  check('flux-krea guidance within Krea\'s recommended 3.5–5.0', krea.guidance >= 3.5 && krea.guidance <= 5, `${krea.guidance}`)
  check('flux-krea steps within Krea\'s recommended 28–32', krea.num_inference_steps >= 28 && krea.num_inference_steps <= 32, `${krea.num_inference_steps}`)
  check('flux-krea runs the bf16 weights (go_fast off)', krea.go_fast === false)
}
check('nano-pro renders at 2K', MODEL_INPUTS['nano-pro']('p').resolution === '2K')
check('recraft (illustration-first) is no longer in the lineup', !KEYS.includes('recraft'))

console.log('\nartwork-models: resolveModelKey — crash-proof selection')

// Witness: reproduce the OLD vulnerable selection and prove it broke.
const oldEndpoint = m => MODEL_ENDPOINTS[m] ?? MODEL_ENDPOINTS.flux
const oldInputFn  = m => MODEL_INPUTS[m] ?? MODEL_INPUTS.flux
check('WITNESS: old pattern picked a non-URL endpoint for "__proto__" (the bug)', typeof oldEndpoint('__proto__') !== 'string')
check('WITNESS: old pattern picked a non-function input for "__proto__" (the bug)', typeof oldInputFn('__proto__') !== 'function')

for (const k of KEYS) check(`valid key "${k}" resolves to itself`, resolveModelKey(k) === k)
for (const bad of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'prototype']) {
  check(`crafted "${bad}" resolves to ${DEFAULT_MODEL}`, resolveModelKey(bad) === DEFAULT_MODEL)
}
for (const junk of ['bogus', '', 'FLUX', ' flux ']) {
  check(`unknown string ${JSON.stringify(junk)} → ${DEFAULT_MODEL}`, resolveModelKey(junk) === DEFAULT_MODEL)
}
for (const junk of [null, undefined, 123, {}, [], true]) {
  check(`non-string ${JSON.stringify(junk) ?? String(junk)} → ${DEFAULT_MODEL}`, resolveModelKey(junk) === DEFAULT_MODEL)
}
check(
  'resolved key is always usable (endpoint URL + callable input) for hostile inputs',
  ['__proto__', 'constructor', 'toString', 'bogus', '', null, undefined, 42].every(m => {
    const key = resolveModelKey(m)
    const ep = MODEL_ENDPOINTS[key]
    const fn = MODEL_INPUTS[key]
    return typeof ep === 'string' && ep.startsWith('https://') && typeof fn === 'function' && fn('p').prompt === 'p'
  }),
)

console.log('\nartwork-models: IMAGE_MODELS UI list stays 1:1 with the registry')

const uiIds = IMAGE_MODELS.map(m => m.id)
check('one UI entry per registered model', IMAGE_MODELS.length === KEYS.length, `${IMAGE_MODELS.length} vs ${KEYS.length}`)
check('every UI id is a real registry key', uiIds.every(id => KEYS.includes(id)), uiIds.join(','))
check('every registry key has exactly one UI entry (no drift)', KEYS.every(k => uiIds.filter(id => id === k).length === 1))
check('UI ids are unique', new Set(uiIds).size === uiIds.length)
check('every UI entry has a non-empty label', IMAGE_MODELS.every(m => typeof m.label === 'string' && m.label.trim().length > 0))
check('resolveModelKey accepts every UI id unchanged (selector can never burn quota)', IMAGE_MODELS.every(m => resolveModelKey(m.id) === m.id))
check('the selectors open on the default model', IMAGE_MODELS[0].id === DEFAULT_MODEL)

console.log('\nartwork-models: dead-model guard')

// Google retired every Imagen 4 API endpoint on 2026-08-17; Recraft was
// dropped for realism. Stale client ids must degrade to the default, not crash.
check('no endpoint routes to retired google/imagen models',
  KEYS.every(k => !/\/google\/imagen/.test(MODEL_ENDPOINTS[k])),
  KEYS.map(k => MODEL_ENDPOINTS[k]).join('\n'))
for (const stale of ['imagen', 'imagen-ultra', 'recraft']) {
  check(`stale client id "${stale}" degrades to ${DEFAULT_MODEL}`, resolveModelKey(stale) === DEFAULT_MODEL)
}

console.log('\nartwork-models: composeLook')

const VALID_LOOKS = new Set()
for (const v of LOOK_VANTAGE) for (const l of LOOK_LIGHT) for (const w of LOOK_WEATHER) for (const m of LOOK_MOOD)
  VALID_LOOKS.add([v, l, w, m].join(', '))
const expected = LOOK_VANTAGE.length * LOOK_LIGHT.length * LOOK_WEATHER.length * LOOK_MOOD.length
check(`valid-look product is ${LOOK_VANTAGE.length}×${LOOK_LIGHT.length}×${LOOK_WEATHER.length}×${LOOK_MOOD.length}`, VALID_LOOKS.size === expected, `${VALID_LOOKS.size}`)
check('enough variety that repeat runs rarely collide (≥ 500 combinations)', VALID_LOOKS.size >= 500, `${VALID_LOOKS.size}`)

const look = composeLook()
check('composeLook returns a non-empty string', typeof look === 'string' && look.length > 0)
check('composeLook output is a valid vantage×light×weather×place combination', VALID_LOOKS.has(look), look)
check('200 runs all produce valid combinations', Array.from({ length: 200 }, composeLook).every(l => VALID_LOOKS.has(l)))

console.log('\nartwork-models: vary pools are written like a photographer, not an AI-art prompt')

const ALL_LOOKS = [...LOOK_VANTAGE, ...LOOK_LIGHT, ...LOOK_WEATHER, ...LOOK_MOOD]
check('no look phrase carries AI-art hype vocabulary (8k, hyper-, surreal, cinematic…)',
  ALL_LOOKS.every(s => !hasHype(s)), ALL_LOOKS.filter(hasHype).join(' | '))
check('no look phrase mentions people or figures',
  ALL_LOOKS.every(s => !PEOPLE_RE.test(s)), ALL_LOOKS.filter(s => PEOPLE_RE.test(s)).join(' | '))
check('no look phrase asks for signage, text, or lettering',
  ALL_LOOKS.every(s => !/\b(signage|text|lettering|billboard|typography|neon sign)\b/i.test(s)),
  ALL_LOOKS.filter(s => /\b(signage|text|lettering|billboard|typography|neon sign)\b/i.test(s)).join(' | '))
check('every camera phrase names real gear or film ("shot on" / "photographed")',
  LOOK_VANTAGE.every(s => /\b(shot on|photographed|medium-format)\b/i.test(s)), LOOK_VANTAGE.join(' | '))

console.log('\nartwork-models: softenPrompt — strips the words that make it look AI')

const HYPED = 'a cassette-shaped building, hyper-realistic, 8k, ultra detailed, masterpiece, trending on artstation, octane render, cinematic, surreal, photorealistic, looks like a real photo'
const softened = softenPrompt(HYPED)
check('all hype tokens removed', !hasHype(softened), softened)
check('the subject survives verbatim', softened.startsWith('a cassette-shaped building'), softened)
check('punctuation left by the deletions is tidied (no ", ,", no trailing comma)', !/,\s*,/.test(softened) && !/,\s*$/.test(softened), JSON.stringify(softened))
check('a clean prompt passes through untouched',
  softenPrompt('a cassette on a wooden table by a window, overcast light') === 'a cassette on a wooden table by a window, overcast light')
check('"4K" and "8K" are removed case-insensitively', !/\b[48]k\b/i.test(softenPrompt('city at night 4K 8K')))
check('an all-hype prompt collapses to empty rather than throwing', softenPrompt('8k masterpiece cinematic') === '')
check('does not maim ordinary words that merely contain a hype token ("epicentre", "surrealist" untouched)',
  softenPrompt('the epicentre of a surrealist gallery') === 'the epicentre of a surrealist gallery', softenPrompt('the epicentre of a surrealist gallery'))

console.log('\nartwork-models: composeConstraints — no baked-in text, no uninvited people')

for (const k of KEYS) {
  const c = composeConstraints('a giant retro cassette tape structure', k)
  check(`[${k}] text ban present`, /text|lettering/i.test(c), c)
  check(`[${k}] people constraint present when the prompt asks for none`, /people/i.test(c), c)
  for (const asked of ['portrait of a dancer', 'a woman on a rooftop', 'crowd at a festival', 'the artist silhouette']) {
    const cc = composeConstraints(asked, k)
    check(`[${k}] "${asked}" keeps its people (no contradictory rider)`, !/people|human/i.test(cc), cc)
  }
}
check('diffusion models get POSITIVE framing ("deserted"), not only negation',
  /deserted/.test(composeConstraints('a building', 'flux-ultra')) && /plain and unmarked/.test(composeConstraints('a building', 'flux-krea')))
check('instruction models get an explicit "Do not include" instruction',
  /^Do not include/.test(composeConstraints('a building', 'nano-pro')) && /^Do not include/.test(composeConstraints('a building', 'nano')))
check('isInstructionModel is exactly the Nano Banana pair',
  KEYS.filter(isInstructionModel).sort().join(',') === 'nano,nano-pro')

console.log('\nartwork-models: composePrompt — what actually gets sent')

const SUBJECT = 'a giant cassette-shaped concrete building beside a motorway'
for (const k of KEYS) {
  const withLook = composePrompt({ userPrompt: SUBJECT, modelKey: k, look: LOOK_VANTAGE[0] })
  const noLook = composePrompt({ userPrompt: SUBJECT, modelKey: k, look: null })
  check(`[${k}] the artist's subject leads the prompt`, withLook.replace(/^Photograph: /, '').startsWith(SUBJECT), withLook.slice(0, 80))
  check(`[${k}] the vary look is included when given`, withLook.includes(LOOK_VANTAGE[0]))
  check(`[${k}] a camera is still named when vary is off`, /shot on|real camera/i.test(noLook), noLook)
  check(`[${k}] carries the documentary-photograph treatment`, /documentary photograph/i.test(withLook), withLook)
  check(`[${k}] mentions natural light and real-world imperfection`, /natural available light/i.test(withLook) && /imperfections|wear/i.test(withLook))
  check(`[${k}] constraints ride LAST`, withLook.trimEnd().endsWith(composeConstraints(SUBJECT, k)), withLook.slice(-80))
  check(`[${k}] composed prompt carries no hype vocabulary`, !hasHype(withLook), withLook)
  check(`[${k}] hype in the artist's prompt is stripped before sending`,
    !hasHype(composePrompt({ userPrompt: `${SUBJECT}, 8k, hyper-realistic, cinematic`, modelKey: k, look: null })))
}
check('instruction-model prompt reads as a brief (sentences, "must not look like" a render)',
  /Photograph: .*\. .*must not look like digital art/.test(composePrompt({ userPrompt: SUBJECT, modelKey: 'nano-pro', look: null })))
check('diffusion prompt is comma-separated descriptors with no instruction sentences',
  !/Do not include|must not/.test(composePrompt({ userPrompt: SUBJECT, modelKey: 'flux-ultra', look: null })))
check('a people request survives end-to-end on a diffusion model',
  !/empty of people/.test(composePrompt({ userPrompt: 'portrait of a singer in a stairwell', modelKey: 'flux-ultra', look: null })))
check('a people request survives end-to-end on an instruction model',
  !/human figures/.test(composePrompt({ userPrompt: 'portrait of a singer in a stairwell', modelKey: 'nano-pro', look: null })))

console.log(failures === 0 ? '\nAll artwork-models tests passed' : `\n${failures} artwork-models test(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
