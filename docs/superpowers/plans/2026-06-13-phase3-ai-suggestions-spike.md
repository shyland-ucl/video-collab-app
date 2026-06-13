# Phase 3 AI-Suggestion Engine (Spike) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the generation half of the Phase 3 AI-suggestion engine — a member-checked `POST /api/projects/:id/suggest` endpoint that returns ≤3 validated, curated improvement suggestions for a video — plus a live diag runner to judge real-data quality before any UI is built.

**Architecture:** Mirrors the existing AI-edit slice (`routes/aiEdit.js` + `services/aiEdit.js` + `services/aiEditData.js`): a thin route does auth + membership + body validation; a data loader reads project-scoped scenes/descriptions/keyframes; a pure service builds the prompt, calls Gemini (injected model), parses, validates, and curates. The probe's `three_suggestions_generation.txt` prompt and `curateSuggestions.js` rule are ported verbatim. No UI, no DB writes, no acting on suggestions.

**Tech Stack:** Node 20 ESM, Express 5, `@google/generative-ai` (`gemini-2.5-flash`), Vitest + Supertest, Supabase JS (service-role in prod/diag).

---

### Task 1: Port the probe prompt

**Files:**
- Create: `server/src/prompts/suggestions.txt`

- [ ] **Step 1: Copy the probe prompt verbatim**

Copy the full contents of `video-collab-probe/pipeline/prompts/three_suggestions_generation.txt` (read-only source) into `server/src/prompts/suggestions.txt`. Do not edit wording. The file already specifies: exactly three suggestions, 12–30 words each, zero-based `relatedScene`, the AI-fixable action set (brightness/contrast/saturation/zoom/rotate/mute/unmute) with `fix_template`, the creator/helper action set, and a strict JSON-only output schema.

- [ ] **Step 2: Commit**

```bash
git add server/src/prompts/suggestions.txt
git commit -m "feat(server): port probe three-suggestions prompt"
```

---

### Task 2: Suggestions service — validation + curation + prompt + model call

**Files:**
- Create: `server/src/services/suggestions.js`
- Test: `server/src/services/suggestions.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, expect, vi } from 'vitest'
import {
  cleanFixTemplate,
  cleanSuggestion,
  curateSuggestions,
  buildScenesBlock,
  proposeSuggestions,
  AI_FIXABLE_ACTIONS,
  PROTOTYPE_ACTIONS,
} from './suggestions.js'

const SCENES = [
  { idx: 1, start_seconds: 0, end_seconds: 5, label: 'Scene 1', level1: 'A person stirs a pot.', level2: 'longer', level3: 'longest' },
  { idx: 2, start_seconds: 5, end_seconds: 10, label: 'Scene 2', level1: 'They taste it.', level2: 'longer', level3: 'longest' },
  { idx: 3, start_seconds: 10, end_seconds: 14, label: 'Scene 3', level1: 'Close on the bowl.', level2: 'longer', level3: 'longest' },
]

describe('cleanFixTemplate', () => {
  it('keeps a valid slider template', () => {
    expect(cleanFixTemplate({ action: 'brightness', value: 30, label: 'Brighten' }))
      .toEqual({ action: 'brightness', value: 30, label: 'Brighten' })
  })
  it('rejects an out-of-range slider value', () => {
    expect(cleanFixTemplate({ action: 'zoom', value: 999, label: 'Zoom' })).toBeNull()
    expect(cleanFixTemplate({ action: 'brightness', value: 500, label: 'x' })).toBeNull()
  })
  it('requires mute===true / unmute===false', () => {
    expect(cleanFixTemplate({ action: 'mute', value: true, label: 'Mute' })).toEqual({ action: 'mute', value: true, label: 'Mute' })
    expect(cleanFixTemplate({ action: 'mute', value: false, label: 'Mute' })).toBeNull()
    expect(cleanFixTemplate({ action: 'unmute', value: false, label: 'Unmute' })).toEqual({ action: 'unmute', value: false, label: 'Unmute' })
  })
  it('rejects an unknown action or empty label', () => {
    expect(cleanFixTemplate({ action: 'stabilize', value: 1, label: 'x' })).toBeNull()
    expect(cleanFixTemplate({ action: 'brightness', value: 10, label: '   ' })).toBeNull()
  })
})

describe('cleanSuggestion', () => {
  it('keeps a valid suggestion and trims text', () => {
    const s = cleanSuggestion({ id: 'sug_001', category: 'issue', text: '  too dark  ', relatedScene: 0, prototype_action: 'brightness', fix_template: { action: 'brightness', value: 30, label: 'Brighten' } }, SCENES.length)
    expect(s).toMatchObject({ category: 'issue', text: 'too dark', relatedScene: 0, prototype_action: 'brightness' })
    expect(s.fix_template).toEqual({ action: 'brightness', value: 30, label: 'Brighten' })
  })
  it('drops an out-of-range relatedScene', () => {
    expect(cleanSuggestion({ category: 'issue', text: 'x', relatedScene: 9, prototype_action: 'delete' }, SCENES.length)).toBeNull()
  })
  it('drops an unknown category', () => {
    expect(cleanSuggestion({ category: 'banana', text: 'x', relatedScene: 0, prototype_action: 'delete' }, SCENES.length)).toBeNull()
  })
  it('drops an unknown prototype_action', () => {
    expect(cleanSuggestion({ category: 'issue', text: 'x', relatedScene: 0, prototype_action: 'teleport' }, SCENES.length)).toBeNull()
  })
  it('keeps the suggestion but strips an invalid fix_template', () => {
    const s = cleanSuggestion({ category: 'issue', text: 'x', relatedScene: 0, prototype_action: 'zoom', fix_template: { action: 'zoom', value: 9999, label: 'Zoom' } }, SCENES.length)
    expect(s).not.toBeNull()
    expect(s.fix_template).toBeUndefined()
  })
  it('narrows an array relatedScene to its in-range members', () => {
    const s = cleanSuggestion({ category: 'structural', text: 'x', relatedScene: [1, 99], prototype_action: 'reorder' }, SCENES.length)
    expect(s.relatedScene).toEqual([1])
  })
})

describe('curateSuggestions', () => {
  it('caps at 3, prefers issue>structural>creative, distinct scenes', () => {
    const all = [
      { category: 'creative', text: 'c', relatedScene: 0, prototype_action: 'add_caption' },
      { category: 'issue', text: 'i', relatedScene: 0, prototype_action: 'brightness' },
      { category: 'structural', text: 's', relatedScene: 1, prototype_action: 'reorder' },
      { category: 'creative', text: 'c2', relatedScene: 2, prototype_action: 'add_sound' },
    ]
    const out = curateSuggestions(all, 3)
    expect(out).toHaveLength(3)
    expect(out[0].category).toBe('issue')      // highest priority first
    expect(out[0].relatedScene).toBe(0)
    expect(new Set(out.map((s) => s.relatedScene)).size).toBe(3) // distinct scenes
  })
  it('skips a suggestion whose only scene is already used', () => {
    const all = [
      { category: 'issue', text: 'i', relatedScene: 0, prototype_action: 'brightness' },
      { category: 'structural', text: 's', relatedScene: 0, prototype_action: 'reorder' },
    ]
    expect(curateSuggestions(all, 3)).toHaveLength(1)
  })
})

describe('buildScenesBlock', () => {
  it('lists scenes with zero-based indices and strips newlines', () => {
    const block = buildScenesBlock([{ idx: 1, start_seconds: 0, end_seconds: 5, label: 'A\nB', level1: 'one\ntwo', level2: '', level3: '' }])
    expect(block).toContain('Scene 0')
    expect(block).not.toContain('\nB') // newline in label collapsed
    expect(block).toContain('one two')
  })
})

describe('proposeSuggestions', () => {
  const reply = (obj) => ({ response: { text: () => JSON.stringify(obj) } })

  it('parses, validates, and curates a good model reply', async () => {
    const model = { generateContent: vi.fn(async () => reply({ suggestions: [
      { id: 'sug_001', category: 'issue', text: 'Scene one is dark', relatedScene: 0, prototype_action: 'brightness', fix_template: { action: 'brightness', value: 30, label: 'Brighten' } },
      { id: 'sug_002', category: 'creative', text: 'Add a caption to scene two', relatedScene: 1, prototype_action: 'add_caption' },
    ] })) }
    const out = await proposeSuggestions(model, SCENES, ['kf0', 'kf1'], { readPrompt: async () => 'PROMPT' })
    expect(out.suggestions).toHaveLength(2)
    expect(out.suggestions[0].category).toBe('issue')
    // keyframes were sent as inlineData image parts
    const parts = model.generateContent.mock.calls[0][0]
    expect(parts.filter((p) => p.inlineData)).toHaveLength(2)
  })

  it('retries once on unparseable text then returns empty', async () => {
    const model = { generateContent: vi.fn(async () => ({ response: { text: () => 'not json' } })) }
    const out = await proposeSuggestions(model, SCENES, [], { readPrompt: async () => 'PROMPT' })
    expect(out.suggestions).toEqual([])
    expect(model.generateContent).toHaveBeenCalledTimes(2)
  })

  it('reports how many raw suggestions were dropped', async () => {
    const model = { generateContent: vi.fn(async () => reply({ suggestions: [
      { category: 'issue', text: 'ok', relatedScene: 0, prototype_action: 'brightness' },
      { category: 'banana', text: 'bad', relatedScene: 0, prototype_action: 'brightness' },
    ] })) }
    const out = await proposeSuggestions(model, SCENES, [], { readPrompt: async () => 'PROMPT' })
    expect(out.dropped).toBe(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/services/suggestions.test.js`
Expected: FAIL — `suggestions.js` does not exist yet.

- [ ] **Step 3: Write the implementation**

```javascript
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
  if (!text) return null
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run src/services/suggestions.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/suggestions.js server/src/services/suggestions.test.js
git commit -m "feat(server): suggestion validation + curation + prompt builder"
```

---

### Task 3: Data loader — project-scoped scenes + descriptions + keyframes

**Files:**
- Create: `server/src/services/suggestionsData.js`
- Test: `server/src/services/suggestionsData.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, expect } from 'vitest'
import { loadVideoForSuggestions } from './suggestionsData.js'

// Fake supabase routing by table; storage.download returns a tiny "jpeg".
function makeFake({ video, segRows = [], descRows = [], kf = {} }) {
  return {
    from: (table) => {
      if (table === 'videos') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: video ?? null, error: null }) }) }) }
      }
      if (table === 'segments') {
        return { select: () => ({ eq: () => ({ order: async () => ({ data: segRows, error: null }) }) }) }
      }
      // descriptions
      return { select: () => ({ in: async (_c, ids) => ({ data: descRows.filter((r) => ids.includes(r.segment_id)), error: null }) }) }
    },
    storage: {
      from: () => ({
        download: async (p) => kf[p] ? { data: { arrayBuffer: async () => Buffer.from(kf[p]) }, error: null } : { data: null, error: { message: 'missing' } },
      }),
    },
  }
}

const VIDEO = { id: 'v1', project_id: 'p1', status: 'ready' }

describe('loadVideoForSuggestions', () => {
  it('returns scenes ordered with per-level descriptions and keyframes', async () => {
    const fake = makeFake({
      video: VIDEO,
      segRows: [
        { id: 's1', idx: 1, start_seconds: 0, end_seconds: 5, label: 'One', keyframe_path: 'p1/v1/keyframes/s1_kf.jpg' },
        { id: 's2', idx: 2, start_seconds: 5, end_seconds: 9, label: 'Two', keyframe_path: 'p1/v1/keyframes/s2_kf.jpg' },
      ],
      descRows: [
        { segment_id: 's1', level: 1, text: 'short one' },
        { segment_id: 's1', level: 2, text: 'detail one' },
        { segment_id: 's2', level: 1, text: 'short two' },
      ],
      kf: { 'p1/v1/keyframes/s1_kf.jpg': 'JPEGBYTES1', 'p1/v1/keyframes/s2_kf.jpg': 'JPEGBYTES2' },
    })
    const out = await loadVideoForSuggestions(fake, 'p1', 'v1')
    expect(out.error).toBeUndefined()
    expect(out.scenes).toHaveLength(2)
    expect(out.scenes[0]).toMatchObject({ idx: 1, level1: 'short one', level2: 'detail one' })
    expect(out.scenes[1].level1).toBe('short two')
    expect(out.keyframes).toHaveLength(2)
    expect(out.keyframes[0]).toBe(Buffer.from('JPEGBYTES1').toString('base64'))
  })

  it('rejects a video from another project', async () => {
    const fake = makeFake({ video: { id: 'v1', project_id: 'OTHER', status: 'ready' } })
    expect((await loadVideoForSuggestions(fake, 'p1', 'v1')).error).toBe('video_not_found')
  })

  it('rejects a missing video', async () => {
    const fake = makeFake({ video: null })
    expect((await loadVideoForSuggestions(fake, 'p1', 'v1')).error).toBe('video_not_found')
  })

  it('rejects a video that is not ready', async () => {
    const fake = makeFake({ video: { id: 'v1', project_id: 'p1', status: 'processing' } })
    expect((await loadVideoForSuggestions(fake, 'p1', 'v1')).error).toBe('video_not_ready')
  })

  it('errors when the video has no segments', async () => {
    const fake = makeFake({ video: VIDEO, segRows: [] })
    expect((await loadVideoForSuggestions(fake, 'p1', 'v1')).error).toBe('no_segments')
  })

  it('pushes null for a keyframe that fails to download (still returns the scene)', async () => {
    const fake = makeFake({
      video: VIDEO,
      segRows: [{ id: 's1', idx: 1, start_seconds: 0, end_seconds: 5, label: 'One', keyframe_path: 'missing/path.jpg' }],
      descRows: [{ segment_id: 's1', level: 1, text: 'short one' }],
    })
    const out = await loadVideoForSuggestions(fake, 'p1', 'v1')
    expect(out.scenes).toHaveLength(1)
    expect(out.keyframes).toEqual([null])
  })

  it('truncates to maxScenes and reports it', async () => {
    const segRows = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, idx: i + 1, start_seconds: i, end_seconds: i + 1, label: `S${i}`, keyframe_path: null }))
    const fake = makeFake({ video: VIDEO, segRows })
    const out = await loadVideoForSuggestions(fake, 'p1', 'v1', { maxScenes: 3 })
    expect(out.scenes).toHaveLength(3)
    expect(out.truncated).toBe(true)
    expect(out.totalScenes).toBe(5)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/services/suggestionsData.test.js`
Expected: FAIL — `suggestionsData.js` does not exist yet.

- [ ] **Step 3: Write the implementation**

```javascript
// Load a video's ordered scenes + per-level descriptions + keyframe images for
// the suggestion engine. Project-scoped and ready-gated so a member can never
// pull another project's video or an unprocessed one. Read-only.
const MAX_SCENES = 40

export async function loadVideoForSuggestions(supabase, projectId, videoId, deps = {}) {
  const { maxScenes = MAX_SCENES } = deps

  const { data: video, error: vErr } = await supabase
    .from('videos').select('id, project_id, status').eq('id', videoId).maybeSingle()
  if (vErr || !video || video.project_id !== projectId) return { error: 'video_not_found' }
  if (video.status !== 'ready') return { error: 'video_not_ready' }

  const { data: segRows, error: sErr } = await supabase
    .from('segments')
    .select('id, idx, start_seconds, end_seconds, label, keyframe_path')
    .eq('video_id', videoId)
    .order('idx', { ascending: true })
  if (sErr) return { error: 'segments_query_failed' }
  const segments = segRows ?? []
  if (!segments.length) return { error: 'no_segments' }

  const truncated = segments.length > maxScenes
  const used = truncated ? segments.slice(0, maxScenes) : segments

  const ids = used.map((s) => s.id)
  const { data: descRows, error: dErr } = await supabase
    .from('descriptions').select('segment_id, level, text').in('segment_id', ids)
  if (dErr) return { error: 'descriptions_query_failed' }
  const byId = {}
  for (const r of descRows ?? []) {
    byId[r.segment_id] ??= {}
    byId[r.segment_id][r.level] = r.text
  }

  const scenes = used.map((s) => ({
    idx: s.idx,
    start_seconds: s.start_seconds,
    end_seconds: s.end_seconds,
    label: s.label,
    level1: byId[s.id]?.[1] ?? '',
    level2: byId[s.id]?.[2] ?? '',
    level3: byId[s.id]?.[3] ?? '',
  }))

  const keyframes = []
  for (const s of used) {
    if (!s.keyframe_path) { keyframes.push(null); continue }
    const { data: blob, error } = await supabase.storage.from('videos').download(s.keyframe_path)
    if (error || !blob) { keyframes.push(null); continue }
    keyframes.push(Buffer.from(await blob.arrayBuffer()).toString('base64'))
  }

  return { scenes, keyframes, truncated, totalScenes: segments.length }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run src/services/suggestionsData.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/suggestionsData.js server/src/services/suggestionsData.test.js
git commit -m "feat(server): project-scoped suggestion data loader"
```

---

### Task 4: Route — POST /api/projects/:id/suggest

**Files:**
- Create: `server/src/routes/suggest.js`
- Test: `server/src/routes/suggest.test.js`
- Modify: `server/src/app.js` (mount the route)

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { makeSuggestRoutes } from './suggest.js'

const user = { id: 'user-1', email: 'a@b.c' }

function makeFakeSupabase({ project, member } = {}) {
  return {
    auth: { getUser: vi.fn(async (t) => t === 'good' ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'bad' } }) },
    from: (table) => {
      if (table === 'projects') {
        return { select: () => ({ eq: () => ({ single: async () => project ? { data: project, error: null } : { data: null, error: { message: 'nf' } } }) }) }
      }
      // project_members
      return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: member ?? null, error: null }) }) }) }) }
    },
  }
}

const PROJECT = { id: 'p1', title: 'T' }
const MEMBER = { user_id: 'user-1' }
const SUGGESTIONS = [{ category: 'issue', text: 'too dark', relatedScene: 0, prototype_action: 'brightness' }]

let proposeSpy, loadSpy
function appWith(supabase, { loaded = { scenes: [{}], keyframes: [null] }, proposal = { suggestions: SUGGESTIONS, dropped: 0 } } = {}) {
  proposeSpy = vi.fn(async () => proposal)
  loadSpy = vi.fn(async () => loaded)
  const app = express()
  app.use(express.json())
  app.use(makeSuggestRoutes(supabase, { propose: proposeSpy, getModel: () => ({}), loadVideo: loadSpy }))
  return app
}

beforeEach(() => vi.clearAllMocks())

describe('POST /api/projects/:id/suggest', () => {
  it('requires auth', async () => {
    const res = await request(appWith(makeFakeSupabase({ project: PROJECT, member: MEMBER }))).post('/api/projects/p1/suggest').send({ videoId: 'v1' })
    expect(res.status).toBe(401)
  })

  it('404s for unknown project, 403s for non-members', async () => {
    const r404 = await request(appWith(makeFakeSupabase({ member: MEMBER }))).post('/api/projects/p1/suggest').set('Authorization', 'Bearer good').send({ videoId: 'v1' })
    expect(r404.status).toBe(404)
    const r403 = await request(appWith(makeFakeSupabase({ project: PROJECT }))).post('/api/projects/p1/suggest').set('Authorization', 'Bearer good').send({ videoId: 'v1' })
    expect(r403.status).toBe(403)
    expect(proposeSpy).not.toHaveBeenCalled()
  })

  it('400s on a missing videoId', async () => {
    const res = await request(appWith(makeFakeSupabase({ project: PROJECT, member: MEMBER }))).post('/api/projects/p1/suggest').set('Authorization', 'Bearer good').send({})
    expect(res.status).toBe(400)
  })

  it('maps loader errors to status codes', async () => {
    const r404 = await request(appWith(makeFakeSupabase({ project: PROJECT, member: MEMBER }), { loaded: { error: 'video_not_found' } })).post('/api/projects/p1/suggest').set('Authorization', 'Bearer good').send({ videoId: 'v1' })
    expect(r404.status).toBe(404)
    const r400 = await request(appWith(makeFakeSupabase({ project: PROJECT, member: MEMBER }), { loaded: { error: 'video_not_ready' } })).post('/api/projects/p1/suggest').set('Authorization', 'Bearer good').send({ videoId: 'v1' })
    expect(r400.status).toBe(400)
  })

  it('returns curated suggestions for a member', async () => {
    const res = await request(appWith(makeFakeSupabase({ project: PROJECT, member: MEMBER }))).post('/api/projects/p1/suggest').set('Authorization', 'Bearer good').send({ videoId: 'v1' })
    expect(res.status).toBe(200)
    expect(res.body.suggestions).toEqual(SUGGESTIONS)
    expect(loadSpy).toHaveBeenCalledWith(expect.anything(), 'p1', 'v1')
    expect(proposeSpy).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/routes/suggest.test.js`
Expected: FAIL — `suggest.js` does not exist yet.

- [ ] **Step 3: Write the route**

```javascript
import { Router } from 'express'
import { makeRequireAuth } from '../middleware/requireAuth.js'
import { makeGeminiModel } from '../services/descriptions.js'
import { proposeSuggestions } from '../services/suggestions.js'
import { loadVideoForSuggestions } from '../services/suggestionsData.js'

const LOADER_ERROR_STATUS = { video_not_found: 404, video_not_ready: 400, no_segments: 400 }

export function makeSuggestRoutes(supabase, deps = {}) {
  const { propose = proposeSuggestions, getModel = makeGeminiModel, loadVideo = loadVideoForSuggestions } = deps
  const router = Router()
  const requireAuth = makeRequireAuth(supabase)

  router.post('/api/projects/:id/suggest', requireAuth, async (req, res) => {
    const { data: project } = await supabase
      .from('projects').select('id, title').eq('id', req.params.id).single()
    if (!project) return res.status(404).json({ error: 'project_not_found' })

    const { data: member } = await supabase
      .from('project_members').select('user_id')
      .eq('project_id', project.id).eq('user_id', req.user.id).maybeSingle()
    if (!member) return res.status(403).json({ error: 'not_a_member' })

    const videoId = String(req.body?.videoId ?? '').trim()
    if (!videoId || videoId.length > 200) return res.status(400).json({ error: 'bad_request_body' })

    let model
    try { model = getModel() } catch { return res.status(500).json({ error: 'server_misconfigured' }) }

    const loaded = await loadVideo(supabase, project.id, videoId)
    if (loaded.error) {
      return res.status(LOADER_ERROR_STATUS[loaded.error] ?? 500).json({ error: loaded.error })
    }

    const proposal = await propose(model, loaded.scenes, loaded.keyframes)
    res.json({ suggestions: proposal.suggestions ?? [] })
  })

  return router
}
```

- [ ] **Step 4: Run the route test to verify it passes**

Run: `cd server && npx vitest run src/routes/suggest.test.js`
Expected: PASS.

- [ ] **Step 5: Mount the route in app.js**

In `server/src/app.js`, add the import near the other route imports:

```javascript
import { makeSuggestRoutes } from './routes/suggest.js'
```

and mount it alongside the others (after `makeAiEditRoutes`):

```javascript
  app.use(makeAiEditRoutes(supabaseClient, videoDeps))
  app.use(makeSuggestRoutes(supabaseClient, videoDeps))
```

- [ ] **Step 6: Run the full server suite + build to verify nothing regressed**

Run: `cd server && npx vitest run`
Expected: PASS (existing 60 + new suggestion tests).
Run: `npm run build`
Expected: web build succeeds (no server impact, but confirms the workspace is green).

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/suggest.js server/src/routes/suggest.test.js server/src/app.js
git commit -m "feat(server): POST /api/projects/:id/suggest endpoint"
```

---

### Task 5: Live diag runner

**Files:**
- Create: `scripts/diag-suggest.mjs`

- [ ] **Step 1: Write the runner**

It imports and exercises the REAL services (`loadVideoForSuggestions` + `proposeSuggestions`) against the live admin client + live Gemini, so it tests the actual code path. Picks a video by id arg, or auto-selects the most recent `ready` video.

```javascript
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
    const where = scene ? `scene ${s.relatedScene} ("${scene.label}", ~${Math.round((scene.end_seconds ?? 0) - (scene.start_seconds ?? 0))}s)` : `scene ${s.relatedScene}`
    console.log(`  ${i + 1}. [${s.category}] ${s.text}`)
    console.log(`     → ${where} · action: ${s.prototype_action}`)
    if (s.fix_template) console.log(`     → AI fix: ${s.fix_template.label} (${s.fix_template.action}=${s.fix_template.value})`)
    console.log('')
  }
}
process.exit(0)
```

- [ ] **Step 2: Verify the runner imports cleanly (no live call)**

Run: `node --check scripts/diag-suggest.mjs`
Expected: no syntax errors. (The live run happens in Task 6 against real data.)

- [ ] **Step 3: Commit**

```bash
git add scripts/diag-suggest.mjs
git commit -m "feat: live suggestion diag runner (quality gate)"
```

---

### Task 6: Run the diag against a real video (the quality gate)

**Files:** none (execution + judgement).

- [ ] **Step 1: Run the diag against the live stack**

Run: `node --env-file=server/.env scripts/diag-suggest.mjs`
Expected: prints scene/keyframe counts, then ≤3 suggestions with category, text, scene, action, and any AI fix-template.

- [ ] **Step 2: Capture the output and present it for Lan to judge**

Show the actual suggestions verbatim. Note timing, dropped count, and whether keyframes were all present. The judgement (useful / correct / grounded?) gates whether Phase 3b (the UI port) proceeds or the prompt/model-input is iterated. Do NOT build any UI in this spike.

---

## Self-Review

**Spec coverage:**
- Endpoint (member-checked, body `{ videoId }`) → Task 4. ✓
- Ported prompt → Task 1. ✓
- Service: load scenes/descriptions/keyframes, prompt, Gemini, parse, validate, curate → Tasks 2+3. ✓
- Validation rules (category, relatedScene range, action set, fix_template bounds, strip-not-drop) → Task 2 tests + impl. ✓
- Curation (issue>structural>creative, ≤3, distinct scenes) → Task 2. ✓
- Keyframes-first multimodal input → Task 2 (inlineData parts) + Task 3 (download). ✓
- diag runner → Task 5; live run + judgement gate → Task 6. ✓
- Unit tests with fake model/supabase → Tasks 2/3/4. ✓
- Error table (401/404/403/400 bad body/404 not-found/400 not-ready/500 misconfigured/200 empty) → Task 4 route + Task 3 loader. ✓
- No UI, no DB writes → enforced by scope; loader is read-only, route returns JSON only. ✓

**Placeholder scan:** none — every step has complete code or an exact command.

**Type/name consistency:** `proposeSuggestions(model, scenes, keyframesBase64, deps)`, `loadVideoForSuggestions(supabase, projectId, videoId, deps)`, `makeSuggestRoutes(supabase, deps)` with deps `{ propose, getModel, loadVideo }`, `cleanSuggestion(s, sceneCount)`, `cleanFixTemplate(fix)`, `curateSuggestions(all, maxCount)`, `buildScenesBlock(scenes)` — used identically across tasks and tests. Loader return `{ scenes, keyframes, truncated, totalScenes }` or `{ error }`; route maps error→status via `LOADER_ERROR_STATUS`. Consistent. ✓
