#!/usr/bin/env node
// Contract test for the film finish (src/lib/film-finish.ts) — the
// post-generation pass that adds grain, a soft vignette and a slightly muted
// palette so generated artwork stops reading as spotless AI output.
//
// Drives the real sharp pipeline on synthetic images so the assertions are
// about pixels, not mocks: the output must be a JPEG of the same size, the
// centre must keep its exposure, the corners must darken (vignette), the flat
// field must gain noise (grain) that is heavier in shadows than highlights,
// and the whole thing must be deterministic per seed.
//
// Runs on Node 22 native TS type-stripping, same as the other renderer tests.
// Run: node scripts/film-finish-test.mjs  (also part of `npm run test:renderers`)

import sharp from 'sharp'
import { applyFilmFinish } from '../src/lib/film-finish.ts'

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`)
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}

const flat = (w, h, v, fmt = 'png') =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: v, g: v, b: v } } })[fmt]().toBuffer()

// Mean + standard deviation of the luma of a region, straight from raw pixels.
async function stats(buf, region) {
  const img = sharp(buf)
  const { data, info } = await (region ? img.extract(region) : img).raw().toBuffer({ resolveWithObject: true })
  let sum = 0, sum2 = 0
  const n = info.width * info.height
  for (let i = 0; i < data.length; i += info.channels) {
    const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    sum += l; sum2 += l * l
  }
  const mean = sum / n
  return { mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)) }
}

console.log('film-finish: output shape')

const SIZE = 512
const mid = await flat(SIZE, SIZE, 128)
const out = await applyFilmFinish(mid, { seed: 42 })
const meta = await sharp(out).metadata()
check('output is JPEG (magic bytes FF D8)', out[0] === 0xff && out[1] === 0xd8)
check('sharp reads it back as jpeg', meta.format === 'jpeg', meta.format)
check('dimensions preserved', meta.width === SIZE && meta.height === SIZE, `${meta.width}x${meta.height}`)

console.log('\nfilm-finish: vignette')

const patch = 48
const centre = await stats(out, { left: SIZE / 2 - patch / 2, top: SIZE / 2 - patch / 2, width: patch, height: patch })
const corner = await stats(out, { left: 0, top: 0, width: patch, height: patch })
check('centre exposure is held (within 3 levels of the 128 input)', Math.abs(centre.mean - 128) < 3, centre.mean.toFixed(2))
check('corners are darker than the centre', corner.mean < centre.mean - 4, `${corner.mean.toFixed(1)} vs ${centre.mean.toFixed(1)}`)
check('…but only gently (corner keeps ≥ 80% of centre brightness)', corner.mean > centre.mean * 0.8, (corner.mean / centre.mean).toFixed(3))

console.log('\nfilm-finish: grain')

const flatIn = await stats(mid, { left: 200, top: 200, width: patch, height: patch })
check('input flat field has ~zero noise (sanity)', flatIn.std < 0.5, flatIn.std.toFixed(3))
check('centre gains visible grain (std > 2 levels)', centre.std > 2, centre.std.toFixed(2))
check('…without becoming noisy (std < 14 levels)', centre.std < 14, centre.std.toFixed(2))

// Film response: shadows carry more grain than highlights.
const dark = await applyFilmFinish(await flat(SIZE, SIZE, 40), { seed: 42 })
const light = await applyFilmFinish(await flat(SIZE, SIZE, 225), { seed: 42 })
const darkC = await stats(dark, { left: SIZE / 2 - patch / 2, top: SIZE / 2 - patch / 2, width: patch, height: patch })
const lightC = await stats(light, { left: SIZE / 2 - patch / 2, top: SIZE / 2 - patch / 2, width: patch, height: patch })
check('shadows carry more grain than highlights', darkC.std > lightC.std * 1.3, `${darkC.std.toFixed(2)} vs ${lightC.std.toFixed(2)}`)

// grain: 0 must produce a clean field (only the vignette + jpeg remain).
const noGrain = await applyFilmFinish(mid, { seed: 42, grain: 0 })
const noGrainC = await stats(noGrain, { left: SIZE / 2 - patch / 2, top: SIZE / 2 - patch / 2, width: patch, height: patch })
check('grain: 0 leaves the centre clean', noGrainC.std < 1, noGrainC.std.toFixed(3))

console.log('\nfilm-finish: determinism')

const again = await applyFilmFinish(mid, { seed: 42 })
check('same seed → identical bytes', again.equals(out))
const other = await applyFilmFinish(mid, { seed: 43 })
check('different seed → different bytes', !other.equals(out))

console.log('\nfilm-finish: inputs it must survive')

const webp = await flat(300, 200, 128, 'webp')
const fromWebp = await applyFilmFinish(webp, { seed: 1 })
const wm = await sharp(fromWebp).metadata()
check('webp input (FLUX 2 Pro output format) → same-size jpeg', wm.format === 'jpeg' && wm.width === 300 && wm.height === 200)

const rgba = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 10, g: 200, b: 30, alpha: 0.5 } } }).png().toBuffer()
const fromRgba = await applyFilmFinish(rgba, { seed: 1 })
check('png with alpha is flattened, not rejected', (await sharp(fromRgba).metadata()).channels === 3)

const tiny = await applyFilmFinish(await flat(8, 8, 128), { seed: 1 })
check('8x8 image works', (await sharp(tiny).metadata()).width === 8)

let threw = false
try { await applyFilmFinish(Buffer.from('not an image'), { seed: 1 }) } catch { threw = true }
check('undecodable input throws (route falls back to untouched bytes)', threw)

console.log(failures === 0 ? '\nAll film-finish tests passed' : `\n${failures} film-finish test(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
