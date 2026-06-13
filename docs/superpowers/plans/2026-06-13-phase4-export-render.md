# Phase 4 — Export/Render (v1: structural + colour) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development or executing-plans. Steps use `- [ ]`.

**Goal:** the creator taps Export → the server renders the project EDL (trims, order, splits, deletes, mute/volume, per-scene colour) into one downloadable MP4, via an async job that reuses the Phase 1b processing skeleton.

**Architecture:** a project-scoped `renders` table (job state machine, server-written) + `POST /api/projects/:id/render` (member-checked, atomic-claim 409) + a `renderVideo` worker that re-cuts each clip from its original with colour/scale/audio filters and concats. Pure `renderPlan` (EDL→plan + ffmpeg arg builders + colour-filter) is the testable core. Client: an accessible Export panel driven by the renders realtime channel.

**Tech stack:** Postgres/Supabase (RLS + realtime + storage), Express 5, `ffmpeg-static` via `node:child_process` execFile (no fluent-ffmpeg — match `segmentation.js`), React 19, Vitest, Playwright.

---

### Task 1: Migration 0012 — `renders` table + bucket size

**Files:** Create `supabase/migrations/0012_renders.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Phase 4: project-level render jobs (EDL → MP4). Server-written (service-role);
-- members read. Mirrors the suggestions/tasks RLS pattern.
create table public.renders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  status text not null default 'rendering'
    check (status in ('rendering', 'ready', 'failed')),
  output_path text,
  error text,
  edl_version integer,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index renders_project_created_idx on public.renders (project_id, created_at desc);

alter table public.renders enable row level security;

-- Members read; only the server (service-role bypasses RLS) inserts/updates.
create policy "members read renders" on public.renders
  for select using (public.is_project_member(project_id));

alter publication supabase_realtime add table public.renders;

-- Rendered videos are larger than the 50MB segment limit — raise it.
update storage.buckets set file_size_limit = 524288000 where id = 'videos'; -- 500 MB
```

- [ ] **Step 2: Apply live** — `npx supabase db push --yes`. Expected: 0012 applied (additive).
- [ ] **Step 3: Commit** `git add supabase/migrations/0012_renders.sql && git commit -m "feat(db): 0012 renders table + raise bucket size"`

---

### Task 2: Pure `renderPlan.js` — EDL→plan + colour filter + clip args

**Files:** Create `server/src/services/renderPlan.js` + `renderPlan.test.js`. Pure (no ffmpeg, no IO).

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, expect } from 'vitest'
import { buildRenderPlan, colourToVf, clipFfmpegArgs, OUTPUT } from './renderPlan.js'

const SOURCES = [{ id: 'v1', storage_path: 'p1/v1/original.mp4' }, { id: 'v2', storage_path: 'p1/v2/original.mp4' }]
const baseClip = (o) => ({ trimStart: 0, trimEnd: 0, ...o })

describe('buildRenderPlan', () => {
  it('orders clips, computes effective ranges, resolves source + colour by rootSegmentId', () => {
    const state = {
      clips: [
        baseClip({ id: 's1', sourceId: 'v1', startTime: 0, endTime: 5, trimStart: 1 }),
        baseClip({ id: 's1-split-1765-a', sourceId: 'v1', startTime: 5, endTime: 8 }),
        baseClip({ id: 's2', sourceId: 'v2', startTime: 2, endTime: 9, trimEnd: 2, muted: true, volume: 150 }),
      ],
      colour: { s1: { brightness: 20 }, s2: { zoom: 150 } },
    }
    const plan = buildRenderPlan(state, SOURCES)
    expect(plan.map((p) => p.index)).toEqual([0, 1, 2])
    expect(plan[0]).toMatchObject({ sourceId: 'v1', sourcePath: 'p1/v1/original.mp4', effStart: 1, effEnd: 5 })
    expect(plan[0].colour).toEqual({ brightness: 20 })       // keyed by rootSegmentId('s1')
    expect(plan[1].colour).toEqual({ brightness: 20 })       // split half inherits the root grade
    expect(plan[2]).toMatchObject({ effStart: 2, effEnd: 7, muted: true, volume: 150 })
    expect(plan[2].colour).toEqual({ zoom: 150 })
  })

  it('drops clips whose source is unresolvable and throws on an empty plan', () => {
    const okState = { clips: [baseClip({ id: 'g', sourceId: 'gone', startTime: 0, endTime: 2 })], colour: {} }
    expect(() => buildRenderPlan(okState, SOURCES)).toThrow(/nothing_to_render/)
  })
})

describe('colourToVf', () => {
  it('returns null for a neutral grade', () => {
    expect(colourToVf(undefined, OUTPUT)).toBeNull()
    expect(colourToVf({ brightness: 0, contrast: 0, saturation: 0, zoom: 100, rotate: 0 }, OUTPUT)).toBeNull()
  })
  it('emits eq contrast/saturation with the exact CSS multipliers', () => {
    const vf = colourToVf({ contrast: 20, saturation: 50 }, OUTPUT)
    expect(vf).toContain('eq=contrast=1.1')      // 1 + 20/200
    expect(vf).toContain('saturation=1.5')        // 1 + 50/100
  })
  it('emits a center crop for zoom and a rotate in radians', () => {
    const vf = colourToVf({ zoom: 200, rotate: 90 }, OUTPUT)
    expect(vf).toContain('crop=iw/2:ih/2')        // zoom 200 → 1/2 center crop
    expect(vf).toContain('rotate=90*PI/180')
  })
})

describe('clipFfmpegArgs', () => {
  it('builds an execFile arg array: input, seek window, filters, codec', () => {
    const entry = { sourcePath: '/tmp/v1.mp4', effStart: 1, effEnd: 5, colour: { brightness: 20 }, muted: false, volume: 100 }
    const args = clipFfmpegArgs(entry, '/tmp/clip_000.mp4')
    expect(args).toContain('-ss'); expect(args).toContain('1')
    expect(args).toContain('-to'); expect(args).toContain('5')
    expect(args).toContain('-i'); expect(args).toContain('/tmp/v1.mp4')
    expect(args.join(' ')).toContain('libx264')
    expect(args[args.length - 1]).toBe('/tmp/clip_000.mp4')
  })
  it('drops audio for a muted clip and sets volume otherwise', () => {
    const muted = clipFfmpegArgs({ sourcePath: '/s', effStart: 0, effEnd: 2, muted: true, volume: 100 }, '/o.mp4')
    expect(muted).toContain('-an')
    const loud = clipFfmpegArgs({ sourcePath: '/s', effStart: 0, effEnd: 2, muted: false, volume: 150 }, '/o.mp4')
    expect(loud.join(' ')).toContain('volume=1.5')
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `cd server && npx vitest run src/services/renderPlan.test.js` → FAIL (module missing).

- [ ] **Step 3: Write the implementation**

```javascript
// Pure EDL → render plan + ffmpeg arg/filter builders. No ffmpeg, no IO — the
// testable core of the render. Keep rootSegmentId + the colour math in sync with
// web stateStore.rootSegmentId and HelperDevice.colourValuesToFilter/Transform.

export const OUTPUT = { w: 1280, h: 720, fps: 30 }

function rootSegmentId(clipId) {
  return clipId.replace(/(-split-\d+-[0-9a-z]+)+$/, '')
}

// EDL → ordered plan entries. Throws 'nothing_to_render' when no clip resolves.
export function buildRenderPlan(state, sources) {
  const byId = new Map((sources ?? []).map((s) => [s.id, s]))
  const colour = state?.colour ?? {}
  const plan = []
  for (const [index, clip] of (state?.clips ?? []).entries()) {
    const src = byId.get(clip.sourceId)
    if (!src) continue // unresolvable source → drop (logged by the worker)
    const effStart = clip.startTime + (clip.trimStart || 0)
    const effEnd = clip.endTime - (clip.trimEnd || 0)
    if (!(effEnd > effStart)) continue // zero/negative window → skip
    plan.push({
      index,
      sourceId: clip.sourceId,
      sourcePath: src.storage_path,
      effStart,
      effEnd,
      colour: colour[rootSegmentId(clip.id)] ?? null,
      muted: !!clip.muted,
      volume: typeof clip.volume === 'number' ? clip.volume : 100,
    })
  }
  if (!plan.length) {
    const err = new Error('nothing_to_render')
    err.code = 'nothing_to_render'
    throw err
  }
  return plan
}

const n3 = (v) => Number(v.toFixed(3)).toString()

// Colour → ffmpeg -vf chain (or null when neutral). Mirrors the CSS preview:
// brightness ×(1+b/200), contrast ×(1+c/200) [eq pivots mid-grey like CSS],
// saturation ×(1+s/100), zoom center-crop (1/z), rotate deg→rad. The final
// scale+pad to the canonical frame is appended by clipFfmpegArgs (always).
export function colourToVf(colour, _out = OUTPUT) {
  if (!colour) return null
  const { brightness = 0, contrast = 0, saturation = 0, zoom = 100, rotate = 0 } = colour
  if (brightness === 0 && contrast === 0 && saturation === 0 && zoom === 100 && rotate === 0) return null
  const parts = []
  if (brightness !== 0) {
    const b = n3(1 + brightness / 200)
    parts.push(`lutrgb=r=clip(val*${b}\\,0\\,255):g=clip(val*${b}\\,0\\,255):b=clip(val*${b}\\,0\\,255)`)
  }
  if (contrast !== 0 || saturation !== 0) {
    parts.push(`eq=contrast=${n3(1 + contrast / 200)}:saturation=${n3(1 + saturation / 100)}`)
  }
  if (zoom !== 100) parts.push(`crop=iw/${n3(zoom / 100)}:ih/${n3(zoom / 100)}`)
  if (rotate !== 0) parts.push(`rotate=${rotate}*PI/180:fillcolor=black`)
  return parts.join(',')
}

// Full execFile arg array for ONE clip → an intermediate mp4 normalised to the
// canonical size/fps/codec so the final concat is a stream copy.
export function clipFfmpegArgs(entry, outFile, out = OUTPUT) {
  const colourVf = colourToVf(entry.colour, out)
  const fit = `scale=${out.w}:${out.h}:force_original_aspect_ratio=decrease,pad=${out.w}:${out.h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${out.fps}`
  const vf = colourVf ? `${colourVf},${fit}` : fit
  const args = ['-y', '-ss', String(entry.effStart), '-to', String(entry.effEnd), '-i', entry.sourcePath, '-vf', vf]
  if (entry.muted) {
    args.push('-an')
  } else if (entry.volume !== 100) {
    args.push('-af', `volume=${n3(entry.volume / 100)}`)
  }
  args.push('-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-r', String(out.fps), '-c:a', 'aac', outFile)
  return args
}
```

- [ ] **Step 4: Run to verify it passes** — `cd server && npx vitest run src/services/renderPlan.test.js` → PASS.
- [ ] **Step 5: Commit** `git add server/src/services/renderPlan.js server/src/services/renderPlan.test.js && git commit -m "feat(server): pure render-plan + colour filter + clip ffmpeg args"`

---

### Task 3: `renderData.js` — load the project's source videos

**Files:** Create `server/src/services/renderData.js` + `renderData.test.js`.

- [ ] **Step 1 (TEST):** `loadProjectSources(supabase, projectId)` returns `[{ id, storage_path }]` for the project's `ready` videos (a fake supabase routing `videos` select).
- [ ] **Step 2 (IMPL):**

```javascript
// Source originals for a project's render: the ready videos whose clips the EDL
// references. Returns [{ id, storage_path }]. Project-scoped.
export async function loadProjectSources(supabase, projectId) {
  const { data, error } = await supabase
    .from('videos')
    .select('id, storage_path, status')
    .eq('project_id', projectId)
    .eq('status', 'ready')
  if (error) throw new Error(`sources_query_failed: ${error.message}`)
  return (data ?? []).map((v) => ({ id: v.id, storage_path: v.storage_path }))
}
```

- [ ] **Step 3:** test passes. **Commit.**

---

### Task 4: `renderVideo.js` worker

**Files:** Create `server/src/services/renderVideo.js` + `renderVideo.test.js`.

- [ ] **Step 1 (TEST):** with an injected fake `runFfmpeg` + fake supabase (storage download/upload + renders update + loadLatestState + loadProjectSources injected): asserts it downloads each distinct source once, calls `runFfmpeg` per clip + once for concat, uploads to `${projectId}/renders/${renderId}.mp4`, sets `renders.status='ready'` + `output_path`. A `runFfmpeg` throw → sets `status='failed'` + error.

```javascript
import { describe, it, expect, vi } from 'vitest'
import { renderVideo } from './renderVideo.js'

function makeSupabase({ state, sources }) {
  const updates = []
  const uploads = []
  return {
    updates, uploads,
    from: () => ({ update: (patch) => ({ eq: async (_c, id) => { updates.push({ id, patch }); return { error: null } } }) }),
    storage: { from: () => ({
      download: async () => ({ data: { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }, error: null }),
      upload: async (path) => { uploads.push(path); return { error: null } },
    }) },
    _state: state, _sources: sources,
  }
}

const STATE = { clips: [{ id: 's1', sourceId: 'v1', startTime: 0, endTime: 2, trimStart: 0, trimEnd: 0 }], colour: {} }
const SOURCES = [{ id: 'v1', storage_path: 'p1/v1/original.mp4' }]

it('renders each clip, concats, uploads, marks ready', async () => {
  const supabase = makeSupabase({})
  const runFfmpeg = vi.fn(async () => {})
  await renderVideo({
    supabase, runFfmpeg, projectId: 'p1', renderId: 'r1',
    loadState: async () => ({ version: 4, state: STATE }),
    loadSources: async () => SOURCES,
    workdir: '/tmp/x', writeFile: vi.fn(async () => {}), rm: vi.fn(async () => {}),
  })
  expect(runFfmpeg).toHaveBeenCalledTimes(2) // 1 clip + 1 concat
  expect(supabase.uploads[0]).toBe('p1/renders/r1.mp4')
  const ready = supabase.updates.find((u) => u.patch.status === 'ready')
  expect(ready.patch.output_path).toBe('p1/renders/r1.mp4')
})

it('marks failed on an ffmpeg error', async () => {
  const supabase = makeSupabase({})
  await expect(renderVideo({
    supabase, runFfmpeg: vi.fn(async () => { throw new Error('boom') }),
    projectId: 'p1', renderId: 'r1',
    loadState: async () => ({ version: 1, state: STATE }), loadSources: async () => SOURCES,
    workdir: '/tmp/x', writeFile: vi.fn(async () => {}), rm: vi.fn(async () => {}),
  })).rejects.toThrow()
  expect(supabase.updates.some((u) => u.patch.status === 'failed')).toBe(true)
})
```

- [ ] **Step 2 (IMPL):** the worker (mirrors `processVideo.js` shape; injectable IO for tests):

```javascript
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'
import { buildRenderPlan, clipFfmpegArgs, OUTPUT } from './renderPlan.js'
import { loadLatestState } from './stateStore.js' // see note below

const execFileAsync = promisify(execFile)
const EXEC_OPTS = { maxBuffer: 10 * 1024 * 1024 }
const defaultRunFfmpeg = (args) => execFileAsync(ffmpegPath, args, EXEC_OPTS)

export async function renderVideo(opts) {
  const {
    supabase, projectId, renderId,
    runFfmpeg = defaultRunFfmpeg,
    loadState, loadSources,
    workdir, writeFile = fs.writeFile, rm = fs.rm,
    log = () => {},
  } = opts
  const dir = workdir ?? (await fs.mkdtemp(path.join(os.tmpdir(), `vca-render-${renderId}-`)))
  const setRender = (patch) => supabase.from('renders').update(patch).eq('id', renderId)
  try {
    const { state } = await loadState(supabase, projectId)
    const sources = await loadSources(supabase, projectId)
    const plan = buildRenderPlan(state, sources) // throws nothing_to_render

    // download each distinct source once
    const localBySource = new Map()
    for (const e of plan) {
      if (localBySource.has(e.sourceId)) continue
      const { data: blob, error } = await supabase.storage.from('videos').download(e.sourcePath)
      if (error || !blob) throw new Error(`source_download_failed: ${e.sourceId}`)
      const file = path.join(dir, `src_${localBySource.size}.mp4`)
      await writeFile(file, Buffer.from(await blob.arrayBuffer()))
      localBySource.set(e.sourceId, file)
    }

    // render each clip to an intermediate normalised mp4
    const clipFiles = []
    for (const [i, e] of plan.entries()) {
      const outFile = path.join(dir, `clip_${String(i).padStart(3, '0')}.mp4`)
      await runFfmpeg(clipFfmpegArgs({ ...e, sourcePath: localBySource.get(e.sourceId) }, outFile))
      clipFiles.push(outFile)
      log(`rendered clip ${i + 1}/${plan.length}`)
    }

    // concat (stream copy — identical params)
    const listFile = path.join(dir, 'concat.txt')
    await writeFile(listFile, clipFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'))
    const outFile = path.join(dir, 'out.mp4')
    await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outFile])

    const outputPath = `${projectId}/renders/${renderId}.mp4`
    const bytes = await fs.readFile(outFile)
    const up = await supabase.storage.from('videos').upload(outputPath, bytes, { contentType: 'video/mp4', upsert: true })
    if (up.error) throw new Error(`upload_failed: ${up.error.message}`)

    await setRender({ status: 'ready', output_path: outputPath })
  } catch (err) {
    await setRender({ status: 'failed', error: String(err?.message ?? err) })
    throw err
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
```

> **Note on `loadState`/`loadSources` injection:** the route passes `loadState = (sb, pid) => loadLatestState(sb, pid)` (server copy — add a tiny `server/src/services/stateStore.js` exporting `loadLatestState(supabase, projectId)` that selects the latest `project_state` row, mirroring the web one) and `loadSources = loadProjectSources`. Keeping them injected makes `renderVideo` unit-testable without DB.

- [ ] **Step 3:** add `server/src/services/stateStore.js` with `loadLatestState(supabase, projectId)` (select `version, state` from `project_state` order by version desc limit 1 maybeSingle) + a small test.
- [ ] **Step 4:** tests pass. **Commit.**

---

### Task 5: Route `POST /api/projects/:id/render` + mount + recoverInterrupted

**Files:** Create `server/src/routes/render.js` + `render.test.js`; edit `server/src/app.js`, `server/src/services/processVideo.js`.

- [ ] **Step 1 (TEST):** `render.test.js` (own express app, like `suggest.test.js`): 401 unauth; 404 unknown project; 403 non-member; 409 when a `rendering` row exists; 400 when the EDL is empty (`buildRenderPlan` throws → injected `startRender` rejects `nothing_to_render`); 202 `{ renderId }` happy path inserts a `renders` row and calls the worker.
- [ ] **Step 2 (IMPL):** `render.js`:

```javascript
import { Router } from 'express'
import { makeRequireAuth } from '../middleware/requireAuth.js'
import { renderVideo } from '../services/renderVideo.js'
import { loadLatestState } from '../services/stateStore.js'
import { loadProjectSources } from '../services/renderData.js'
import { buildRenderPlan } from '../services/renderPlan.js'

export function makeRenderRoutes(supabase, deps = {}) {
  const { render = renderVideo, loadState = loadLatestState, loadSources = loadProjectSources } = deps
  const router = Router()
  const requireAuth = makeRequireAuth(supabase)

  router.post('/api/projects/:id/render', requireAuth, async (req, res) => {
    const { data: project } = await supabase.from('projects').select('id').eq('id', req.params.id).single()
    if (!project) return res.status(404).json({ error: 'project_not_found' })
    const { data: member } = await supabase.from('project_members').select('user_id')
      .eq('project_id', project.id).eq('user_id', req.user.id).maybeSingle()
    if (!member) return res.status(403).json({ error: 'not_a_member' })

    // single-flight: reject if a render is already in flight for this project
    const { data: inflight } = await supabase.from('renders').select('id')
      .eq('project_id', project.id).eq('status', 'rendering').limit(1)
    if (inflight?.length) return res.status(409).json({ error: 'already_rendering' })

    // validate the EDL is renderable BEFORE inserting a job row
    let edlVersion = null
    try {
      const latest = await loadState(supabase, project.id)
      const sources = await loadSources(supabase, project.id)
      buildRenderPlan(latest?.state ?? {}, sources) // throws nothing_to_render
      edlVersion = latest?.version ?? null
    } catch (err) {
      if (err.code === 'nothing_to_render') return res.status(400).json({ error: 'nothing_to_render' })
      return res.status(500).json({ error: 'server_error' })
    }

    const { data: row, error } = await supabase.from('renders')
      .insert({ project_id: project.id, status: 'rendering', edl_version: edlVersion, created_by: req.user.id })
      .select('id').single()
    if (error || !row) return res.status(500).json({ error: 'render_create_failed' })

    res.status(202).json({ renderId: row.id })
    try {
      await render({ supabase, projectId: project.id, renderId: row.id, loadState, loadSources, log: console.log })
    } catch (err) {
      console.error(`render failed for project ${project.id}:`, err) // status already 'failed'
    }
  })

  return router
}
```

- [ ] **Step 3:** mount in `app.js`: `import { makeRenderRoutes } from './routes/render.js'` + `app.use(makeRenderRoutes(supabaseClient))` (no videoDeps — own deps; tests mount directly).
- [ ] **Step 4:** extend `recoverInterrupted` in `processVideo.js` to also sweep renders:

```javascript
// after the videos sweep, add:
const { data: r } = await supabase.from('renders')
  .update({ status: 'failed', error: 'interrupted_by_restart' })
  .eq('status', 'rendering').select('id')
if (r?.length) log(`marked ${r.length} interrupted render(s) failed`)
```

- [ ] **Step 5:** `cd server && npx vitest run` all green. **Commit.**

---

### Task 6: Client `rendersApi.js` + `projectChannel` subscription

**Files:** Create `web/src/lib/editor/rendersApi.js` + test; edit `web/src/lib/editor/projectChannel.js`.

- [ ] `rendersApi.js`:
  - `requestRender(projectId)` → `serverPost('/api/projects/${projectId}/render')` → `data.renderId`.
  - `latestRender(supabase, projectId)` → newest `renders` row (select, order created_at desc, limit 1, maybeSingle).
  - `renderDownloadUrl(supabase, outputPath)` → `supabase.storage.from('videos').createSignedUrl(outputPath, 3600)` → `data.signedUrl`.
- [ ] `projectChannel.js`: add an `onRenderChange` subscription (`postgres_changes` `*` on `renders` filtered by `project_id`), mirroring the suggestions subscription added in Phase 3b.
- [ ] Tests: `rendersApi.test.js` (fake supabase + mocked serverPost); extend `projectChannel.test.js` with the renders subscription assertion. **Commit.**

---

### Task 7: `EditorPage` wiring + `ExportPanel`

**Files:** Create `web/src/components/editor/ExportPanel.jsx` + test; edit `web/src/pages/EditorPage.jsx`, `web/src/components/editor/CreatorDevice.jsx`.

- [ ] **EditorPage:** state `render` (`{ status, output_path } | null`) + `renderRef`; in `load()` set `latestRender(...)`; subscribe `onRenderChange` → upsert latest + announce status transitions ("Rendering your video…" polite; "Your video is ready to download" / "The render failed — try again" assertive); `onExport()` callback → `requestRender(projectId)` (announce start; on 409 announce "A render is already in progress"); pass `render`, `onExport`, and a `getDownloadUrl` (wraps `renderDownloadUrl`) to the device.
- [ ] **ExportPanel.jsx** (props `{ render, onExport, getDownloadUrl }`): idle → "Export video" button (≥48px, aria-label "Export this project as a video"); rendering → polite live "Rendering your video…" with aria-hidden spinner; ready → a **Download video** link (resolves the signed URL on click/mount); failed → assertive note + retry. Mirror AIAnalysisTriggerCard's a11y (no role="status"; aria-live only where needed).
- [ ] **CreatorDevice:** mount `<ExportPanel … />` (e.g. above the Recent Tasks region); pass the new props through. Helper surface unchanged (read-only).
- [ ] Tests: `ExportPanel.test.jsx` (idle/rendering/ready/failed states + onExport fires once). Keep CreatorDevice tests green (new optional props default safely). **Commit.**

---

### Task 8: ProjectPage export affordance

**Files:** edit `web/src/pages/ProjectPage.jsx`.

- [ ] Next to the existing "Open editor" link (gated on `hasReadyVideo`), add a light "Export latest render / Download" affordance OR just rely on the in-editor panel (keep minimal — a link into the editor is acceptable for v1). Decide during implementation to avoid duplicating render state outside the editor; if it adds complexity, the in-editor ExportPanel is sufficient and this task is a no-op note. **Commit if changed.**

---

### Task 9: `scripts/diag-render.mjs` + run (the quality gate)

**Files:** Create `scripts/diag-render.mjs`.

- [ ] Standalone (like `diag-suggest.mjs`): admin supabase client; arg `<projectId>` (or auto-pick a project with a ready video + project_state); load EDL + sources; run the REAL `renderVideo` against a local temp dir; download the output and write it to `./render-out/<projectId>.mp4`; print the plan summary (clips, ranges, colour) + output path + size. **This is the human quality gate** (watch the MP4: structure + colour fidelity). Also print the per-clip `-vf` so the colour filter can be eyeballed.
- [ ] Run `node --env-file=server/.env scripts/diag-render.mjs` against a real project; **verify the colour grade matches the editor preview** (the one real fidelity check). Iterate `colourToVf` if the brightness/zoom/rotate don't match, re-run. **Commit the script.**

---

### Task 10: e2e + full verify + deploy

**Files:** edit `e2e/editor.spec.mjs`.

- [ ] Add an export flow (after analysis/collab, on a project with clips): creator taps **Export** → status reaches `ready` (generous timeout — live ffmpeg) → a **Download** link appears with a non-empty href. Use `retries:1`.
- [ ] Full verify: `cd server && npx vitest run` · `cd web && npx vitest run` · root `npm run build` · `npm run e2e`.
- [ ] Deploy: push `main` (Railway redeploys the server with the render route + worker; Vercel rebuilds web with the Export UI). Confirm migration 0012 live + the prod `/render` route returns 401 (auth-gated). Tag `phase-4`. Update memory.

---

## Self-Review

**Spec coverage:** renders table + RLS + realtime + bucket size (T1) ✓ · pure EDL→plan + colour filter + clip args (T2) ✓ · source loader (T3) ✓ · async worker re-cut+concat+upload+status (T4) ✓ · route + atomic-claim + 400 empty + recoverInterrupted (T5) ✓ · client api + realtime (T6) ✓ · accessible Export UI + announce (T7) ✓ · ProjectPage (T8, optional) ✓ · diag quality gate incl. colour fidelity (T9) ✓ · e2e + deploy (T10) ✓. Structural + colour only; captions/overlays explicitly deferred.

**Placeholder scan:** the brightness/zoom/rotate ffmpeg filters have a concrete first implementation in `colourToVf`; T9 is the explicit verify-and-refine step for colour fidelity (the one genuine unknown), not a placeholder. No TBD/TODO.

**Type/name consistency:** `buildRenderPlan(state, sources)`, `colourToVf(colour, out)`, `clipFfmpegArgs(entry, outFile, out)`, `OUTPUT`, `loadProjectSources(supabase, projectId)`, `loadLatestState(supabase, projectId)` (server copy), `renderVideo({ supabase, projectId, renderId, runFfmpeg, loadState, loadSources, … })`, `makeRenderRoutes(supabase, { render, loadState, loadSources })`, `requestRender/latestRender/renderDownloadUrl`, `onRenderChange` — used identically across tasks. renders columns snake_case (`output_path`, `edl_version`, `created_by`). Output path `${projectId}/renders/${renderId}.mp4` consistent in worker + route + storage RLS (first path part = project_id).
