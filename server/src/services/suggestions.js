import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const promptsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts')

// Probe action sets — keep in sync with prompts/suggestions.txt AND the editor's
// apply-path. AI_FIXABLE values map 1:1 onto the colour/zoom/rotate/mute ops the
// editor already accepts, so a kept fix_template is guaranteed applicable when
// Phase 3b wires it up.
export const AI_FIXABLE_ACTIONS = ['brightness', 'contrast', 'saturation', 'zoom', 'rotate', 'mute', 'unmute']
export const PROTOTYPE_ACTIONS = [
  ...AI_FIXABLE_ACTIONS,
  'trim_start', 'trim_end', 'split', 'delete', 'reorder',
  'move_earlier', 'move_later', 'add_caption', 'add_sound', 'remove_sound',
]
export const SUGGESTION_CATEGORIES = ['issue', 'structural', 'creative']
const CATEGORY_PRIORITY = { issue: 0, structural: 1, creative: 2 }

// Same numeric bounds the editor's colour/zoom/rotate ops accept.
const FIX_VALUE_RANGES = { brightness: [-100, 100], contrast: [-100, 100], saturation: [-100, 100], zoom: [100, 250], rotate: [-180, 180] }

function inRange(n, [lo, hi]) {
  return typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi
}

// Validate a fix_template; return a clean template or null (strip, don't drop
// the whole suggestion — it stays as a creator/helper action).
export function cleanFixTemplate(fix) {
  if (!fix || typeof fix !== 'object') return null
  const { action } = fix
  if (!AI_FIXABLE_ACTIONS.includes(action)) return null
  let value
  if (action === 'mute') { if (fix.value !== true) return null; value = true }
  else if (action === 'unmute') { if (fix.value !== false) return null; value = false }
  else { if (!inRange(fix.value, FIX_VALUE_RANGES[action])) return null; value = fix.value }
  const label = typeof fix.label === 'string' ? fix.label.trim().slice(0, 60) : ''
  if (!label) return null
  return { action, value, label }
}

// Validate one suggestion against the scene count; return a clean copy or null.
export function cleanSuggestion(s, sceneCount) {
  if (!s || typeof s !== 'object') return null
  if (!SUGGESTION_CATEGORIES.includes(s.category)) return null
  const text = typeof s.text === 'string' ? s.text.trim().slice(0, 300) : ''
  // The prompt asks for a 12–30 word sentence; reject obvious hallucinated
  // fragments ("x", ".") well below any real suggestion's length.
  if (text.length < 12) return null
  const scenes = Array.isArray(s.relatedScene) ? s.relatedScene : [s.relatedScene]
  const valid = scenes.filter((i) => Number.isInteger(i) && i >= 0 && i < sceneCount)
  if (!valid.length) return null
  if (!PROTOTYPE_ACTIONS.includes(s.prototype_action)) return null
  const cleaned = {
    id: typeof s.id === 'string' && s.id.trim() ? s.id.trim().slice(0, 40) : null,
    category: s.category,
    text,
    relatedScene: Array.isArray(s.relatedScene) ? valid : valid[0],
    prototype_action: s.prototype_action,
  }
  const fix = cleanFixTemplate(s.fix_template)
  if (fix) cleaned.fix_template = fix
  return cleaned
}

// Curate (port of probe curateSuggestions.js): priority issue>structural>creative,
// cap at maxCount, no two share a scene; narrow relatedScene to the chosen one.
export function curateSuggestions(all, maxCount = 3) {
  if (!Array.isArray(all) || !all.length) return []
  const sorted = [...all].sort((a, b) => (CATEGORY_PRIORITY[a.category] ?? 99) - (CATEGORY_PRIORITY[b.category] ?? 99))
  const used = new Set()
  const curated = []
  for (const s of sorted) {
    if (curated.length >= maxCount) break
    const targets = Array.isArray(s.relatedScene) ? s.relatedScene : (s.relatedScene == null ? [] : [s.relatedScene])
    const free = targets.find((t) => t != null && !used.has(t))
    if (free === undefined) continue
    used.add(free)
    curated.push({ ...s, relatedScene: free })
  }
  return curated
}

// Render the scenes block. Zero-based index is the probe contract — the model
// keys relatedScene off it. Newlines are collapsed so one scene = clean lines.
export function buildScenesBlock(scenes) {
  const clean = (t) => String(t ?? '').replace(/\s*\n\s*/g, ' ').trim()
  return scenes.map((s, i) => {
    const dur = Math.max(0, Math.round((s.end_seconds ?? 0) - (s.start_seconds ?? 0)))
    return [
      `Scene ${i} (${clean(s.label) || 'scene'}, ~${dur}s):`,
      `  short: ${clean(s.level1) || 'no description'}`,
      `  detail: ${clean(s.level2) || 'none'}`,
      `  full: ${clean(s.level3) || 'none'}`,
    ].join('\n')
  }).join('\n\n')
}

function parseJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```[\s\S]*$/, '')
  return JSON.parse(cleaned)
}

// Build the prompt (keyframe images + scenes block), call the model with one
// retry on parse failure, validate + curate. Never throws — returns
// { suggestions, dropped } and an empty list if the model can't be parsed.
export async function proposeSuggestions(model, scenes, keyframesBase64, deps = {}) {
  const { readPrompt = () => fs.readFile(path.join(promptsDir, 'suggestions.txt'), 'utf-8') } = deps
  const template = await readPrompt()
  const prompt = `${String(template).trim()}\n\nSegments (zero-based scene indices):\n${buildScenesBlock(scenes)}\n`
  const imageParts = (keyframesBase64 ?? [])
    .filter(Boolean)
    .map((data) => ({ inlineData: { mimeType: 'image/jpeg', data } }))

  let parsed
  try {
    const result = await model.generateContent([...imageParts, { text: prompt }])
    parsed = parseJson(result.response.text())
  } catch {
    try {
      const retry = await model.generateContent([
        ...imageParts,
        { text: `${prompt}\n\nIMPORTANT: Return only valid JSON. No markdown, no explanation.` },
      ])
      parsed = parseJson(retry.response.text())
    } catch {
      return { suggestions: [], dropped: 0 }
    }
  }

  const raw = Array.isArray(parsed?.suggestions) ? parsed.suggestions : []
  const cleaned = raw.map((s) => cleanSuggestion(s, scenes.length)).filter(Boolean)
  return { suggestions: curateSuggestions(cleaned, 3), dropped: raw.length - cleaned.length }
}

// Persist the curated suggestions for a (project, video): re-analysing a video
// supersedes the old set. We INSERT the new rows FIRST, then delete the prior
// rows — so an insert failure leaves the old set intact (no data-loss window),
// and a connected peer sees the new INSERTs before the old DELETEs (no transient
// "suggestions vanished" gap). Service-role only (the route's admin client
// bypasses RLS). Returns the inserted rows, or null on insert failure.
export async function persistSuggestions(supabase, projectId, videoId, suggestions, scenes) {
  // Snapshot the prior rows up front so we can delete exactly them afterwards.
  const { data: prior, error: priorErr } = await supabase
    .from('suggestions').select('id').eq('project_id', projectId).eq('video_id', videoId)
  if (priorErr) {
    console.error('persistSuggestions: prior-rows query failed:', priorErr.message)
    return null
  }
  const priorIds = (prior ?? []).map((r) => r.id)

  let inserted = []
  if (suggestions.length) {
    const rows = suggestions.map((s) => {
      const idx = Array.isArray(s.relatedScene) ? s.relatedScene[0] : s.relatedScene
      return {
        project_id: projectId,
        video_id: videoId,
        model_suggestion_id: s.id ?? null,
        category: s.category,
        text: s.text,
        related_scene: idx,
        segment_id: scenes[idx]?.segmentId ?? null,
        prototype_action: s.prototype_action,
        fix_template: s.fix_template ?? null,
      }
    })
    const { data, error } = await supabase.from('suggestions').insert(rows).select()
    if (error) {
      // Old set is still intact (we haven't deleted yet) — surface the failure.
      console.error('persistSuggestions: insert failed:', error.message)
      return null
    }
    inserted = data ?? []
  }

  // New set committed (or empty) → remove the prior set. A delete failure here
  // is non-fatal: the new rows are live; stale old rows are tidied on next run.
  if (priorIds.length) {
    const { error: delErr } = await supabase.from('suggestions').delete().in('id', priorIds)
    if (delErr) console.error('persistSuggestions: stale-row delete failed:', delErr.message)
  }
  return inserted
}
