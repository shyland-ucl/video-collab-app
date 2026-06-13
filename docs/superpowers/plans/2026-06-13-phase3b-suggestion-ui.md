# Phase 3b — AI Suggestion UI + Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development or executing-plans. Steps use `- [ ]`.

**Goal:** Ship the probe's Phase 3 interaction in this app — an "Analyse with AI" trigger, per-scene suggestion cards, three-channel routing (self / helper / Ask-AI-confirm-first), and live resolution badges — backed by a persisted, realtime `suggestions` table.

**Architecture:** A new `suggestions` table (migration 0010) is the source of truth; the server persists curated suggestions on generation; the client lists them, subscribes over Realtime, routes each through the EXISTING `applyAndSave` / `onCreateTask` / `ConfirmAiEditDialog` seams, and updates the suggestion row's resolution. relatedScene is resolved to a stable `segment_id` server-side; the client attaches each suggestion to the clip whose `rootSegmentId` matches.

**Tech Stack:** Postgres/Supabase RLS + Realtime, Express 5, React 19, Vitest + Testing Library, Playwright.

---

### Task 1: Migration 0010 — `suggestions` table

**Files:** Create `supabase/migrations/0010_suggestions.sql`

- [ ] **Step 1: Write the migration** (mirrors 0008's `tasks` RLS + realtime exactly)

```sql
-- Phase 3b: persisted AI suggestions + their routing resolution
create table public.suggestions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  video_id uuid not null references public.videos (id) on delete cascade,
  model_suggestion_id text,
  category text not null check (category in ('issue', 'structural', 'creative')),
  text text not null check (char_length(text) between 1 and 500),
  related_scene integer not null,
  segment_id uuid references public.segments (id) on delete set null,
  prototype_action text not null,
  fix_template jsonb,
  routed_to text check (routed_to in ('self', 'helper', 'ai')),
  outcome_status text check (outcome_status in ('pending', 'applied', 'failed')),
  task_id uuid references public.tasks (id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null
);

create index suggestions_project_video_idx on public.suggestions (project_id, video_id);

alter table public.suggestions enable row level security;

-- Members read + update (resolutions). NO member insert: only the server
-- (service-role, bypasses RLS) writes suggestions on generation, so a member
-- can't forge them.
create policy "members read suggestions" on public.suggestions
  for select using (public.is_project_member(project_id));

create policy "members update suggestions" on public.suggestions
  for update using (public.is_project_member(project_id));

alter publication supabase_realtime add table public.suggestions;
```

- [ ] **Step 2: Apply to LIVE** — `npx supabase db push --yes` (additive: new table + policies only). Expected: migration 0010 applied, no destructive change.
- [ ] **Step 3: Commit** `git add supabase/migrations/0010_suggestions.sql && git commit -m "feat(db): 0010 suggestions table + RLS + realtime"`

---

### Task 2: Server — loader returns `segmentId`; `suggest.js` persists

**Files:** Modify `server/src/services/suggestionsData.js`, `server/src/routes/suggest.js`; Test: extend both `.test.js`.

- [ ] **Step 1 (TEST):** `suggestionsData.test.js` — assert each returned scene includes `segmentId` (the segment row `id`). Add to the happy-path expectation: `expect(out.scenes[0].segmentId).toBe('s1')`.
- [ ] **Step 2 (IMPL):** in `loadVideoForSuggestions`, add `segmentId: s.id` to each scene object in the `scenes = used.map(...)`.
- [ ] **Step 3 (TEST):** `suggest.test.js` — add a fake `persist` dep spy; assert the route calls `persist(supabase, projectId, videoId, suggestions, scenes)` after `propose` and returns the persisted rows. Add a `makeSuggestRoutes(supabase, { propose, getModel, loadVideo, persist })` dep.
- [ ] **Step 4 (IMPL):** add `persistSuggestions(supabase, projectId, videoId, suggestions, scenes)` to `suggestions.js` (service): delete prior rows for `(project_id, video_id)`, then insert one row per suggestion with `segment_id = scenes[s.relatedScene]?.segmentId ?? null`, `model_suggestion_id = s.id`, mapping fields; return the inserted rows (`select()`). Wire it into `suggest.js`: `const persisted = await persist(supabase, project.id, videoId, proposal.suggestions, loaded.scenes); res.json({ suggestions: persisted })`. Default `persist = persistSuggestions`. On a persist error, fall back to returning the in-memory `proposal.suggestions` (don't 500 the analyse).
- [ ] **Step 5:** `cd server && npx vitest run` — all green. **Commit.**

---

### Task 3: Client `suggestionsApi.js`

**Files:** Create `web/src/lib/editor/suggestionsApi.js` + `suggestionsApi.test.js`.

- [ ] Contract (mirrors `tasksApi.js` style):
  - `requestSuggestions(projectId, videoId)` → `serverPost('/api/projects/${projectId}/suggest', { videoId })` → `data.suggestions`.
  - `listSuggestions(supabase, projectId, videoId)` → select all columns, ordered `created_at`.
  - `setSuggestionResolution(supabase, id, { routedTo, outcomeStatus, taskId })` → update `{ routed_to, outcome_status, task_id, resolved_at: new Date().toISOString(), resolved_by }`... **note:** `resolved_by` needs the userId — pass it in: `setSuggestionResolution(supabase, id, { routedTo, outcomeStatus, taskId, userId })`. `.eq('id', id).select().single()`.
  - `updateSuggestionOutcome(supabase, id, outcomeStatus)` → update just `{ outcome_status }` (used when a linked task status changes).
- [ ] Tests with a fake supabase (route-by-method) + a mocked `serverPost`. **Commit.**

---

### Task 4: Pure `suggestionRouting.js`

**Files:** Create `web/src/lib/editor/suggestionRouting.js` + `suggestionRouting.test.js`. Pure, no React.

- [ ] `suggestionClip(suggestion, clips)` → the first clip with `rootSegmentId(clip.id) === suggestion.segment_id`, else `null`. (Stale-scene → null → card not rendered.)
- [ ] `taskStatusToOutcome(status)` → `{ done:'applied', cant_do:'failed', needs_discussion:'pending', pending:'pending' }[status] ?? 'pending'`.
- [ ] `fixTemplateToOpFn(fixTemplate, clipId)` and `describeFixTemplate(fixTemplate, clipName)` → for `mute`/`unmute`: opFn `(s)=>applyOperation(s, clipId, 'toggle_mute')` (guarded — see note), confirm `{ question: 'Mute the original audio on {name}?', done: 'Muted …' }`; for `brightness|contrast|saturation|zoom|rotate`: opFn `(s)=>({ ...s, colour: { ...s.colour, [rootSegmentId(clipId)]: { ...(s.colour?.[rootSegmentId(clipId)] ?? {}), [action]: value } } })`, confirm sentences ("Increase brightness on {name}?" etc., sign-aware for the +/- sliders; "Zoom {name} to {value}%?"; "Rotate {name} by {value} degrees?"). **toggle_mute note:** `applyOperation('toggle_mute')` flips current state; for a deterministic mute/unmute target, the opFn must only toggle when the current value differs from the desired — implement as `(s)=>getClipMuted(s, clipId) === desired ? s : applyOperation(s, clipId, 'toggle_mute')` importing `getClipMuted` from `sceneEditOps`.
- [ ] Tests: clip resolution incl. split ids + deleted→null; status map; each fix action's opFn result + confirm sentence. **Commit.**

---

### Task 5: `AIAnalysisTriggerCard.jsx`

**Files:** Create `web/src/components/editor/AIAnalysisTriggerCard.jsx` + test. Faithful port of the probe card (3 states), adapted.

- [ ] Props: `{ status: 'idle'|'analysing'|'done', suggestionCount, onTrigger, role, suggestions }`.
  - **idle:** purple button "✨ Analyse with AI", `aria-label="Trigger AI analysis of this video"`, `minHeight 48px`, `onClick={onTrigger}`.
  - **analysing:** `role="status" aria-live="polite"` card, "AI is analysing your video…", aria-hidden bounce dots.
  - **done (creator):** "AI analysis complete. {N} suggestion(s) now showing in your scenes."
  - **done (helper):** read-only `<ul aria-label="AI suggestions visible to the creator">` of `suggestions` (category + "Scene N" + text), each `aria-hidden` decoration on the chips.
- [ ] Test the 3 states + onTrigger-once + helper list. **Commit.**

---

### Task 6: `SuggestionItem.jsx`

**Files:** Create `web/src/components/editor/SuggestionItem.jsx` + test. Port of the probe SuggestionItem (3 buttons ↔ resolution badge).

- [ ] Props: `{ suggestion, helperName='helper', resolution, onRouteSelf, onRouteHelper, onRouteAI }` where `resolution = { routedTo, outcomeStatus } | null`.
  - **Unrouted (resolution null):** category chip + "Scene N" chip (`aria-hidden`), suggestion `text` (read once), then 3 full-width ≥44px buttons: "I'll fix it" (blue), "Ask {helperName} to fix it" (orange), "Ask AI to fix it" (purple). No dismiss.
  - **Routed:** hide buttons; show a badge container `tabIndex={-1}` with terse `aria-label={'${routedLabel}. ${outcomeLabel}.'}` (`routedLabel`: "Doing it myself" / "Routed to {helperName}" / "Routed to AI"; outcome colour amber/green/red). Visible badge text `aria-hidden`.
- [ ] Test: renders text + 3 buttons; each calls the right handler once; with a `resolution` prop shows the badge + terse aria-label and hides the buttons. **Commit.**

---

### Task 7: `projectChannel` + `EditorPage` wiring

**Files:** Modify `web/src/lib/editor/projectChannel.js`, `web/src/pages/EditorPage.jsx`. Tests: extend the existing EditorPage/realtime tests if present, else a focused new test for the suggestion reducer.

- [ ] `projectChannel.js`: add a third `.on('postgres_changes', { event:'*', schema:'public', table:'suggestions', filter:'project_id=eq.${projectId}' }, (p)=>onSuggestionChange?.({ eventType:p.eventType, suggestion: p.eventType==='DELETE'?p.old:p.new }))`. Add `onSuggestionChange` to the destructured options.
- [ ] `EditorPage.jsx`:
  - state `const [suggestions, setSuggestions] = useState([])` + `suggestionsRef`; `applySuggestions` updater (mirror `applyTasks`).
  - in `load()`, after tasks: `applySuggestions(await listSuggestions(supabase, projectId, /* any video */))` — **load suggestions for ALL of the project's ready videos** (the helper/creator may have analysed any). Simplest: `listSuggestions` without a video filter (add an overload: `listProjectSuggestions(supabase, projectId)`); use that. Reconnect path refetches them too.
  - wire `onSuggestionChange` → INSERT/UPDATE upsert into `suggestions` by id, DELETE removes; on INSERT for the helper announce "AI suggestions are ready — {N} for the creator to act on" (once per analysis batch — dedupe by not announcing UPDATEs).
  - `onAnalyse(videoId)` callback: `const rows = await requestSuggestions(projectId, videoId)` then `applySuggestions((cur)=>[...cur.filter(s=>s.video_id!==videoId), ...rows])`; announce complete + count; on error announce assertive "Couldn't analyse the video — try again". Pass to the device.
  - `onResolveSuggestion(id, patch)` callback → `setSuggestionResolution(supabase, id, { ...patch, userId })` then optimistic local update; pass to device.
  - in `onTaskChange` UPDATE branch (creator side), ALSO: find a suggestion with `task_id === task.id`; if found, `updateSuggestionOutcome(supabase, sug.id, taskStatusToOutcome(task.status))` + optimistic local update (so the badge flips when the helper resolves the task).
  - pass `suggestions`, `onAnalyse`, `onResolveSuggestion` to `<Device>`.
- [ ] Manual reducer test for the suggestion upsert/delete. **Commit.**

---

### Task 8: `CreatorDevice` wiring (trigger + per-scene cards + routing)

**Files:** Modify `web/src/components/editor/CreatorDevice.jsx`. Test: extend/maintain CreatorDevice tests (mock children).

- [ ] New props: `{ suggestions = [], onAnalyse, onResolveSuggestion, initialVideoId }`. Compute `analyseVideoId = initialVideoId ?? sources[0]?.id ?? null`; `analysisStatus` local state ('idle'|'analysing'|'done'); `videoSuggestions = suggestions.filter(s => s.video_id === analyseVideoId)`.
- [ ] Mount `<AIAnalysisTriggerCard status onTrigger={handleAnalyse} role="creator" suggestionCount={videoSuggestions.length} />` between the pinned video div and `<SceneBlockList>`. `handleAnalyse`: setStatus('analysing'); `await onAnalyse(analyseVideoId)`; setStatus('done'); then earcon `playEarcon(880,200)` + after a short beat move focus to the first suggested scene's clip (resolve via `suggestionClip`).
- [ ] In `renderSceneActions`, before `<SceneActions>`, render a `SuggestionItem` for EACH suggestion whose `suggestionClip(s, clips)?.id === clip.id`, with `resolution={{routedTo:s.routed_to, outcomeStatus:s.outcome_status}}` (or null when `!s.routed_to`), and the three handlers:
  - `onRouteSelf`: `onResolveSuggestion(s.id, { routedTo:'self', outcomeStatus:'pending' })`; announce "Edit by myself opened for {clip.name}." (the self-edit panel is right below in the same SceneActions).
  - `onRouteHelper`: `const task = await onCreateTask({ text: s.text, segmentLabel: clip.name }); await onResolveSuggestion(s.id, { routedTo:'helper', outcomeStatus:'pending', taskId: task.id })`; announce "Sent to your helper."
  - `onRouteAI`: confirm-first. If `s.fix_template`: build `{ opFn, described }` via `fixTemplateToOpFn`/`describeFixTemplate` and open a local `ConfirmAiEditDialog`-equivalent (reuse `ConfirmAiEditDialog` needs a `proposal` shape — instead set a local `aiSuggestionConfirm` state `{ question, done, opFn, suggestionId }` and render a small confirm dialog, OR reuse ConfirmAiEditDialog by passing a synthetic proposal for non-fix ops). For NO fix_template: `serverPost('/api/projects/:id/ai-edit', { request: s.text, focused_clip_id: clip.id, clips })` → proposal → `describeProposal` → `ConfirmAiEditDialog`. On confirm: `applyAndSave(opFn, done)` then `onResolveSuggestion(s.id, { routedTo:'ai', outcomeStatus:'applied' })`; on cancel: nothing.
  - **Implementation note:** to keep one confirm path, add a thin `ConfirmEditDialog` that takes `{ question, done, onConfirm, onCancel }` directly (extract the presentational core of `ConfirmAiEditDialog`); `ConfirmAiEditDialog` becomes a wrapper that computes `describeProposal` then renders `ConfirmEditDialog`. Both the AI-edit proposal path and the fix_template path render `ConfirmEditDialog`. (Keeps the deterministic-sentence + useRootInert + TTS behaviour in one place.)
- [ ] Keep all existing CreatorDevice behaviour intact. **Commit.**

---

### Task 9: `HelperDevice` read-only suggestion list

**Files:** Modify `web/src/components/editor/HelperDevice.jsx`.

- [ ] New prop `suggestions = []`. Render `<AIAnalysisTriggerCard status={suggestions.length ? 'done' : 'idle'} role="helper" suggestions={suggestions} />` at the top of the scrollable region (above the Creator Intent banner) — read-only; the helper does NOT route. Resolution badges update live as the creator routes (suggestions prop updates via realtime). **Commit.**

---

### Task 10: collapsed-block "has suggestion" indicator

**Files:** Modify `web/src/components/editor/sceneblocks/SceneBlockList.jsx`, `SceneBlock.jsx`, and `CreatorDevice.jsx` (pass the set). Test: SceneBlock badge.

- [ ] `CreatorDevice`: compute `sceneIdsWithSuggestions = new Set(videoSuggestions.map(s => suggestionClip(s, clips)?.id).filter(Boolean))`; pass to `<SceneBlockList sceneIdsWithSuggestions={...}>`.
- [ ] `SceneBlockList`: accept `sceneIdsWithSuggestions = new Set()`; pass `hasSuggestion={sceneIdsWithSuggestions.has(scene.id)}` to each `<SceneBlock>`.
- [ ] `SceneBlock`: accept `hasSuggestion=false`; when true render an `aria-hidden` "✨ AI" pill next to the scene name (like the "Edited" pill) AND append `'Has an AI suggestion. '` into the collapsed-header `aria-label` (so a TalkBack creator hears it without expanding).
- [ ] Test SceneBlock renders the pill + aria hint when `hasSuggestion`. **Commit.**

---

### Task 11: Playwright e2e + full verify + deploy

**Files:** Modify `e2e/editor.spec.mjs`, `e2e/setup/globalSetup.mjs` (if it must seed suggestions — NO: the test triggers real analysis). 

- [ ] Add an e2e flow: creator opens editor → taps "Analyse with AI" → wait for ≥1 SuggestionItem on a scene (live Gemini) → route one to AI → confirm dialog → assert applied badge + the scene state changed → route one to helper → helper page sees the task, marks done → creator badge flips to applied → reload creator → suggestions + resolutions persist. Use generous timeouts (Gemini + realtime), `retries:1` already set. If live Gemini is too slow/nondeterministic for a hard assertion, assert the trigger→card appears + persistence, and gate the route-outcome assertions behind at-least-one-card.
- [ ] Full verify: `cd server && npx vitest run` (all green) · `cd web && npx vitest run` (all green) · root `npm run build` · `npm run e2e` (live two-browser). **Commit.**
- [ ] Deploy: push `main` (Railway redeploys server with the persisted endpoint; Vercel rebuilds web with the UI). Confirm the migration is live. Update memory.

---

## Self-Review

**Spec coverage:** trigger (T5/T8) ✓ · per-scene cards (T6/T8) ✓ · 3-channel routing reusing applyAndSave/onCreateTask/ConfirmAiEditDialog (T8) ✓ · Ask-AI confirm-first incl. fix_template + /ai-edit fallback (T4/T8) ✓ · persistence table + RLS + realtime (T1/T2/T3/T7) ✓ · helper read-only list (T9) ✓ · stale-scene via segment_id→clip (T2/T4) ✓ · task-status→outcome linkage (T7) ✓ · collapsed-block indicator (T10) ✓ · e2e (T11) ✓.

**Placeholder scan:** the larger components (T5/T6/T8/T9) give prop contracts + behaviour + the exact mount seam rather than full JSX — the implementer ports the probe components (read-only refs named in the design) and follows the existing SceneActions/ConfirmAiEditDialog patterns. The migration, the pure routing module, and the API are fully specified. This is acceptable for same-author execution; an external worker should read the probe sources named in the design doc.

**Type/name consistency:** `requestSuggestions(projectId, videoId)`, `listProjectSuggestions(supabase, projectId)`, `setSuggestionResolution(supabase, id, {routedTo, outcomeStatus, taskId, userId})`, `updateSuggestionOutcome(supabase, id, outcomeStatus)`, `suggestionClip(suggestion, clips)`, `taskStatusToOutcome(status)`, `fixTemplateToOpFn(fix, clipId)`, `describeFixTemplate(fix, clipName)` — used consistently across T3/T4/T7/T8. DB columns snake_case (`routed_to`, `outcome_status`, `segment_id`, `task_id`); client suggestion objects carry the snake_case row fields (like `tasks`). `ConfirmEditDialog` extracted from `ConfirmAiEditDialog` (T8) is reused by both AI paths.
