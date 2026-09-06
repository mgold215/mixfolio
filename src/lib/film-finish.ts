// Film finish: the post-generation pass that takes the "AI sheen" off a
// generated image.
//
// Every current image model outputs pixels that are cleaner than any camera
// ever produced: zero noise, uniform exposure edge to edge, saturated
// mid-tones. Viewers read that sterility as synthetic before they notice a
// single wrong detail. Real photographs carry three things this pass adds
// back, all subtle enough to pass unnoticed on their own:
//
//   grain    — luminance noise, heavier in shadows and mid-tones than in
//              highlights, the way film and high-ISO sensors behave.
//   vignette — a gentle radial fall-off toward the corners, as every real lens
//              has, strongest in the film cameras the vary-look asks for.
//   palette  — a slight desaturation; generated images are ~10% too vivid.
//
// Pure image maths over a raw RGB buffer plus a sharp encode. No server-only
// imports — scripts/film-finish-test.mjs drives it directly under Node.
//
// Output is always JPEG. Besides being what a camera writes, the 4:2:0 chroma
// subsampling and quantisation are themselves faint authenticity cues.

import sharp from 'sharp'

export type FilmFinishOptions = {
  /** 0 = none, 1 = heavy. Default 0.45 — visible at 100%, invisible at thumbnail. */
  grain?: number
  /** 0 = none, 1 = heavy (≈45% darker corners). Default 0.35 (≈16%). */
  vignette?: number
  /** Multiplier on saturation. Default 0.92. */
  saturation?: number
  /** Seeds the grain so a given input always yields the same output. */
  seed?: number
  /** JPEG quality. Default 90. */
  quality?: number
}

// mulberry32: tiny, fast, seedable. Grain must be reproducible (same seed →
// identical bytes) so the contract test can pin it and so a re-run of the
// same generation is byte-stable.
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Apply the film finish to an encoded image (jpeg/png/webp) and return JPEG
 * bytes. Dimensions are preserved. Throws on undecodable input — the caller
 * decides whether to fall back to the untouched bytes.
 */
export async function applyFilmFinish(input: Buffer, opts: FilmFinishOptions = {}): Promise<Buffer> {
  const grain = clamp(opts.grain ?? 0.45, 0, 1)
  const vignette = clamp(opts.vignette ?? 0.35, 0, 1)
  const saturation = clamp(opts.saturation ?? 0.92, 0.5, 1.5)
  const quality = clamp(Math.round(opts.quality ?? 90), 50, 100)
  const seed = opts.seed ?? 1

  const { data, info } = await sharp(input)
    .rotate()            // bake in any EXIF orientation before touching pixels
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const { width, height, channels } = info
  if (channels !== 3) throw new Error(`film-finish: expected 3 channels, got ${channels}`)

  // Grain amplitude in 8-bit units at mid-grey. 0.45 → ~7.4, which is roughly
  // the standard deviation of Portra 400 scanned at 2K, or a full-frame sensor
  // around ISO 1600.
  const sigma = grain * 16.5
  // Vignette: corners lose `vignette * 0.45` of their brightness; the centre
  // is untouched. Quadratic-ish fall-off so it only bites in the last third.
  const vigStrength = vignette * 0.45
  const cx = (width - 1) / 2
  const cy = (height - 1) / 2
  const maxR2 = cx * cx + cy * cy || 1

  const next = rng(seed)
  const out = Buffer.allocUnsafe(data.length)
  let i = 0
  for (let y = 0; y < height; y++) {
    const dy = y - cy
    for (let x = 0; x < width; x++) {
      const dx = x - cx
      const r2 = (dx * dx + dy * dy) / maxR2   // 0 at centre, 1 at the corners
      const vig = 1 - vigStrength * r2 * r2

      const r = data[i], g = data[i + 1], b = data[i + 2]
      // Rec.601 luma, 0..1
      const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255
      // Film response: grain is strongest in the shadows/mid-tones and fades
      // in the highlights (bright areas are dense on the negative).
      const amp = sigma * (0.35 + 0.65 * (1 - luma))
      // Sum of three uniforms ≈ gaussian, cheap enough for 4MP per call.
      const n = (next() + next() + next() - 1.5) * amp * 1.4142

      out[i]     = clamp8((r + n) * vig)
      out[i + 1] = clamp8((g + n) * vig)
      out[i + 2] = clamp8((b + n) * vig)
      i += 3
    }
  }

  return sharp(out, { raw: { width, height, channels: 3 } })
    .modulate({ saturation })
    .jpeg({ quality, chromaSubsampling: '4:2:0', mozjpeg: false })
    .toBuffer()
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0
}
