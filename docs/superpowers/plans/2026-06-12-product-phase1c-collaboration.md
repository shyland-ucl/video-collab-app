# Phase 1c — Realtime Collaboration & Editor Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Creator and helper edit the project's videos together from two devices in real time — durable shared edit state, persistent helper tasks, synced playback awareness, VQA, and confirm-first AI edits.

**Architecture:** Versioned `project_state` rows (append-only, unique `(project_id, version)`) carry the durable edit state; a `tasks` table carries Ask-Helper requests. One Supabase Realtime channel per project syncs both via postgres_changes, plus presence and broadcast for transient playhead/awareness events. The probe repo's two-device UI (`DecoupledCreatorDevice`/`DecoupledHelperDevice` + `ExplorationMode`) is ported with the WS relay swapped for this channel. A new server endpoint turns natural-language edit requests into ONE validated operation proposal (Gemini, injected-model pattern); the client applies it only after the creator confirms.

**Tech Stack:** Existing monorepo (Vite/React 19/Tailwind 4/Vitest web; Express 5/Vitest server; Supabase CLI). New: `@supabase/supabase-js` Realtime channels (already installed), `@playwright/test` (two-browser smoke). Gemini `gemini-2.5-flash` via existing injected-model pattern.

**Spec:** `docs/superpowers/specs/2026-06-12-product-phase1c-collaboration-design.md`

**Probe repo (port source):** `C:\Users\shyla\OneDrive\Документы\GitHub\video-collab-app\..\video-collab-probe` — frozen; COPY from it, never modify it.

**Operational reminders:** `npx supabase db push --yes` hits the LIVE project. Never stage or commit `scripts/diag-smtp.mjs` (pre-existing local modification). Backend verification: `node --env-file=server/.env scripts/e2e-smoke.mjs`. Direct-to-main commits are the project convention.

---

## File Structure

```
video-collab-app/
  supabase/migrations/0008_project_state_tasks.sql        # Task 1
  scripts/e2e-smoke.mjs                                    # Task 2 (extend: steps 16–17)
  server/src/
    prompts/ai_edit.txt                                    # Task 6
    services/aiEdit.js (+ .test.js)                        # Task 6
    routes/aiEdit.js (+ .test.js)                          # Task 6
    app.js                                                 # Task 6 (mount route)
  web/src/
    lib/editor/
      sceneEditOps.js (+ .test.js)        # Task 3 (copy from probe + characterization tests)
      projectOverview.js (+ .test.js)     # Task 3 (copy + tests)
      stateStore.js (+ .test.js)          # Task 4 (NEW: versioned load/save/rebase, buildInitialState, rootSegmentId)
      projectChannel.js (+ .test.js)      # Task 5 (NEW: Realtime channel wrapper)
      tasksApi.js (+ .test.js)            # Task 4 (NEW: tasks CRUD)
    hooks/                                # Task 7 (copies from probe)
      usePlaybackEngine.js, useSpeechRecognition.js, useTextOverlay.js, useRootInert.js
    services/                             # Task 7 (copies)
      ttsService.js
    utils/earcon.js                       # Task 7 (copy)
    contexts/AccessibilityContext.jsx     # Task 7 (copy, defaults only)
    pages/EditorPage.jsx (+ .test.jsx)    # Task 8 (NEW: role resolution, data load, channel, device host)
    components/editor/
      CreatorDevice.jsx (+ .test.jsx)     # Task 9 (adapted port)
      ExplorationMode.jsx                 # Task 9 (adapted port)
      TaskRequestModal.jsx                # Task 9 (adapted port)
      ConfirmAiEditDialog.jsx             # Task 9 (NEW, small)
      HelperDevice.jsx (+ .test.jsx)      # Task 10 (adapted port)
      ActivityFeed.jsx                    # Task 10 (adapted port)
      EditorTimeline.jsx                  # Task 10 (adapted port of MockEditorVisual)
      TextOverlay.jsx, TextOverlaySettings.jsx, SegmentMarkerPanel.jsx,
      TransportControls.jsx, EditorVideoPlayer.jsx, ProjectUpdateToast.jsx  # Task 10 (ports)
    components/VideosSection.jsx          # Task 11 (retry gating fix from 1b review)
    pages/ProjectPage.jsx                 # Task 8 ("Open editor" button)
    App.jsx                               # Task 8 (route)
  e2e/                                    # Task 12 (Playwright)
    playwright.config.mjs
    setup/globalSetup.mjs
    editor.spec.mjs
```

State shape (everything in `project_state.state`):

```js
{
  clips: [{ id, sourceId /* video_id */, name, startTime, endTime, trimStart, trimEnd, color, muted }],
  captions: [{ id, sceneId, text, startTime, endTime }],
  textOverlays: [{ id, sceneId, text, x, y, fontSize, color }],
  colour: { [sceneId]: { brightness, contrast, saturation, zoom } },
}
```

---

### Task 1: Migration 0008 — project_state + tasks + Realtime publication

**Files:**
- Create: `supabase/migrations/0008_project_state_tasks.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Phase 1c: versioned shared edit state + durable helper tasks

create table public.project_state (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  version integer not null check (version >= 1),
  state jsonb not null,
  updated_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (project_id, version)
);

create index project_state_latest_idx on public.project_state (project_id, version desc);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete cascade,
  text text not null check (char_length(text) between 1 and 500),
  segment_label text,
  status text not null default 'pending'
    check (status in ('pending', 'done', 'needs_discussion', 'cant_do')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index tasks_project_id_idx on public.tasks (project_id);

alter table public.project_state enable row level security;
alter table public.tasks enable row level security;

create policy "members read project_state" on public.project_state
  for select using (public.is_project_member(project_id));

create policy "members append project_state" on public.project_state
  for insert with check (
    public.is_project_member(project_id) and updated_by = auth.uid()
  );

create policy "members read tasks" on public.tasks
  for select using (public.is_project_member(project_id));

create policy "members create tasks" on public.tasks
  for insert with check (
    public.is_project_member(project_id) and created_by = auth.uid()
  );

create policy "members update tasks" on public.tasks
  for update using (public.is_project_member(project_id));

create function public.touch_tasks_updated_at()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.touch_tasks_updated_at() from anon, authenticated, public;

create trigger on_task_updated
  before update on public.tasks
  for each row execute function public.touch_tasks_updated_at();

-- postgres_changes for members (RLS applies to the change stream)
alter publication supabase_realtime add table public.project_state;
alter publication supabase_realtime add table public.tasks;
```

- [ ] **Step 2: Apply** — `npx supabase db push --yes`. Expected: applies cleanly. If the `alter publication` lines fail with a permissions error, run those two statements in the dashboard SQL editor, remove them from the migration, re-push, and note it in the commit message.

- [ ] **Step 3: Verify** — `npx supabase migration list` shows 0008 Local=Remote. Dashboard → Database → Replication shows both tables in the `supabase_realtime` publication.

- [ ] **Step 4: Commit** — `git add supabase/migrations` ; `git commit -m "feat(db): versioned project_state and tasks tables with member RLS + realtime publication"`

---

### Task 2: Extend the live E2E smoke — project_state/tasks RLS + version collision

**Files:**
- Modify: `scripts/e2e-smoke.mjs`

READ the whole script first; it already has creator/helper/outsider users and `assert(condition, step, successDetail, failDetail)` helpers. Add the following INSIDE `runTests()` after Step 15, plus cleanup notes.

- [ ] **Step 1: Add Step 16 (project_state)**

```js
// -------------------------------------------------------------------------
// Step 16 — project_state: member append/read, version collision, outsider blocked
// -------------------------------------------------------------------------
{
  const state = { clips: [], captions: [], textOverlays: [], colour: {} };
  const { error: insErr } = await creatorClient.from('project_state').insert({
    project_id: projectId, version: 1, state, updated_by: creatorId,
  });
  assert(!insErr, '16a: member appends project_state v1', 'version=1', insErr?.message);

  const { error: dupErr } = await helperClient.from('project_state').insert({
    project_id: projectId, version: 1, state, updated_by: helperId,
  });
  assert(dupErr?.code === '23505', '16b: duplicate version rejected (unique collision)', `code=${dupErr?.code}`, dupErr ? `wrong code=${dupErr.code}` : 'expected unique violation');

  const { error: v2Err } = await helperClient.from('project_state').insert({
    project_id: projectId, version: 2, state: { ...state, captions: [{ id: 'c1', sceneId: 's1', text: 'hi', startTime: 0, endTime: 2 }] }, updated_by: helperId,
  });
  assert(!v2Err, '16c: fellow member appends v2', 'version=2', v2Err?.message);

  const { data: latest, error: readErr } = await creatorClient
    .from('project_state').select('version, state').eq('project_id', projectId)
    .order('version', { ascending: false }).limit(1).single();
  assert(!readErr && latest?.version === 2 && latest?.state?.captions?.length === 1,
    '16d: member reads latest version', `version=${latest?.version}`, readErr?.message ?? JSON.stringify(latest));

  const { data: outsiderRead } = await outsiderClient
    .from('project_state').select('id').eq('project_id', projectId);
  assert(outsiderRead?.length === 0, '16e: outsider sees 0 project_state rows', 'RLS hides state', `got ${outsiderRead?.length}`);

  const { error: spoofErr } = await creatorClient.from('project_state').insert({
    project_id: projectId, version: 3, state, updated_by: helperId,
  });
  assert(spoofErr !== null, '16f: cannot append as someone else (updated_by check)', `code=${spoofErr?.code}`, 'expected RLS error');
}
```

- [ ] **Step 2: Add Step 17 (tasks)**

```js
// -------------------------------------------------------------------------
// Step 17 — tasks: create, status update, outsider blocked
// -------------------------------------------------------------------------
{
  const { data: task, error: tErr } = await creatorClient.from('tasks').insert({
    project_id: projectId, created_by: creatorId, text: 'Trim the shaky part', segment_label: 'Scene 1',
  }).select().single();
  assert(!tErr && task?.status === 'pending', '17a: creator creates task', `id=${task?.id}`, tErr?.message);

  const { data: updated, error: uErr } = await helperClient.from('tasks')
    .update({ status: 'done' }).eq('id', task.id).select().single();
  assert(!uErr && updated?.status === 'done' && updated?.updated_at !== updated?.created_at,
    '17b: helper marks task done (updated_at touched)', `status=${updated?.status}`, uErr?.message ?? JSON.stringify(updated));

  const { data: outsiderTasks } = await outsiderClient.from('tasks').select('id').eq('project_id', projectId);
  assert(outsiderTasks?.length === 0, '17c: outsider sees 0 tasks', 'RLS hides tasks', `got ${outsiderTasks?.length}`);

  const { error: badStatusErr } = await helperClient.from('tasks')
    .update({ status: 'nonsense' }).eq('id', task.id);
  assert(badStatusErr !== null, '17d: invalid status rejected (check constraint)', `code=${badStatusErr?.code}`, 'expected check violation');
}
```

- [ ] **Step 3: Cleanup** — no new cleanup steps needed: the existing C3 project delete cascades `project_state` and `tasks`. Add a comment saying so next to C3.

- [ ] **Step 4: Run live** — `node --env-file=server/.env scripts/e2e-smoke.mjs`. Expected: previous 43 + 10 new = 53 passed, 0 failed.

- [ ] **Step 5: Commit** — `git add scripts/e2e-smoke.mjs` ; `git commit -m "test: E2E smoke covers project_state versioning and tasks RLS"`

---

### Task 3: Port the pure edit-logic utils with characterization tests

**Files:**
- Create: `web/src/lib/editor/sceneEditOps.js` (copy of probe `src/utils/sceneEditOps.js`)
- Create: `web/src/lib/editor/projectOverview.js` (copy of probe `src/utils/projectOverview.js`)
- Test: `web/src/lib/editor/sceneEditOps.test.js`, `web/src/lib/editor/projectOverview.test.js`

- [ ] **Step 1: Copy both files verbatim**

```powershell
New-Item -ItemType Directory "web\src\lib\editor" -Force
Copy-Item "..\video-collab-probe\src\utils\sceneEditOps.js" "web\src\lib\editor\sceneEditOps.js"
Copy-Item "..\video-collab-probe\src\utils\projectOverview.js" "web\src\lib\editor\projectOverview.js"
```

Read both copies end to end. Fix any imports that point at probe-only modules (if either imports `eventTypes.js` or similar, copy that dependency into `web/src/lib/editor/` too, or inline the constants — report what you did). They must not import anything outside `web/src/lib/editor/`.

- [ ] **Step 2: Write characterization tests (failing only if the copy is broken).** The exports are: `trimClipStart/trimClipEnd(editState, sceneId, direction)`, `splitClip(editState, sceneId, splitTime)`, `moveClip(editState, sceneId, direction)`, `addCaption(editState, sceneId, text)`, `deleteClip(editState, sceneId)`, `applyOperation(editState, sceneId, operation, options)`, plus getters. READ the function bodies first and write tests asserting their REAL behavior (characterization), covering at minimum — `sceneEditOps.test.js`:

```js
import { describe, it, expect } from 'vitest'
import {
  splitClip, moveClip, deleteClip, addCaption,
  trimClipStart, trimClipEnd, applyOperation, getClipForScene,
} from './sceneEditOps'

function makeState() {
  return {
    clips: [
      { id: 's1', sourceId: 'v1', name: 'Scene 1', startTime: 0, endTime: 5, trimStart: 0, trimEnd: 0, color: '#aaa', muted: false },
      { id: 's2', sourceId: 'v1', name: 'Scene 2', startTime: 5, endTime: 10, trimStart: 0, trimEnd: 0, color: '#bbb', muted: false },
    ],
    captions: [],
    textOverlays: [],
    sources: [{ id: 'v1', name: 'vid', src: 'blob:x', duration: 10 }],
  }
}

describe('sceneEditOps (characterization of the probe port)', () => {
  it('deleteClip removes the clip and leaves others', () => {
    const next = deleteClip(makeState(), 's1')
    expect(next.clips.map((c) => c.id)).toEqual(['s2'])
  })

  it('deleteClip does not mutate the input state', () => {
    const state = makeState()
    deleteClip(state, 's1')
    expect(state.clips).toHaveLength(2)
  })

  it('moveClip swaps adjacent clips', () => {
    const next = moveClip(makeState(), 's2', 'earlier')
    expect(next.clips.map((c) => c.id)).toEqual(['s2', 's1'])
  })

  it('moveClip at the boundary is a no-op (or returns same order)', () => {
    const next = moveClip(makeState(), 's1', 'earlier')
    expect(next.clips.map((c) => c.id)).toEqual(['s1', 's2'])
  })

  it('splitClip produces two clips covering the original range', () => {
    const next = splitClip(makeState(), 's1', 2)
    const pieces = next.clips.filter((c) => c.id.startsWith('s1'))
    expect(pieces).toHaveLength(2)
    expect(pieces[0].endTime).toBe(2)
    expect(pieces[1].startTime).toBe(2)
  })

  it('addCaption attaches a caption to the scene', () => {
    const next = addCaption(makeState(), 's2', 'hello')
    expect(next.captions).toHaveLength(1)
    expect(next.captions[0]).toMatchObject({ sceneId: 's2', text: 'hello' })
  })

  it('trimClipStart tightens the clip', () => {
    const next = trimClipStart(makeState(), 's1', 'tighten')
    expect(getClipForScene(next, 's1').trimStart).toBeGreaterThan(0)
  })

  it('applyOperation dispatches to the right op', () => {
    const next = applyOperation(makeState(), 's1', 'delete')
    expect(next.clips.map((c) => c.id)).toEqual(['s2'])
  })
})
```

ADAPT the assertions to the real behavior found in Step 1's read (e.g. exact split ids `s1-a`/`s1-b`, exact trim step seconds, the exact `operation` strings `applyOperation` accepts) — then they are characterization, not aspiration. Document the accepted `operation` strings in a comment at the top of the test file (Task 6 and Task 9 depend on this list).

`projectOverview.test.js` — minimum:

```js
import { describe, it, expect } from 'vitest'
import { summarizeEditStateChange, formatDuration, getTimelineDuration } from './projectOverview'

describe('projectOverview (characterization)', () => {
  it('summarizes a deletion', () => {
    const prev = { clips: [{ id: 'a', name: 'Scene 1', startTime: 0, endTime: 5, trimStart: 0, trimEnd: 0 }], captions: [], textOverlays: [] }
    const next = { clips: [], captions: [], textOverlays: [] }
    const summary = summarizeEditStateChange(prev, next, 'Helper')
    expect(JSON.stringify(summary)).toMatch(/Scene 1|deleted|removed/i)
  })

  it('formatDuration renders mm:ss', () => {
    expect(formatDuration(65)).toMatch(/1.*05|1:05/)
  })

  it('getTimelineDuration sums effective clip durations', () => {
    const state = { clips: [{ id: 'a', startTime: 0, endTime: 5, trimStart: 1, trimEnd: 0 }] }
    expect(getTimelineDuration(state)).toBe(4)
  })
})
```
(Adapt to real return shapes after reading the source.)

- [ ] **Step 3: Run** — `npm run test -w web -- --run`. All pass (existing 63 + new).
- [ ] **Step 4: Commit** — `git add web/src/lib/editor` ; `git commit -m "feat(web): port sceneEditOps + projectOverview from probe with characterization tests"`

---

### Task 4: stateStore (versioned load/save/rebase) + tasksApi

**Files:**
- Create: `web/src/lib/editor/stateStore.js`, `web/src/lib/editor/tasksApi.js`
- Test: `web/src/lib/editor/stateStore.test.js`, `web/src/lib/editor/tasksApi.test.js`

- [ ] **Step 1: Write the failing stateStore test**

```js
import { describe, it, expect, vi } from 'vitest'
import { buildInitialState, rootSegmentId, loadLatestState, saveState, saveWithRebase, SCENE_COLORS } from './stateStore'

const VIDEOS = [
  { id: 'v1', created_at: '2026-06-01', original_name: 'a.mp4' },
  { id: 'v2', created_at: '2026-06-02', original_name: 'b.mp4' },
]
const SEGMENTS = [
  { id: 'g2', video_id: 'v2', idx: 1, label: 'Scene 1', start_seconds: 0, end_seconds: 5 },
  { id: 'g1a', video_id: 'v1', idx: 1, label: 'Scene 1', start_seconds: 0, end_seconds: 5 },
  { id: 'g1b', video_id: 'v1', idx: 2, label: 'Scene 2', start_seconds: 5, end_seconds: 8 },
]

describe('buildInitialState', () => {
  it('orders clips by video created_at then idx, names them sequentially', () => {
    const state = buildInitialState(VIDEOS, SEGMENTS)
    expect(state.clips.map((c) => c.id)).toEqual(['g1a', 'g1b', 'g2'])
    expect(state.clips.map((c) => c.name)).toEqual(['Scene 1', 'Scene 2', 'Scene 3'])
    expect(state.clips[0]).toMatchObject({
      sourceId: 'v1', startTime: 0, endTime: 5, trimStart: 0, trimEnd: 0, muted: false,
    })
    expect(SCENE_COLORS).toContain(state.clips[0].color)
    expect(state.captions).toEqual([])
    expect(state.textOverlays).toEqual([])
    expect(state.colour).toEqual({})
  })
})

describe('rootSegmentId', () => {
  it('strips split suffixes back to the original segment id', () => {
    expect(rootSegmentId('g1a-a-b')).toBe('g1a')
    expect(rootSegmentId('g1a')).toBe('g1a')
  })
})

function fakeSupabase({ latestRows = [], insertError = null } = {}) {
  const inserts = []
  return {
    inserts,
    from: (table) => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => ({
              maybeSingle: async () => ({ data: latestRows[0] ?? null, error: null }),
            }),
          }),
        }),
      }),
      insert: (row) => {
        inserts.push({ table, row })
        return { select: () => ({ single: async () => insertError ? { data: null, error: insertError } : { data: row, error: null } }) }
      },
    }),
  }
}

describe('loadLatestState / saveState', () => {
  it('returns null when no state exists', async () => {
    expect(await loadLatestState(fakeSupabase(), 'p1')).toBeNull()
  })

  it('saves version expected+1 with updated_by', async () => {
    const supabase = fakeSupabase()
    const result = await saveState(supabase, 'p1', 'u1', { clips: [] }, 3)
    expect(result).toEqual({ ok: true, version: 4 })
    expect(supabase.inserts[0].row).toMatchObject({ project_id: 'p1', version: 4, updated_by: 'u1' })
  })

  it('reports a conflict on unique violation', async () => {
    const supabase = fakeSupabase({ insertError: { code: '23505', message: 'dup' } })
    const result = await saveState(supabase, 'p1', 'u1', { clips: [] }, 3)
    expect(result).toEqual({ ok: false, conflict: true })
  })
})

describe('saveWithRebase', () => {
  it('on conflict reloads latest, reapplies the op, retries once', async () => {
    let call = 0
    const applied = []
    const supabase = {
      from: (table) => ({
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: { version: 7, state: { clips: ['remote'] } }, error: null }),
              }),
            }),
          }),
        }),
        insert: (row) => ({
          select: () => ({
            single: async () => {
              call += 1
              if (call === 1) return { data: null, error: { code: '23505', message: 'dup' } }
              return { data: row, error: null }
            },
          }),
        }),
      }),
    }
    const applyOp = vi.fn((state) => { applied.push(state); return { ...state, reapplied: true } })
    const result = await saveWithRebase(supabase, 'p1', 'u1', applyOp, { clips: ['local'] }, 5)
    expect(result.ok).toBe(true)
    expect(result.version).toBe(8)
    expect(applyOp).toHaveBeenCalledWith({ clips: ['remote'] })
    expect(result.state).toMatchObject({ reapplied: true })
  })
})
```

- [ ] **Step 2: Run to verify it fails** — cannot resolve `./stateStore`.

- [ ] **Step 3: Write `web/src/lib/editor/stateStore.js`**

```js
export const SCENE_COLORS = ['#E74C3C', '#3498DB', '#2ECC71', '#9B59B6', '#E67E22', '#16A085', '#D35400', '#2C3E50']

export function buildInitialState(videos, segments) {
  const videoOrder = [...videos].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
  const orderIndex = new Map(videoOrder.map((v, i) => [v.id, i]))
  const ordered = [...segments].sort(
    (a, b) => (orderIndex.get(a.video_id) - orderIndex.get(b.video_id)) || (a.idx - b.idx)
  )
  return {
    clips: ordered.map((seg, i) => ({
      id: seg.id,
      sourceId: seg.video_id,
      name: `Scene ${i + 1}`,
      startTime: Number(seg.start_seconds),
      endTime: Number(seg.end_seconds),
      trimStart: 0,
      trimEnd: 0,
      color: SCENE_COLORS[i % SCENE_COLORS.length],
      muted: false,
    })),
    captions: [],
    textOverlays: [],
    colour: {},
  }
}

// Split clips get '-a'/'-b' suffixes; descriptions live on the root segment.
export function rootSegmentId(clipId) {
  return clipId.replace(/(-[ab])+$/, '')
}

export async function loadLatestState(supabase, projectId) {
  const { data } = await supabase
    .from('project_state')
    .select('version, state')
    .eq('project_id', projectId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data ?? null
}

export async function saveState(supabase, projectId, userId, state, expectedVersion) {
  const version = (expectedVersion ?? 0) + 1
  const { error } = await supabase
    .from('project_state')
    .insert({ project_id: projectId, version, state, updated_by: userId })
    .select()
    .single()
  if (error?.code === '23505') return { ok: false, conflict: true }
  if (error) return { ok: false, error: error.message }
  return { ok: true, version }
}

// applyOp(state) must be a pure function that re-derives the local change on
// top of any state — that is what makes the rebase correct.
export async function saveWithRebase(supabase, projectId, userId, applyOp, localState, expectedVersion) {
  const first = await saveState(supabase, projectId, userId, localState, expectedVersion)
  if (first.ok) return { ...first, state: localState }
  if (!first.conflict) return first

  const latest = await loadLatestState(supabase, projectId)
  if (!latest) return { ok: false, error: 'state_vanished' }
  const rebased = applyOp(latest.state)
  const second = await saveState(supabase, projectId, userId, rebased, latest.version)
  if (second.ok) return { ...second, state: rebased }
  return { ok: false, conflict: true, latest }
}
```

- [ ] **Step 4: Write the failing tasksApi test**

```js
import { describe, it, expect, vi } from 'vitest'
import { createTask, setTaskStatus, listTasks } from './tasksApi'

function fakeSupabase() {
  const calls = []
  return {
    calls,
    from: (table) => ({
      insert: (row) => ({ select: () => ({ single: async () => { calls.push({ op: 'insert', table, row }); return { data: { id: 't1', ...row, status: 'pending' }, error: null } } }) }),
      update: (patch) => ({ eq: (col, val) => ({ select: () => ({ single: async () => { calls.push({ op: 'update', table, patch, col, val }); return { data: { id: val, ...patch }, error: null } } }) }) }),
      select: () => ({ eq: () => ({ order: async () => { calls.push({ op: 'list', table }); return { data: [], error: null } } }) }),
    }),
  }
}

describe('tasksApi', () => {
  it('creates a task with creator + label', async () => {
    const supabase = fakeSupabase()
    const task = await createTask(supabase, { projectId: 'p1', userId: 'u1', text: 'Trim it', segmentLabel: 'Scene 2' })
    expect(task.status).toBe('pending')
    expect(supabase.calls[0].row).toMatchObject({ project_id: 'p1', created_by: 'u1', text: 'Trim it', segment_label: 'Scene 2' })
  })

  it('updates status', async () => {
    const supabase = fakeSupabase()
    const task = await setTaskStatus(supabase, 't9', 'done')
    expect(task.status).toBe('done')
    expect(supabase.calls[0]).toMatchObject({ op: 'update', col: 'id', val: 't9', patch: { status: 'done' } })
  })

  it('lists project tasks newest first', async () => {
    const supabase = fakeSupabase()
    await listTasks(supabase, 'p1')
    expect(supabase.calls[0]).toMatchObject({ op: 'list', table: 'tasks' })
  })
})
```

- [ ] **Step 5: Write `web/src/lib/editor/tasksApi.js`**

```js
export async function createTask(supabase, { projectId, userId, text, segmentLabel }) {
  const { data, error } = await supabase
    .from('tasks')
    .insert({ project_id: projectId, created_by: userId, text, segment_label: segmentLabel ?? null })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function setTaskStatus(supabase, taskId, status) {
  const { data, error } = await supabase
    .from('tasks')
    .update({ status })
    .eq('id', taskId)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function listTasks(supabase, projectId) {
  const { data, error } = await supabase
    .from('tasks')
    .select('id, text, segment_label, status, created_by, created_at, updated_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data ?? []
}
```

(If the fake's `.order()` shape mismatches — it is awaited directly — adjust the fake, not the lib.)

- [ ] **Step 6: Run all web tests; commit** — `git add web/src/lib/editor` ; `git commit -m "feat(web): versioned state store with conflict rebase + tasks api"`

---

### Task 5: projectChannel — Realtime wrapper (presence + postgres_changes + broadcast)

**Files:**
- Create: `web/src/lib/editor/projectChannel.js`
- Test: `web/src/lib/editor/projectChannel.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { joinProjectChannel, PLAYHEAD_THROTTLE_MS } from './projectChannel'

function fakeChannel() {
  const handlers = { broadcast: {}, postgres: [], presence: {} }
  const sent = []
  const channel = {
    handlers, sent,
    on: vi.fn((type, filter, cb) => {
      if (type === 'broadcast') handlers.broadcast[filter.event] = cb
      if (type === 'postgres_changes') handlers.postgres.push({ filter, cb })
      if (type === 'presence') handlers.presence[filter.event] = cb
      return channel
    }),
    subscribe: vi.fn((cb) => { channel.statusCb = cb; cb?.('SUBSCRIBED'); return channel }),
    send: vi.fn(async (msg) => { sent.push(msg) }),
    track: vi.fn(async () => {}),
    presenceState: vi.fn(() => ({})),
    unsubscribe: vi.fn(async () => {}),
  }
  return channel
}

function fakeSupabase(channel) {
  return { channel: vi.fn(() => channel), removeChannel: vi.fn() }
}

describe('joinProjectChannel', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('subscribes to state inserts, task changes, presence, and broadcasts', async () => {
    const channel = fakeChannel()
    const onStateInsert = vi.fn()
    const onTaskChange = vi.fn()
    const handle = joinProjectChannel(fakeSupabase(channel), {
      projectId: 'p1', userId: 'u1', role: 'creator',
      onStateInsert, onTaskChange, onPresence: vi.fn(), onPlayhead: vi.fn(), onTransport: vi.fn(), onActivity: vi.fn(),
    })

    const stateSub = channel.handlers.postgres.find((h) => h.filter.table === 'project_state')
    expect(stateSub.filter).toMatchObject({ event: 'INSERT', schema: 'public', filter: 'project_id=eq.p1' })
    stateSub.cb({ new: { version: 3, state: { clips: [] }, updated_by: 'u2' } })
    expect(onStateInsert).toHaveBeenCalledWith({ version: 3, state: { clips: [] }, updated_by: 'u2' })

    const taskSub = channel.handlers.postgres.find((h) => h.filter.table === 'tasks')
    expect(taskSub.filter).toMatchObject({ event: '*', filter: 'project_id=eq.p1' })
    taskSub.cb({ eventType: 'UPDATE', new: { id: 't1', status: 'done' } })
    expect(onTaskChange).toHaveBeenCalledWith({ eventType: 'UPDATE', task: { id: 't1', status: 'done' } })

    expect(channel.track).toHaveBeenCalledWith({ userId: 'u1', role: 'creator' })
    expect(typeof handle.leave).toBe('function')
  })

  it('throttles playhead broadcasts and never throttles transport', async () => {
    const channel = fakeChannel()
    const handle = joinProjectChannel(fakeSupabase(channel), {
      projectId: 'p1', userId: 'u1', role: 'creator',
      onStateInsert: vi.fn(), onTaskChange: vi.fn(), onPresence: vi.fn(), onPlayhead: vi.fn(), onTransport: vi.fn(), onActivity: vi.fn(),
    })

    handle.sendPlayhead({ isPlaying: true, time: 1 })
    handle.sendPlayhead({ isPlaying: true, time: 1.5 })
    expect(channel.sent.filter((m) => m.event === 'playhead')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(PLAYHEAD_THROTTLE_MS + 10)
    handle.sendPlayhead({ isPlaying: true, time: 3 })
    expect(channel.sent.filter((m) => m.event === 'playhead')).toHaveLength(2)

    handle.sendTransport({ action: 'pause', time: 3 })
    handle.sendTransport({ action: 'play', time: 3 })
    expect(channel.sent.filter((m) => m.event === 'transport')).toHaveLength(2)
  })

  it('routes incoming broadcasts to the right callbacks', () => {
    const channel = fakeChannel()
    const onPlayhead = vi.fn(); const onTransport = vi.fn(); const onActivity = vi.fn()
    joinProjectChannel(fakeSupabase(channel), {
      projectId: 'p1', userId: 'u1', role: 'helper',
      onStateInsert: vi.fn(), onTaskChange: vi.fn(), onPresence: vi.fn(), onPlayhead, onTransport, onActivity,
    })
    channel.handlers.broadcast.playhead({ payload: { time: 9 } })
    channel.handlers.broadcast.transport({ payload: { action: 'seek', time: 4 } })
    channel.handlers.broadcast.activity({ payload: { action: 'Seeked', detail: '0:45' } })
    expect(onPlayhead).toHaveBeenCalledWith({ time: 9 })
    expect(onTransport).toHaveBeenCalledWith({ action: 'seek', time: 4 })
    expect(onActivity).toHaveBeenCalledWith({ action: 'Seeked', detail: '0:45' })
  })
})
```

- [ ] **Step 2: Run to verify it fails**, then **Step 3: Write `web/src/lib/editor/projectChannel.js`**

```js
export const PLAYHEAD_THROTTLE_MS = 2000

export function joinProjectChannel(supabase, {
  projectId, userId, role,
  onStateInsert, onTaskChange, onPresence, onPlayhead, onTransport, onActivity,
  onReconnect,
}) {
  const channel = supabase.channel(`project:${projectId}`, {
    config: { presence: { key: userId } },
  })

  channel
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'project_state', filter: `project_id=eq.${projectId}` },
      (payload) => onStateInsert?.(payload.new))
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'tasks', filter: `project_id=eq.${projectId}` },
      (payload) => onTaskChange?.({ eventType: payload.eventType, task: payload.new ?? payload.old }))
    .on('presence', { event: 'sync' }, () => onPresence?.(channel.presenceState()))
    .on('broadcast', { event: 'playhead' }, ({ payload }) => onPlayhead?.(payload))
    .on('broadcast', { event: 'transport' }, ({ payload }) => onTransport?.(payload))
    .on('broadcast', { event: 'activity' }, ({ payload }) => onActivity?.(payload))

  let subscribedOnce = false
  channel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      await channel.track({ userId, role })
      if (subscribedOnce) onReconnect?.()
      subscribedOnce = true
    }
  })

  let lastPlayhead = 0
  function sendPlayhead(payload) {
    const now = Date.now()
    if (now - lastPlayhead < PLAYHEAD_THROTTLE_MS) return
    lastPlayhead = now
    channel.send({ type: 'broadcast', event: 'playhead', payload: { ...payload, actor: role } })
  }

  const sendTransport = (payload) =>
    channel.send({ type: 'broadcast', event: 'transport', payload: { ...payload, actor: role } })
  const sendActivity = (payload) =>
    channel.send({ type: 'broadcast', event: 'activity', payload: { ...payload, actor: role } })

  return {
    sendPlayhead,
    sendTransport,
    sendActivity,
    leave: () => supabase.removeChannel(channel),
  }
}
```

(Note `Date.now()` use is in app code — fine; only Workflow scripts ban it. If the throttle test is flaky under fake timers because `Date.now` isn't faked, use `vi.setSystemTime` in the test.)

- [ ] **Step 4: Run; commit** — `git add web/src/lib/editor` ; `git commit -m "feat(web): realtime project channel wrapper (presence, state/task changes, throttled broadcast)"`

---

### Task 6: AI edit endpoint — prompt, service, route

**Files:**
- Create: `server/src/prompts/ai_edit.txt`, `server/src/services/aiEdit.js`, `server/src/routes/aiEdit.js`
- Test: `server/src/services/aiEdit.test.js`, `server/src/routes/aiEdit.test.js`
- Modify: `server/src/app.js` (mount route)

**Proposal contract (shared with Task 9 — keep names exact):**

```js
// success: { op, target_clip_id, params, summary }
//   op ∈ ['delete', 'split', 'move_earlier', 'move_later', 'add_caption', 'trim_start', 'trim_end']
//   params: { caption_text } for add_caption; { direction: 'tighten' | 'loosen' } for trims; {} otherwise
// fallback: { clarification: string }
```

- [ ] **Step 1: Write `server/src/prompts/ai_edit.txt`**

```
You convert a blind or low-vision video creator's spoken editing request into exactly ONE editing operation, or ask for clarification.

You receive a numbered scene list (id, name, duration, what's in it) and the creator's request.

Allowed operations:
- delete: remove a scene
- split: cut a scene into two at its midpoint
- move_earlier / move_later: swap a scene with its neighbour
- add_caption: attach caption text to a scene (params.caption_text required)
- trim_start / trim_end: nudge a scene's start or end (params.direction: "tighten" removes a little, "loosen" restores)

Rules:
- Respond ONLY with valid JSON. No markdown, no explanation outside the JSON.
- Success shape: {"op": "...", "target_clip_id": "...", "params": {...}, "summary": "..."}
- The summary is one spoken sentence describing exactly what will happen, naming the scene (e.g. "I'll delete Scene 3 — the blurry kitchen shot.").
- target_clip_id MUST be one of the ids from the scene list.
- If the request doesn't clearly map to one operation on one scene, respond {"clarification": "..."} asking one short question instead. Never guess.
- If the request asks for something outside the allowed operations (colour, audio, effects), respond with a clarification saying the helper can do that.
```

- [ ] **Step 2: Write the failing service test** — `server/src/services/aiEdit.test.js`

```js
import { describe, it, expect, vi } from 'vitest'
import { buildSceneList, proposeEdit, validateProposal, AI_EDIT_OPS } from './aiEdit.js'

const CLIPS = [
  { id: 'g1', name: 'Scene 1', duration_seconds: 5 },
  { id: 'g2', name: 'Scene 2', duration_seconds: 3 },
]
const DESCRIPTIONS = { g1: 'A person stirs a pot.', g2: 'They taste the food.' }

function fakeModel(text) {
  return { generateContent: vi.fn(async () => ({ response: { text: () => text } })) }
}

describe('buildSceneList', () => {
  it('renders one line per clip with description', () => {
    const list = buildSceneList(CLIPS, DESCRIPTIONS)
    expect(list).toMatch(/g1 \| Scene 1 \| 5s \| A person stirs a pot\./)
    expect(list.split('\n')).toHaveLength(2)
  })
})

describe('validateProposal', () => {
  const ids = new Set(['g1', 'g2'])
  it('accepts a valid delete', () => {
    expect(validateProposal({ op: 'delete', target_clip_id: 'g1', params: {}, summary: 'x' }, ids).ok).toBe(true)
  })
  it('rejects unknown ops, unknown targets, missing caption text', () => {
    expect(validateProposal({ op: 'explode', target_clip_id: 'g1', params: {}, summary: 'x' }, ids).ok).toBe(false)
    expect(validateProposal({ op: 'delete', target_clip_id: 'nope', params: {}, summary: 'x' }, ids).ok).toBe(false)
    expect(validateProposal({ op: 'add_caption', target_clip_id: 'g1', params: {}, summary: 'x' }, ids).ok).toBe(false)
    expect(validateProposal({ op: 'trim_start', target_clip_id: 'g1', params: { direction: 'sideways' }, summary: 'x' }, ids).ok).toBe(false)
  })
  it('accepts a clarification', () => {
    expect(validateProposal({ clarification: 'Which scene?' }, ids).ok).toBe(true)
  })
})

describe('proposeEdit', () => {
  it('returns a validated proposal from clean JSON', async () => {
    const model = fakeModel(JSON.stringify({ op: 'delete', target_clip_id: 'g2', params: {}, summary: 'I will delete Scene 2.' }))
    const result = await proposeEdit(model, 'remove the tasting scene', CLIPS, DESCRIPTIONS)
    expect(result).toMatchObject({ op: 'delete', target_clip_id: 'g2' })
  })

  it('strips markdown fences', async () => {
    const model = fakeModel('```json\n{"clarification":"Which scene do you mean?"}\n```')
    const result = await proposeEdit(model, 'cut it', CLIPS, DESCRIPTIONS)
    expect(result.clarification).toMatch(/Which scene/)
  })

  it('turns junk or invalid proposals into a clarification', async () => {
    const junk = await proposeEdit(fakeModel('I think you should...'), 'x', CLIPS, DESCRIPTIONS)
    expect(junk.clarification).toBeTruthy()
    const badTarget = await proposeEdit(fakeModel(JSON.stringify({ op: 'delete', target_clip_id: 'zzz', params: {}, summary: 's' })), 'x', CLIPS, DESCRIPTIONS)
    expect(badTarget.clarification).toBeTruthy()
  })
})
```

- [ ] **Step 3: Write `server/src/services/aiEdit.js`**

```js
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const promptsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts')

export const AI_EDIT_OPS = ['delete', 'split', 'move_earlier', 'move_later', 'add_caption', 'trim_start', 'trim_end']

export function buildSceneList(clips, descriptionsById) {
  return clips
    .map((c) => `${c.id} | ${c.name} | ${Math.round(c.duration_seconds)}s | ${descriptionsById[c.id] ?? 'no description'}`)
    .join('\n')
}

export function validateProposal(proposal, validIds) {
  if (proposal && typeof proposal.clarification === 'string' && proposal.clarification.trim()) {
    return { ok: true, kind: 'clarification' }
  }
  if (!proposal || !AI_EDIT_OPS.includes(proposal.op)) return { ok: false, reason: 'unknown_op' }
  if (!validIds.has(proposal.target_clip_id)) return { ok: false, reason: 'unknown_target' }
  if (typeof proposal.summary !== 'string' || !proposal.summary.trim()) return { ok: false, reason: 'missing_summary' }
  const params = proposal.params ?? {}
  if (proposal.op === 'add_caption' && !(typeof params.caption_text === 'string' && params.caption_text.trim())) {
    return { ok: false, reason: 'missing_caption_text' }
  }
  if ((proposal.op === 'trim_start' || proposal.op === 'trim_end') && !['tighten', 'loosen'].includes(params.direction)) {
    return { ok: false, reason: 'bad_trim_direction' }
  }
  return { ok: true, kind: 'proposal' }
}

function parseJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```[\s\S]*$/, '')
  return JSON.parse(cleaned)
}

export async function proposeEdit(model, request, clips, descriptionsById) {
  const promptTemplate = await fs.readFile(path.join(promptsDir, 'ai_edit.txt'), 'utf-8')
  const sceneList = buildSceneList(clips, descriptionsById)
  const prompt = `${promptTemplate.trim()}\n\nScenes:\n${sceneList}\n\nCreator's request: ${request}\n`

  let proposal
  try {
    const result = await model.generateContent(prompt)
    proposal = parseJson(result.response.text())
  } catch {
    return { clarification: "I couldn't work out an edit for that — could you say it another way?" }
  }

  const verdict = validateProposal(proposal, new Set(clips.map((c) => c.id)))
  if (!verdict.ok) {
    return { clarification: "I couldn't match that to one of the scenes — could you name the scene number?" }
  }
  return proposal
}
```

- [ ] **Step 4: Write the failing route test** — `server/src/routes/aiEdit.test.js`. Reuse the fake-supabase pattern from `server/src/routes/videos.test.js` (read it): `auth.getUser` good/bad token; `from('projects').select().eq().single()` returns the project; `from('project_members')...maybeSingle()` returns member or null; `from('segments').select(...)` for descriptions can return `{ data: [], error: null }`. Tests: 401 without token; 404 unknown project; 403 non-member; 400 missing/over-500-char request or missing/empty clips array; 200 happy path returns the injected `propose` result. Inject via the existing `videoDeps` object (add a `propose` key). Full test:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { makeApp } from '../app.js'

const user = { id: 'user-1', email: 'a@b.c' }

function makeFakeSupabase({ project, member, segments = [] } = {}) {
  return {
    auth: { getUser: vi.fn(async (token) => token === 'good' ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'bad' } }) },
    from: (table) => ({
      select: () => ({
        eq: () => ({
          single: async () => table === 'projects'
            ? (project ? { data: project, error: null } : { data: null, error: { message: 'nf' } })
            : { data: null, error: { message: 'nf' } },
          eq: () => ({ maybeSingle: async () => ({ data: member ?? null, error: null }) }),
        }),
        in: () => ({ data: segments, error: null }),
      }),
    }),
  }
}

const PROJECT = { id: 'p1', title: 'T' }
const MEMBER = { user_id: 'user-1' }
const CLIPS = [{ id: 'g1', name: 'Scene 1', duration_seconds: 5 }]

let proposeSpy
function appWith(supabase, proposeResult = { op: 'delete', target_clip_id: 'g1', params: {}, summary: 'I will delete Scene 1.' }) {
  proposeSpy = vi.fn(async () => proposeResult)
  return makeApp(supabase, { propose: proposeSpy, getModel: () => ({}), process: vi.fn(), vqa: vi.fn() })
}

beforeEach(() => vi.clearAllMocks())

describe('POST /api/projects/:id/ai-edit', () => {
  it('requires auth', async () => {
    const res = await request(appWith(makeFakeSupabase({ project: PROJECT, member: MEMBER })))
      .post('/api/projects/p1/ai-edit').send({ request: 'x', clips: CLIPS })
    expect(res.status).toBe(401)
  })

  it('404s for unknown project, 403s for non-members', async () => {
    const r404 = await request(appWith(makeFakeSupabase({ member: MEMBER })))
      .post('/api/projects/p1/ai-edit').set('Authorization', 'Bearer good').send({ request: 'x', clips: CLIPS })
    expect(r404.status).toBe(404)
    const r403 = await request(appWith(makeFakeSupabase({ project: PROJECT })))
      .post('/api/projects/p1/ai-edit').set('Authorization', 'Bearer good').send({ request: 'x', clips: CLIPS })
    expect(r403.status).toBe(403)
    expect(proposeSpy).not.toHaveBeenCalled()
  })

  it('400s on bad input', async () => {
    const app = appWith(makeFakeSupabase({ project: PROJECT, member: MEMBER }))
    for (const body of [{}, { request: '', clips: CLIPS }, { request: 'x'.repeat(501), clips: CLIPS }, { request: 'x', clips: [] }, { request: 'x' }]) {
      const res = await request(app).post('/api/projects/p1/ai-edit').set('Authorization', 'Bearer good').send(body)
      expect(res.status).toBe(400)
    }
  })

  it('returns the proposal for a member', async () => {
    const res = await request(appWith(makeFakeSupabase({ project: PROJECT, member: MEMBER })))
      .post('/api/projects/p1/ai-edit').set('Authorization', 'Bearer good')
      .send({ request: 'delete scene one', clips: CLIPS })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ op: 'delete', target_clip_id: 'g1' })
    expect(proposeSpy).toHaveBeenCalled()
  })
})
```

- [ ] **Step 5: Write `server/src/routes/aiEdit.js`**

```js
import { Router } from 'express'
import { makeRequireAuth } from '../middleware/requireAuth.js'
import { makeGeminiModel } from '../services/descriptions.js'
import { proposeEdit } from '../services/aiEdit.js'
import { rootSegmentIds, loadLevel1Descriptions } from '../services/aiEditData.js'

export function makeAiEditRoutes(supabase, deps = {}) {
  const { propose = proposeEdit, getModel = makeGeminiModel } = deps
  const router = Router()
  const requireAuth = makeRequireAuth(supabase)

  router.post('/api/projects/:id/ai-edit', requireAuth, async (req, res) => {
    const { data: project } = await supabase
      .from('projects').select('id, title').eq('id', req.params.id).single()
    if (!project) return res.status(404).json({ error: 'project_not_found' })

    const { data: member } = await supabase
      .from('project_members').select('user_id')
      .eq('project_id', project.id).eq('user_id', req.user.id).maybeSingle()
    if (!member) return res.status(403).json({ error: 'not_a_member' })

    const request = String(req.body?.request ?? '').trim()
    const clips = Array.isArray(req.body?.clips) ? req.body.clips : null
    if (!request || request.length > 500 || !clips?.length || clips.length > 200) {
      return res.status(400).json({ error: 'bad_request_body' })
    }
    const cleanClips = clips.map((c) => ({
      id: String(c?.id ?? ''), name: String(c?.name ?? ''), duration_seconds: Number(c?.duration_seconds) || 0,
    })).filter((c) => c.id && c.name)
    if (!cleanClips.length) return res.status(400).json({ error: 'bad_request_body' })

    let model
    try {
      model = getModel()
    } catch {
      return res.status(500).json({ error: 'server_misconfigured' })
    }

    const descriptions = await loadLevel1Descriptions(supabase, rootSegmentIds(cleanClips))
    const proposal = await propose(model, request, cleanClips, descriptions)
    res.json(proposal)
  })

  return router
}
```

And `server/src/services/aiEditData.js` (small, tested inside aiEdit.test.js or its own block):

```js
// Split clips carry '-a'/'-b' suffixes; descriptions live on the root segment id.
export function rootSegmentIds(clips) {
  const map = {}
  for (const c of clips) map[c.id] = c.id.replace(/(-[ab])+$/, '')
  return map
}

export async function loadLevel1Descriptions(supabase, idMap) {
  const rootIds = [...new Set(Object.values(idMap))]
  const { data } = await supabase
    .from('descriptions')
    .select('segment_id, text, level')
    .in('segment_id', rootIds)
  const byRoot = {}
  for (const row of data ?? []) if (row.level === 1) byRoot[row.segment_id] = row.text
  const byClip = {}
  for (const [clipId, rootId] of Object.entries(idMap)) byClip[clipId] = byRoot[rootId]
  return byClip
}
```

Add tests for both functions (fake supabase returning description rows; assert clip-id keyed map and suffix stripping). Note the route test's fake needs `.select().in()` support — shape shown in Step 4's fake (`in: () => ({ data: segments, error: null })` awaited directly; if the real chain is `.select(...).in(...)` returning a thenable, the fake's `in` returning a plain object works under `await`).

- [ ] **Step 6: Mount in `server/src/app.js`** — add `import { makeAiEditRoutes } from './routes/aiEdit.js'` and, after the existing `app.use(makeVideoRoutes(...))` line: `app.use(makeAiEditRoutes(supabaseClient, videoDeps))`.

- [ ] **Step 7: Run all server tests** (existing 40 + new). **Step 8: Commit** — `git add server/src` ; `git commit -m "feat(server): ai-edit endpoint — constrained single-operation proposals with validation"`

---

### Task 7: Port hooks, services, and accessibility context from the probe

**Files (all copies from `..\video-collab-probe\src\`):**
- Create: `web/src/hooks/usePlaybackEngine.js`, `web/src/hooks/useSpeechRecognition.js`, `web/src/hooks/useTextOverlay.js`, `web/src/hooks/useRootInert.js`
- Create: `web/src/services/ttsService.js`, `web/src/utils/earcon.js`
- Create: `web/src/contexts/AccessibilityContext.jsx`
- Test: `web/src/hooks/usePlaybackEngine.test.js` (pure helpers only)

- [ ] **Step 1: Copy**

```powershell
New-Item -ItemType Directory "web\src\hooks", "web\src\services" -Force
Copy-Item "..\video-collab-probe\src\hooks\usePlaybackEngine.js" "web\src\hooks\"
Copy-Item "..\video-collab-probe\src\hooks\useSpeechRecognition.js" "web\src\hooks\"
Copy-Item "..\video-collab-probe\src\hooks\useTextOverlay.js" "web\src\hooks\"
Copy-Item "..\video-collab-probe\src\hooks\useRootInert.js" "web\src\hooks\"
Copy-Item "..\video-collab-probe\src\services\ttsService.js" "web\src\services\"
Copy-Item "..\video-collab-probe\src\utils\earcon.js" "web\src\utils\"
Copy-Item "..\video-collab-probe\src\contexts\AccessibilityContext.jsx" "web\src\contexts\"
```

- [ ] **Step 2: Read EVERY copied file end to end and strip probe-only references.** Per file: remove any import of `EventLoggerContext`, `eventTypes`, condition props, or researcher hooks; fix relative import paths to the new locations (`../utils/announcer` already exists in this repo — reuse it, do NOT duplicate). `AccessibilityContext`: keep `textSize`/`audioEnabled`/`speechRate` with defaults; remove any settings-UI coupling; export the provider + hook only. Report exactly what you stripped from each file.

- [ ] **Step 3: Pure-helper test for the playback engine.** If `usePlaybackEngine.js` exports pure helpers (e.g. layout/EDL-time math), test those directly. If everything is inside the hook, extract the clip-layout computation into an exported pure function `computeClipLayout(clips)` (start offsets + total duration) as part of this task and test:

```js
import { describe, it, expect } from 'vitest'
import { computeClipLayout } from './usePlaybackEngine'

describe('computeClipLayout', () => {
  it('lays clips end to end with trims applied', () => {
    const layout = computeClipLayout([
      { id: 'a', startTime: 0, endTime: 5, trimStart: 1, trimEnd: 0 },
      { id: 'b', startTime: 5, endTime: 10, trimStart: 0, trimEnd: 2 },
    ])
    expect(layout.totalDuration).toBe(7)
    expect(layout.entries[0]).toMatchObject({ id: 'a', edlStart: 0, duration: 4 })
    expect(layout.entries[1]).toMatchObject({ id: 'b', edlStart: 4, duration: 3 })
  })
})
```
(Adapt names to the real internals after reading; keep the hook's behavior identical.)

- [ ] **Step 4: Run web tests (all green, nothing else broken). Step 5: Commit** — `git add web/src/hooks web/src/services web/src/utils/earcon.js web/src/contexts/AccessibilityContext.jsx` ; `git commit -m "feat(web): port playback engine, speech, tts, earcons, a11y context from probe"`

---

### Task 8: EditorPage — route, role resolution, data load, channel wiring

**Files:**
- Create: `web/src/pages/EditorPage.jsx`
- Test: `web/src/pages/EditorPage.test.jsx`
- Modify: `web/src/App.jsx` (route), `web/src/pages/ProjectPage.jsx` (+ its test) ("Open editor" button)

EditorPage responsibilities (one file, ~250 lines; devices stay dumb):
1. Load project + role (`project_members` row for this user → `creator` | `helper`).
2. Load `ready` videos + their segments + ALL descriptions (3 levels, keyed `rootSegmentId`), create signed URLs for originals → `sources` (+ a 50-minute refresh timer that re-creates URLs and swaps `src` values).
3. Load latest `project_state`; if none, `buildInitialState(...)` and save version 1.
4. `joinProjectChannel(...)`: on state insert (version > current, not own echo) → set state, `summarizeEditStateChange(prev, next, actorLabel)` → `announce` + toast; on task change → update tasks list + announce ("Helper marked your task done" / "Creator sent you a task"); on presence → announce join/leave; `onReconnect` → refetch latest state + tasks.
5. Provide `applyAndSave(opFn, announceText)` to devices: optimistic apply → `saveWithRebase` → on final conflict announce "Your change conflicted — the timeline was updated" and resync.
6. Track ready-video count every 60s; if it grew, show "New scenes are available — reload the editor to include them." (`role=status` + announce).
7. Render `<CreatorDevice …/>` or `<HelperDevice …/>` (Task 9/10 — this task renders placeholder stubs `web/src/components/editor/CreatorDevice.jsx` / `HelperDevice.jsx` that just print the role, replaced later).

- [ ] **Step 1: Write the failing test** — `web/src/pages/EditorPage.test.jsx`. Mock `../lib/supabaseClient`, `../lib/editor/stateStore`, `../lib/editor/projectChannel`, `../lib/editor/tasksApi`, `../contexts/AuthContext`, `../utils/announcer`, and both device components (stubs that render `creator device` / `helper device` and expose received props via a captured variable). Tests:

```jsx
// (imports + vi.hoisted mocks per the house pattern in ProjectPage.test.jsx — read it first)
describe('EditorPage', () => {
  it('renders the creator device for the project owner role', async () => { /* member row role=creator → findByText('creator device') */ })
  it('renders the helper device for helpers', async () => { /* role=helper → 'helper device' */ })
  it('builds and saves version 1 when no state exists', async () => {
    /* loadLatestState → null; expect saveState called with version expectedVersion=0→1 and buildInitialState output */
  })
  it('applies a newer remote state and announces the change summary', async () => {
    /* capture onStateInsert from the joinProjectChannel mock; fire { version: 2, state: ..., updated_by: 'other' };
       expect announce called with the summarize output and device props updated */
  })
  it('ignores its own echo', async () => {
    /* fire onStateInsert with updated_by = current user and version already applied → announce NOT called */
  })
  it('announces presence joins', async () => { /* fire onPresence with two members → announce(/joined/) */ })
})
```
Write these fully (use the captured-props stub pattern: `vi.mock('../components/editor/CreatorDevice', () => ({ default: (props) => { capturedProps.creator = props; return <div>creator device</div> } }))`).

- [ ] **Step 2: Write `EditorPage.jsx` + the two placeholder device stubs** implementing responsibilities 1–7. Key prop contracts passed to BOTH devices (Tasks 9/10 must match):

```js
{
  role, projectId, user,
  state,                 // current edit state object
  sources,               // [{ id: video_id, name, src: signedUrl, duration }]
  descriptions,          // { [rootSegmentId]: { 1: text, 2: text, 3: text } }
  tasks,                 // tasks rows, newest first
  applyAndSave,          // (opFn: state => state, announceText?: string) => Promise<void>
  channel,               // { sendPlayhead, sendTransport, sendActivity }
  remote: { playhead, transport, activity },  // latest received broadcast payloads (state)
  onCreateTask,          // ({ text, segmentLabel }) => Promise
  onSetTaskStatus,       // (taskId, status) => Promise
}
```

- [ ] **Step 3: Route + entry button.** `App.jsx`: `<Route path="/projects/:projectId/edit" element={<RequireAuth><EditorPage /></RequireAuth>} />`. `ProjectPage.jsx`: under the Videos section, when any video is `ready`, render `<Link to={`/projects/${id}/edit`} className="...">Open editor</Link>` — implement by passing a `hasReadyVideo` callback prop from VideosSection or by a tiny separate query in ProjectPage (choose the separate query: `select id from videos where project_id and status='ready' limit 1`); stub in ProjectPage tests accordingly.

- [ ] **Step 4: Run all web tests. Step 5: Commit** — `git commit -m "feat(web): editor page — role resolution, state bootstrap, realtime wiring"` (add the new/modified files explicitly; never `git add -A`).

---

### Task 9: Creator device port (exploration + edit modal + tasks + VQA + AI edits)

**Files:**
- Create: `web/src/components/editor/CreatorDevice.jsx` (replaces stub; adapted from probe `src/components/decoupled/DecoupledCreatorDevice.jsx`)
- Create: `web/src/components/editor/ExplorationMode.jsx` (adapted from probe `src/components/probe1/ExplorationMode.jsx`)
- Create: `web/src/components/editor/TaskRequestModal.jsx` (adapted from probe)
- Create: `web/src/components/editor/ConfirmAiEditDialog.jsx` (new, small)
- Test: `web/src/components/editor/CreatorDevice.test.jsx`

**Adaptation contract (applies to all three ported files — read each source file fully first):**

| Strip / Replace | With |
|---|---|
| `webrtcService.send({type: 'EDIT_STATE_UPDATE'...})` after edits | `applyAndSave(opFn, announceText)` prop (EditorPage persists + Realtime distributes) |
| `webrtcService.send({type: 'TASK_TO_HELPER'...})` | `onCreateTask({ text, segmentLabel })` prop |
| `window.__taskStatusUpdate` / `window.__aiEditReceive` / `window.__aiEditResponse` WoZ hooks | delete; task status arrives via the `tasks` prop re-rendering |
| `EventLoggerContext` / `logEvent` / `eventTypes` imports & calls | delete |
| `condition` props and per-condition branches | keep only the probe2b/3 behavior, delete the rest |
| Probe import paths | this repo's paths (`../../lib/editor/sceneEditOps`, `../../hooks/...`, `../../utils/announcer`, `../../services/ttsService`) |
| Description lookup by scene | `descriptions[rootSegmentId(clip.id)]?.[level]` (import `rootSegmentId` from stateStore) |
| `PLAY/PAUSE/SEEK` WS sends | `channel.sendTransport({ action, time })` + `channel.sendPlayhead(...)` on the existing ~2s cadence |

Keep IDENTICAL: keyboard map (arrows/space/escape), earcons, TTS read-out + Stop Reading, announce() calls, undo/redo local stacks, modal focus management (`useRootInert`).

**New pieces (full code expected in implementation):**

1. **VQA**: "Ask about this scene" button in ExplorationMode → `TaskRequestModal` variant (`mode="vqa"`) → `serverPost(`/api/segments/${rootSegmentId(clip.id)}/vqa`, { question })` → speak + announce the `answer`. Disable (with explanation) for split clips whose root id no longer matches a real segment? No — `rootSegmentId` maps splits back to the real segment; always enabled.
2. **Ask AI**: button → `TaskRequestModal` (`mode="ai"`) → `serverPost(`/api/projects/${projectId}/ai-edit`, { request, clips: state.clips.map(c => ({ id: c.id, name: c.name, duration_seconds: (c.endTime - c.trimEnd) - (c.startTime + c.trimStart) })) })` → if `clarification`: speak it, keep modal open; else open `ConfirmAiEditDialog`.
3. **ConfirmAiEditDialog.jsx** (new): speaks/​renders `proposal.summary` with Confirm/Cancel buttons (`role="alertdialog"`, focus-trapped via `useRootInert`); on Confirm maps the proposal to an op and applies:

```js
import { applyOperation, addCaption, splitClip, moveClip, deleteClip, trimClipStart, trimClipEnd } from '../../lib/editor/sceneEditOps'

export function proposalToOpFn(proposal) {
  const { op, target_clip_id: id, params = {} } = proposal
  switch (op) {
    case 'delete': return (state) => deleteClip(state, id)
    case 'split': return (state) => {
      const clip = state.clips.find((c) => c.id === id)
      if (!clip) return state
      const mid = clip.startTime + clip.trimStart + (((clip.endTime - clip.trimEnd) - (clip.startTime + clip.trimStart)) / 2)
      return splitClip(state, id, mid)
    }
    case 'move_earlier': return (state) => moveClip(state, id, 'earlier')
    case 'move_later': return (state) => moveClip(state, id, 'later')
    case 'add_caption': return (state) => addCaption(state, id, params.caption_text)
    case 'trim_start': return (state) => trimClipStart(state, id, params.direction)
    case 'trim_end': return (state) => trimClipEnd(state, id, params.direction)
    default: return (state) => state
  }
}
```
(Adjust `moveClip`/trim direction argument values to the characterization findings of Task 3 — the test file documents them.)

- [ ] **Step 1: Write the failing CreatorDevice test** — mock `../../lib/serverApi`, announcer, ttsService, speech hook; render with the Task 8 prop contract and assert: (a) scene navigation announces the next scene's name + description; (b) Edit-Myself delete calls `applyAndSave` with an opFn that removes the clip (call the captured opFn on a fixture state and assert); (c) Ask-Helper submits → `onCreateTask` called with text + current scene label; (d) Ask-AI happy path → serverPost called with clips payload → confirm dialog appears with the summary → Confirm → `applyAndSave` called; (e) Ask-AI clarification keeps the modal open and announces the clarification; (f) VQA answer is announced. Write these tests fully in the implementation (follow the VideosSection.test.jsx mock style).

- [ ] **Step 2–4:** Port + adapt the three components per the contract; implement the new dialog; run tests; iterate until green; run the FULL web suite.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): creator device — exploration, self-edits, helper tasks, VQA, confirm-first AI edits"`

---

### Task 10: Helper device port (preview, activity feed, editor tools incl. colour)

**Files:**
- Create: `web/src/components/editor/HelperDevice.jsx` (adapted from probe `DecoupledHelperDevice.jsx`)
- Create (adapted ports): `ActivityFeed.jsx`, `EditorTimeline.jsx` (from `MockEditorVisual.jsx`), `TextOverlay.jsx`, `TextOverlaySettings.jsx`, `SegmentMarkerPanel.jsx`, `TransportControls.jsx`, `EditorVideoPlayer.jsx` (from shared `VideoPlayer.jsx`), `ProjectUpdateToast.jsx` — all under `web/src/components/editor/`
- Test: `web/src/components/editor/HelperDevice.test.jsx`

**Adaptation contract** (same strip table as Task 9, plus):

| Probe behavior | Production behavior |
|---|---|
| `TASK_STATUS_UPDATE` WS send on Done/Needs discussion/Can't do | `onSetTaskStatus(taskId, status)` prop (status strings: `done`, `needs_discussion`, `cant_do`) |
| `feedItems` prop assembled by Probe3Page | derive from `tasks` prop (pending → actionable items; others → history) |
| `COLOUR_UPDATE` WS messages (transient) | colour PERSISTS: slider commit (pointer-up / change end) → `applyAndSave((state) => ({ ...state, colour: { ...state.colour, [sceneId]: { ...state.colour?.[sceneId], [property]: value } } }), summarizeVisualAdjustment(property, value, 'Helper').announcement)` — label the panel "Preview only until export" |
| `ACTIVITY` WS sends on seek | `channel.sendActivity({ action: 'Seeked', detail: formatDuration(time) })` |
| Creator playhead via `STATE_UPDATE` | `remote.playhead` / `remote.transport` props drive the pinned preview (helper's independent scrubbing stays local) |
| AI-suggestion feed items (`SUGGESTION_*`, `AI_EDIT_NOTIFY`) | delete — Phase 3 |

Colour renders on the preview as CSS `filter: brightness() contrast() saturate()` + `transform: scale()` per active scene (port the probe's mapping).

- [ ] **Step 1: Write the failing HelperDevice test** — render with the Task 8 prop contract; assert: (a) pending task shows Done/Needs discussion/Can't do and clicking calls `onSetTaskStatus('t1', 'done')`; (b) a timeline edit (delete via EditorTimeline) calls `applyAndSave` with a correct opFn; (c) committing a colour slider calls `applyAndSave` and the resulting state carries `colour[sceneId].brightness`; (d) `remote.transport = { action: 'pause', time: 3 }` reflects in the preview state; (e) creator activity entries render from received `activity` payloads. Write fully, house mock style.
- [ ] **Step 2–4:** Port + adapt all files per contract; run tests until green; full suite green.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): helper device — synced preview, activity feed, editor tools with persistent colour"`

---

### Task 11: 1b review carry-over — gate stuck-upload Retry to the uploader

**Files:**
- Modify: `web/src/components/VideosSection.jsx`, `web/src/components/VideosSection.test.jsx`

- [ ] **Step 1: Update the test** "offers retry for a stuck uploading row when no upload is in flight": give the row `uploaded_by: 'u1'` (the mocked user). Add a new test: a row with `uploaded_by: 'other'` and status `uploading` renders NO retry button (`queryByRole('button', { name: /retry/i })` → null) while a `failed` row from `other` still DOES.
- [ ] **Step 2:** Add `uploaded_by` to the `loadVideos` select; change the retry condition to `v.status === 'failed' || (v.status === 'uploading' && progress === null && v.uploaded_by === user.id)`.
- [ ] **Step 3:** Run web tests; commit — `git commit -m "fix(web): only the uploader sees retry on an in-flight upload row"`

---

### Task 12: Two-browser Playwright smoke

**Files:**
- Create: `e2e/playwright.config.mjs`, `e2e/setup/globalSetup.mjs`, `e2e/editor.spec.mjs`
- Modify: root `package.json` (devDep `@playwright/test`, script `"e2e": "playwright test -c e2e/playwright.config.mjs"`)

- [ ] **Step 1: Install** — `npm install -D @playwright/test` (root) ; `npx playwright install chromium`

- [ ] **Step 2: `e2e/playwright.config.mjs`**

```js
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  globalSetup: './setup/globalSetup.mjs',
  use: { baseURL: 'http://localhost:5173' },
  webServer: [
    { command: 'npm run dev:web', port: 5173, reuseExistingServer: true, timeout: 60_000 },
    { command: 'npm run dev:server', port: 3001, reuseExistingServer: true, timeout: 60_000 },
  ],
})
```

- [ ] **Step 3: `e2e/setup/globalSetup.mjs`** — Node script using the service-role client (reuse `scripts/e2e-pipeline.mjs` building blocks — READ it first): allowlist two throwaway emails, admin-create creator+helper (password from `crypto.randomUUID()`), creator project, admin-insert helper membership row (service role may insert `project_members` directly), synthesize a 12s clip with ffmpeg-static, insert videos row + storage upload, POST local server `/api/videos/:id/process` with the creator token, poll until `ready`. Write ids + credentials to `e2e/.state.json` (gitignore it: add `e2e/.state.json` to `.gitignore` in this step). Export a teardown list; cleanup happens in globalSetup's returned teardown OR a `globalTeardown` script that deletes the storage objects, project, allowlist rows, users (mirror e2e-pipeline cleanup).

- [ ] **Step 4: `e2e/editor.spec.mjs`**

```js
import { test, expect } from '@playwright/test'
import fs from 'node:fs'

const state = JSON.parse(fs.readFileSync(new URL('./.state.json', import.meta.url), 'utf-8'))

async function signIn(page, email, password) {
  await page.goto('/signin')
  await page.getByLabel(/email/i).fill(email)
  await page.getByLabel(/password/i).fill(password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page.getByRole('heading', { name: /your projects/i })).toBeVisible()
}

test('creator and helper collaborate live; state survives refresh', async ({ browser }) => {
  const creatorCtx = await browser.newContext()
  const helperCtx = await browser.newContext()
  const creator = await creatorCtx.newPage()
  const helper = await helperCtx.newPage()

  await signIn(creator, state.creatorEmail, state.password)
  await signIn(helper, state.helperEmail, state.password)
  await creator.goto(`/projects/${state.projectId}/edit`)
  await helper.goto(`/projects/${state.projectId}/edit`)

  // both devices load their role UIs
  await expect(creator.getByRole('heading', { name: /scene 1/i })).toBeVisible()
  await expect(helper.getByText(/activity/i)).toBeVisible()

  // count scenes on the helper timeline, then creator deletes scene 1
  const sceneCountBefore = await helper.getByTestId('timeline-clip').count()
  await creator.getByRole('button', { name: /edit myself/i }).click()
  await creator.getByRole('button', { name: /delete/i }).click()
  await expect(helper.getByTestId('timeline-clip')).toHaveCount(sceneCountBefore - 1, { timeout: 15_000 })

  // creator sends a task; helper marks it done; creator sees the status
  await creator.getByRole('button', { name: /ask helper/i }).click()
  await creator.getByLabel(/task|request/i).fill('Please trim the shaky part')
  await creator.getByRole('button', { name: /send/i }).click()
  await expect(helper.getByText(/trim the shaky part/i)).toBeVisible({ timeout: 15_000 })
  await helper.getByRole('button', { name: /mark done/i }).click()
  await expect(creator.getByText(/done/i)).toBeVisible({ timeout: 15_000 })

  // refresh both: state intact (deleted scene stays deleted, task stays done)
  await creator.reload()
  await helper.reload()
  await expect(helper.getByTestId('timeline-clip')).toHaveCount(sceneCountBefore - 1)
  await expect(creator.getByText(/done/i)).toBeVisible()
})
```
(Selectors must match Tasks 9/10 output — add `data-testid="timeline-clip"` to EditorTimeline clip items in Task 10 and adjust the names here to the real labels; this spec is the acceptance gate, fix the spec OR the components until honest-green.)

- [ ] **Step 5: Run** — `npm run e2e`. Expected: 1 test passed (allow ~2–3 min incl. processing in setup). **Step 6: Commit** — add the e2e dir + package.json + .gitignore change; `git commit -m "test: two-browser playwright smoke for live collaboration"`

---

### Task 13: Deploy, production smoke, tag

- [ ] **Step 1:** Full local gates: `npm test` (all web+server), `node --env-file=server/.env scripts/e2e-smoke.mjs` (53/53), `npm run e2e`, `npm run build`.
- [ ] **Step 2:** Push — `git push origin main`. Verify Railway `/health` and that `POST /api/projects/x/ai-edit` returns 401 unauthenticated (proves new route deployed). No new env vars are needed.
- [ ] **Step 3: HUMAN STEP — two-device production smoke.** Lan (creator, phone) + helper account (second device/browser): open the editor on the real project, creator navigates scenes + deletes one → helper sees it live; helper adds a caption + adjusts colour → creator hears the announcements; creator sends a task → helper marks done → creator hears it; creator asks the AI to delete a scene → confirms → applied; creator asks a VQA question → hears the answer; refresh both → everything intact.
- [ ] **Step 4:** `git tag phase-1c` ; `git push --tags`.

---

## After this plan

- **Phase 2 — Product UX** (visual/UX redesign of both devices; accessibility settings page; project_state pruning job; friendly-error sweep).
- **Pre-Phase-3 spike:** 1-day Gemini quality test of proactive suggestions on real participant footage (the product's biggest bet — do this BEFORE designing Phase 3).
- **Phase 3 — Real AI** (proactive suggestions, task routing, richer AI edits). **Phase 4 — Export** (EDL + colour → ffmpeg render).
