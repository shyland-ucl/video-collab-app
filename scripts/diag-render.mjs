/**
 * Live Phase 4 render check — the quality gate for export.
 * Runs the REAL renderVideo worker against a real project's EDL + sources and
 * writes the output MP4 locally so a human can watch it (structure + colour
 * fidelity). Also prints the render plan + each clip's ffmpeg -vf so the colour
 * filter can be eyeballed against the editor preview. Never run in CI.
 *
 * Run from repo root:
 *   node --env-file=server/.env scripts/diag-render.mjs [projectId]
 *
 * With no projectId it auto-picks the most recent project that has saved edit
 * state. Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in server/.env.
 */
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLatestState } from '../server/src/services/stateStore.js'
import { loadProjectSources } from '../server/src/services/renderData.js'
import { buildRenderPlan, clipFfmpegArgs } from '../server/src/services/renderPlan.js'
import { renderVideo } from '../server/src/services/renderVideo.js'

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (server/.env).')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

let projectId = process.argv[2]
if (!projectId) {
  const { data, error } = await admin
    .from('project_state').select('project_id, created_at')
    .order('created_at', { ascending: false }).limit(1)
  if (error || !data?.length) { console.error(`no project_state found: ${error?.message ?? 'none'}`); process.exit(1) }
  projectId = data[0].project_id
  console.log(`Auto-picked most recent edited project: ${projectId}`)
}

console.log(`\n=== Phase 4 render diag ===\n  project: ${projectId}\n`)

const latest = await loadLatestState(admin, projectId)
const sources = await loadProjectSources(admin, projectId)
if (!latest) { console.error('no edit state for this project'); process.exit(1) }

let plan
try {
  plan = buildRenderPlan(latest.state, sources)
} catch (err) {
  console.error(`plan error: ${err.message}`)
  process.exit(1)
}

console.log(`  EDL version ${latest.version} · ${plan.length} clip(s) · ${sources.length} source(s)\n`)
for (const e of plan) {
  const vf = clipFfmpegArgs(e, 'out.mp4')[clipFfmpegArgs(e, 'out.mp4').indexOf('-vf') + 1]
  console.log(`  clip ${e.index}: source ${e.sourceId} [${e.effStart}s → ${e.effEnd}s]` +
    `${e.muted ? ' muted' : e.volume !== 100 ? ` vol ${e.volume}%` : ''}` +
    `${e.colour ? ` colour ${JSON.stringify(e.colour)}` : ''}`)
  console.log(`     -vf: ${vf}`)
}

const outDir = path.join(repoRoot, 'render-out')
await fs.mkdir(outDir, { recursive: true })
const workdir = path.join(outDir, `work-${projectId}`)
await fs.mkdir(workdir, { recursive: true })

console.log(`\n  rendering (live ffmpeg)…`)
const t0 = Date.now()
try {
  // rm is a no-op so the local out.mp4 survives for inspection. renderId 'diag'
  // → the renders-row UPDATE simply matches 0 rows (harmless); the upload to
  // storage still happens at <project>/renders/diag.mp4.
  await renderVideo({ supabase: admin, projectId, renderId: 'diag', workdir, rm: async () => {} })
} catch (err) {
  console.error(`\n  render FAILED: ${err.message}`)
  process.exit(1)
}
const secs = ((Date.now() - t0) / 1000).toFixed(1)

const outFile = path.join(workdir, 'out.mp4')
const finalFile = path.join(outDir, `${projectId}.mp4`)
await fs.copyFile(outFile, finalFile)
const { size } = await fs.stat(finalFile)
await fs.rm(workdir, { recursive: true, force: true })

console.log(`\n  ✅ rendered in ${secs}s → ${path.relative(repoRoot, finalFile)} (${(size / 1024 / 1024).toFixed(1)} MB)`)
console.log(`  Watch it to verify the cut order, trims, audio, and the colour grade match the editor preview.\n`)
process.exit(0)
