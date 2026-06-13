/**
 * Live Phase 3 suggestion check — the quality gate for the spike.
 * Runs the REAL loader + REAL Gemini against a real ready video and prints
 * the suggestions for a human to judge. Never run in CI; never gates a build.
 *
 * Run from repo root:
 *   node --env-file=server/.env scripts/diag-suggest.mjs [videoId]
 *
 * With no videoId it auto-picks the most recently created 'ready' video.
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + GEMINI_API_KEY in server/.env.
 */
import { createClient } from '@supabase/supabase-js'
import { makeGeminiModel } from '../server/src/services/descriptions.js'
import { loadVideoForSuggestions } from '../server/src/services/suggestionsData.js'
import { proposeSuggestions } from '../server/src/services/suggestions.js'

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY } = process.env
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (server/.env).')
  process.exit(1)
}
if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not set (server/.env).')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

let videoId = process.argv[2]
let projectId

if (videoId) {
  const { data, error } = await admin.from('videos').select('id, project_id, status').eq('id', videoId).maybeSingle()
  if (error || !data) { console.error(`video ${videoId} not found: ${error?.message ?? 'no row'}`); process.exit(1) }
  if (data.status !== 'ready') { console.error(`video ${videoId} is '${data.status}', not 'ready'.`); process.exit(1) }
  projectId = data.project_id
} else {
  const { data, error } = await admin
    .from('videos').select('id, project_id, original_name, created_at')
    .eq('status', 'ready').order('created_at', { ascending: false }).limit(1)
  if (error || !data?.length) { console.error(`no 'ready' video found: ${error?.message ?? 'none'}`); process.exit(1) }
  videoId = data[0].id
  projectId = data[0].project_id
  console.log(`Auto-picked most recent ready video: ${data[0].original_name ?? videoId} (${videoId})`)
}

console.log(`\n=== Phase 3 suggestion diag ===`)
console.log(`  project: ${projectId}`)
console.log(`  video:   ${videoId}\n`)

const loaded = await loadVideoForSuggestions(admin, projectId, videoId)
if (loaded.error) { console.error(`loader error: ${loaded.error}`); process.exit(1) }
console.log(`  scenes loaded: ${loaded.scenes.length}${loaded.truncated ? ` (truncated from ${loaded.totalScenes})` : ''}`)
console.log(`  keyframes present: ${loaded.keyframes.filter(Boolean).length}/${loaded.keyframes.length}\n`)

const model = makeGeminiModel()
const t0 = Date.now()
const { suggestions, dropped } = await proposeSuggestions(model, loaded.scenes, loaded.keyframes)
const secs = ((Date.now() - t0) / 1000).toFixed(1)

console.log(`--- ${suggestions.length} suggestion(s) in ${secs}s${dropped ? `, ${dropped} dropped in validation` : ''} ---\n`)
if (!suggestions.length) {
  console.log('  (no valid suggestions returned — judge whether the model said nothing useful or returned junk)')
} else {
  for (const [i, s] of suggestions.entries()) {
    const scene = loaded.scenes[s.relatedScene]
    const where = scene
      ? `scene ${s.relatedScene} ("${scene.label}", ~${Math.round((scene.end_seconds ?? 0) - (scene.start_seconds ?? 0))}s)`
      : `scene ${s.relatedScene}`
    console.log(`  ${i + 1}. [${s.category}] ${s.text}`)
    console.log(`     → ${where} · action: ${s.prototype_action}`)
    if (s.fix_template) console.log(`     → AI fix: ${s.fix_template.label} (${s.fix_template.action}=${s.fix_template.value})`)
    console.log('')
  }
}
process.exit(0)
