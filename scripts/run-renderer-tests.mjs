#!/usr/bin/env node
// Runs the renderer/contract test suites, each under a wall-clock deadline.
//
// Why this exists rather than a plain `a.mjs && b.mjs && …` chain:
//
// On 2026-07-30 the Renderer Tests job hung. It was killed by the workflow's
// `timeout-minutes`, and GitHub does not archive logs for a job it force-cancels
// — so the run produced NO evidence at all: no failing suite, no last line, no
// stack. The same commit passed in 1m40s on the other run of the identical tree,
// so it is intermittent and cannot be reproduced on demand.
//
// The suites spawn real ffmpeg/ffprobe children (video-test, video-timeout-test,
// finalize-test). Those child processes are genuinely capable of blocking
// forever — video-timeout-test exists precisely because a wedged ffmpeg never
// settles — and while src/lib/video-render.ts guards its own spawn sites with
// armDeadline, the test scripts driving it settle only on 'close', which never
// fires if the child never exits. Compounding it, the renderer's own worst-case
// stage budgets sum to longer than the CI cap, so a legitimately slow path is
// indistinguishable from a wedge.
//
// This runner does not attempt to fix the hang. It makes the next one
// DIAGNOSABLE: a stuck suite is killed here, by name, with its output already
// streamed to the log, and the build goes red normally instead of the job being
// destroyed with its evidence.
//
// Deliberately dependency-free and cross-platform: GNU `timeout` would have done
// this in one line, but it is not present on macOS, where this suite is also run
// by hand.
//
// Run: node scripts/run-renderer-tests.mjs   (this is `npm run test:renderers`)
// Individual suites remain runnable directly: node scripts/<name>.mjs
// Override the per-suite budget with TEST_TIMEOUT_MS.

import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const scriptsDir = dirname(fileURLToPath(import.meta.url))

// Order matters only in that the cheap pure-source contract tests run first, so
// a structural regression fails in seconds rather than after the ffmpeg suites.
const SUITES = [
  'verify-token-test.mjs',
  'auth-errors-test.mjs',
  'admin-client-role-test.mjs',
  'admin-identity-test.mjs',
  'artwork-models-test.mjs',
  'film-finish-test.mjs',
  'artwork-history-test.mjs',
  'upload-ownership-test.mjs',
  'uuid-storage-key-test.mjs',
  'ios-storage-key-test.mjs',
  'share-projection-test.mjs',
  'download-default-test.mjs',
  'public-input-caps-test.mjs',
  'mix-notes-test.mjs',
  'notification-loop-test.mjs',
  'db-init-rls-test.mjs',
  'db-init-migration-parity-test.mjs',
  'profiles-rls-test.mjs',
  'schema-heal-parity-test.mjs',
  'schema-heal-matcher-test.mjs',
  'usage-rpc-grants-test.mjs',
  'usage-table-rls-test.mjs',
  'security-heal-trigger-test.mjs',
  'heal-retry-test.mjs',
  'rate-limit-key-test.mjs',
  'release-pipeline-test.mjs',
  'loudness-test.mjs',
  'loudness-compare-test.mjs',
  'loudness-auto-test.mjs',
  'master-recommendations-test.mjs',
  'project-delete-assets-test.mjs',
  'survivor-scan-bound-test.mjs',
  'survivor-scan-routing-test.mjs',
  'asset-url-write-guard-test.mjs',
  'delete-account-scope-test.mjs',
  'delete-account-bound-test.mjs',
  'project-delete-scope-test.mjs',
  'archived-playback-test.mjs',
  'duration-backfill-test.mjs',
  'audio-duration-test.mjs',
  'mix-status-test.mjs',
  'tracks-duration-heal-test.mjs',
  'share-duration-heal-test.mjs',
  'write-route-guards-test.mjs',
  'infra-sql-guard-test.mjs',
  'bpm-test.mjs',
  'catalog-test.mjs',
  'submit-links-test.mjs',
  'usage-refund-test.mjs',
  'effects-test.mjs',
  'fx-test.mjs',
  'viz-save-test.mjs',
  'viz-claim-idempotency-test.mjs',
  'viz-key-shape-test.mjs',
  'viz-webm-replay-test.mjs',
  'video-orphan-reaper-test.mjs',
  'viz-finalize-test.mjs',
  'viz-recover-test.mjs',
  'finalize-test.mjs',
  'visualizer-transcode-test.mjs',
  'video-test.mjs',
  'video-timeout-test.mjs',
]

// The whole suite runs in ~72s on CI and ~100s locally; the slowest single suite
// measured 51s. 300s per suite is several times the observed worst case while
// still leaving the 19 suites far inside the job's own cap, so a trip here means
// something is genuinely stuck rather than merely slow.
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS ?? 300_000)

// This list is now the single source of truth for what CI runs, which creates a
// new way to fail quietly: write a *-test.mjs, forget to list it, and it never
// runs while the build stays green. Every scripts/*-test.mjs must be accounted
// for. (test-infra.mjs / test-upload.mjs are named the other way round on
// purpose — they are smoke tests that need a live URL, not unit suites.)
const onDisk = readdirSync(scriptsDir).filter(f => f.endsWith('-test.mjs')).sort()
const unlisted = onDisk.filter(f => !SUITES.includes(f))
const missing = SUITES.filter(f => !onDisk.includes(f))
if (unlisted.length || missing.length) {
  if (unlisted.length) console.error(`✗ test suite(s) on disk but not run: ${unlisted.join(', ')}`)
  if (missing.length) console.error(`✗ test suite(s) listed but not on disk: ${missing.join(', ')}`)
  process.exit(1)
}

/**
 * Run one suite to completion or to the deadline.
 * @returns {Promise<{ ok: boolean, timedOut: boolean, code: number|null, ms: number }>}
 */
function runSuite(name) {
  return new Promise(resolve => {
    const started = Date.now()
    // detached so the child gets its own process group: a wedged suite has
    // usually wedged on a GRANDCHILD (ffmpeg/ffprobe), and killing only the node
    // process would leave that running and holding the pipe open.
    const child = spawn(process.execPath, [join(scriptsDir, name)], {
      stdio: 'inherit',
      detached: true,
    })

    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      try {
        // Negative pid = the whole process group. SIGKILL, not SIGTERM: ffmpeg
        // catches SIGTERM, and a wedged child may never process it at all.
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }
    }, TIMEOUT_MS)

    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: !timedOut && code === 0, timedOut, code, ms: Date.now() - started })
    }

    child.on('error', () => finish(null))
    child.on('close', code => finish(code))
  })
}

const results = []
let failed = null

for (const name of SUITES) {
  console.log(`\n──── ${name} ────`)
  const r = await runSuite(name)
  results.push({ name, ...r })
  if (!r.ok) {
    failed = { name, ...r }
    break
  }
}

console.log('\n════ renderer test summary ════')
for (const r of results) {
  const secs = (r.ms / 1000).toFixed(1).padStart(6)
  const mark = r.ok ? '✓' : (r.timedOut ? '⏱' : '✗')
  console.log(`  ${mark} ${secs}s  ${r.name}`)
}

if (failed) {
  if (failed.timedOut) {
    console.error(
      `\n✗ ${failed.name} was killed after ${TIMEOUT_MS / 1000}s — it did not finish.\n` +
      `  This is the hang that previously destroyed the CI job with no log.\n` +
      `  The suite's output above is the last thing it printed before it stuck;\n` +
      `  every child in its process group has been SIGKILLed.`
    )
  } else {
    console.error(`\n✗ ${failed.name} failed (exit ${failed.code})`)
  }
  process.exit(1)
}

const total = (results.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(1)
console.log(`\n✅ ${results.length} suites passed in ${total}s`)
