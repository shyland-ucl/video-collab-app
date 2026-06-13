# Phase 2a — Probe 3 Creator UX Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`. This is a faithful UX port — READ the named probe source files end-to-end before adapting; match their structure/behavior/SR contracts exactly, changing only the wiring per the adaptation contract.

**Goal:** Replace the single-scene modal creator UI with the Probe 3 `SceneBlockList` experience (pinned video + inline collapsible scenes, per-scene 3-level detail picker, Play-this-scene/Play-from-here, per-scene actions, purple accent, edit stamps), wired to the existing realtime backend. Defer the AI-suggestion engine to Phase 3.

**Architecture:** Front-end only. `CreatorDevice` recomposes around ported `SceneBlockList`/`SceneBlock`/`DetailLevelSelector` (+ small deps), consuming the SAME EditorPage prop bundle (`state`, `descriptions`, `applyAndSave`, `onCreateTask`, `channel`, `sources`, `tasks`, etc.). No migration/RLS/endpoint/realtime change. Helper gets accent-only alignment.

**Tech Stack:** existing web workspace (Vite/React 19/Tailwind 4/Vitest). Probe source (read-only): `..\video-collab-probe\src\`.

**Spec:** `docs/superpowers/specs/2026-06-13-phase2a-probe3-creator-ux-design.md`

**Operational reminders:** commits direct to main; never stage `scripts/diag-smtp.mjs`; commit messages end `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; current suite web 240 / server 60. Backend is deployed & correct — do NOT touch it.

**Adaptation contract (every ported file):** strip `EventLoggerContext`/`logEvent`/`eventTypes`/`Actors`, `webrtcService`/WS/`window.__*`, `condition` branches, awareness telemetry (`onAwarenessViewed`), AI-suggestion props (`sceneIndicesWithSuggestions`/suggestion routing). Replace probe `segments`/`scenes` data with this app's `state.clips` + `descriptions[rootSegmentId(clip.id)]?.[level]`. Fix import paths. KEEP verbatim: expand/auto-follow/focus/swipe behavior, DetailLevelSelector SR contract, edit stamps, keyboard model, earcons/TTS/announce, `useRootInert` focus traps, undo/redo non-rebasable (`applyAndSave(opFn, text, { rebasable: false })`).

---

### Task 1: Port the detail-level picker + scene-list primitives

**Files (create under `web/src/components/editor/sceneblocks/`):**
- `DetailLevelSelector.jsx` (+ `web/src/lib/editor/detailLevels.js` for `LEVELS`)
- `SceneBlock.jsx`, `SceneBlockList.jsx`
- small deps actually imported by the above: `GlobalControlsBar.jsx`, `PlainScreenReaderAction.jsx`, and `web/src/lib/editor/descriptionAddenda.js` (port from `utils/descriptionAddenda.js`) — port only those the list/block truly need; report which.
- Tests: `DetailLevelSelector.test.jsx`, `SceneBlockList.test.jsx`

- [ ] **Step 1: Read the real sources** — `..\video-collab-probe\src\components\shared\{SceneBlockList,SceneBlock,DetailLevelSelector,GlobalControlsBar,PlainScreenReaderAction}.jsx`, `src\utils\{detailLevels,descriptionAddenda}.js`. Note every prop and every study-only import to strip.

- [ ] **Step 2: Port DetailLevelSelector + detailLevels** verbatim except imports. It has an intentional non-button SR contract (read its header) — preserve it exactly. Test: renders 3 level targets reflecting `currentLevel` via `aria-pressed`; activating a level calls `onLevelChange(value)` and stops propagation (a click on a level does not bubble to a parent onClick).

- [ ] **Step 3: Port SceneBlock + SceneBlockList**, applying the adaptation contract. The list keeps: `expandedIndex`/expand-source/focus tokens, auto-follow (`disableAutoFollow`), swipe, `keptScenes` dimming + "Removed" badge, `editedScenes` amber badge + "what changed" line, and the `renderSceneActions` render-prop. Drop `vqaHistories`/`awarenessData`/`onAwarenessViewed`/`sceneIndicesWithSuggestions`. Scene input is the app's clips (caller maps `state.clips` → the scene shape the block expects: id, name, time range, and the per-level description text resolved via `descriptions[rootSegmentId(clip.id)]`). Accent prop defaults to purple `#9B59B6`.

- [ ] **Step 4: Test SceneBlockList behavior** (jsdom, house mock style): renders one block per scene; expanding a block shows the DetailLevelSelector + that scene's description; picking level 2 swaps the shown description; an edited scene (via `editedScenes`) shows the "Edited" badge + change line; a not-kept scene renders dimmed/"Removed"; auto-follow expands the next block when `currentTime` crosses a boundary and `disableAutoFollow` is false (and does NOT when true); `onSceneClose` fires on collapse. Adapt assertions to the real rendered DOM you ported.

- [ ] **Step 5:** Full web suite green. Commit `feat(web): port Probe 3 scene-block list + detail-level picker (study-only stripped)`.

---

### Task 2: Per-scene actions component (Ask AI / Edit myself / Ask AI to edit / Ask helper) + play controls

**Files:**
- Create `web/src/components/editor/SceneActions.jsx` (+ `.test.jsx`)
- Reuse existing `web/src/components/editor/{ConfirmAiEditDialog,TaskRequestModal}.jsx` and `web/src/lib/{serverApi,editor/sceneEditOps,editor/stateStore}` (rootSegmentId, applyOperation).

This is the action set that `SceneBlockList`'s `renderSceneActions` renders inside an expanded scene. Reference the probe's Probe 2b scene-actions structure (find it under `src/components/probe2b/` or as used in `Probe3Page` creator branch — the prior investigation named `Probe2bSceneActions.jsx`; READ it) for layout/order, but wire to THIS app's handlers.

- [ ] **Step 1: Read** the probe's `Probe2bSceneActions.jsx` (and how `Probe3Page` passes it into `SceneBlockList`). Note the action order, the toggle-panel pattern, and the two play buttons.
- [ ] **Step 2: Write the failing test** for `SceneActions` — props `{ clip, projectId, level, descriptions, isPlaying, isActiveScene, onPlayScene, onPlayFromHere, onPause, applyAndSave, onCreateTask }`. Assert: "Play this scene" calls `onPlayScene(clip)`; "Play from here" calls `onPlayFromHere(clip)` (and toggles to pause when playing); Edit-by-myself → Delete calls `applyAndSave` with an opFn that removes the clip by id + a scene-naming announce text; Ask-helper submit → `onCreateTask({ text, segmentLabel: clip.name })`; Ask-AI happy path → `serverPost('/api/projects/<id>/ai-edit', {request, clips})` → `ConfirmAiEditDialog` shows the deterministic sentence → Confirm → `applyAndSave`; Ask-AI clarification keeps the panel open + speaks it; VQA answer announced via `serverPost('/api/segments/<rootId>/vqa')`.
- [ ] **Step 3: Build SceneActions** by lifting the action logic from the CURRENT `ExplorationMode.jsx`/`CreatorDevice.jsx` (the VQA, Ask-AI confirm-first, Edit-myself ops, Ask-helper task are already implemented there — move/adapt them into this per-scene component) plus the two play buttons. Purple accent; in-scene toggle panels (not full-screen modals) where the probe uses inline panels; keep `useRootInert` only for the genuinely modal dialogs (ConfirmAiEditDialog). Undo/redo stay non-rebasable.
- [ ] **Step 4:** Tests green; commit `feat(web): per-scene actions (VQA, self-edit, AI edit, ask helper) with Play-this-scene/Play-from-here`.

---

### Task 3: Rebuild CreatorDevice around SceneBlockList

**Files:** rewrite `web/src/components/editor/CreatorDevice.jsx` (+ rewrite `CreatorDevice.test.jsx`); the old `ExplorationMode.jsx` becomes unused — delete it and its test, fold any still-needed bits into SceneActions/CreatorDevice.

- [ ] **Step 1:** Read the current `CreatorDevice.jsx` + `web/src/pages/EditorPage.jsx` (the prop bundle) + the probe `Probe3Page.jsx` creator branch for layout. CreatorDevice now renders: pinned visually-only video (`sources` signed URLs, `maxHeight:32vh`, aria-hidden+inert like the probe) + `SceneBlockList` over `state.clips` with `renderSceneActions={(scene, idx, controls) => <SceneActions .../>}`. It owns the `usePlaybackEngine` instance (or drives the existing playback the device already used), exposes `onPlayScene` (bounded — pause at clip end), `onPlayFromHere` (unbounded), `onPause`, and threads `currentTime`/`isPlaying` into the list for auto-follow. It derives `editedScenes` from incoming realtime change summaries (the device can keep a short-lived map keyed by sceneId from `applyAndSave` announce + remote inserts — keep it simple; reuse `summarizeEditStateChange`). Detail level is per-scene local state inside SceneBlock (as the probe does).
- [ ] **Step 2:** Rewrite `CreatorDevice.test.jsx` to the new structure: scene list renders from `state.clips`; expanding a scene shows actions; the wiring assertions from Task 2 at the device level (delete → applyAndSave; ask-helper → onCreateTask; AI confirm → applyAndSave; VQA announced); Play-this-scene bounded vs Play-from-here unbounded; keyboard still works. Keep the prop contract from EditorPage unchanged (EditorPage does not change).
- [ ] **Step 3:** Delete `ExplorationMode.jsx` + `ExplorationMode.test.jsx` (functionality now in SceneActions/SceneBlock). Confirm nothing else imports them.
- [ ] **Step 4:** Full web suite green; `npm run build` clean. Commit `feat(web): rebuild creator device as Probe 3 scene-block list (replaces single-scene modal)`.

---

### Task 4: Helper accent/styling alignment

**Files:** `web/src/components/editor/HelperDevice.jsx` + the helper panels (ActivityFeed/EditorTimeline/etc.) — styling only.

- [ ] **Step 1:** Compare the app helper against the current probe `DecoupledHelperDevice.jsx` styling (card colors, intent banner, accent). Align accent/card classes to Probe 3 (orange/purple cards, purple primary). Do NOT restructure; do NOT add suggestion-feed items (Phase 3). Keep colour persistence + announcements.
- [ ] **Step 2:** Existing helper tests still green (update only assertions that pinned a specific old class/color, if any). Commit `style(web): align helper device accent/cards to Probe 3`.

---

### Task 5: Update the two-browser Playwright smoke to the new DOM + full verify

**Files:** `e2e/editor.spec.mjs` (selectors), maybe `e2e/setup/globalSetup.mjs` (unchanged unless needed).

- [ ] **Step 1:** The creator now drives an inline scene list, not a modal. Update the creator-side selectors: open a scene block, use its in-scene "Edit"/"Delete" (or the real labels you built) to delete a scene; the task-send + helper-mark-done + refresh-persistence assertions stay. Selectors must match the REAL new DOM (read CreatorDevice/SceneActions output). Keep assertions web-first auto-retry; do not weaken — if something is genuinely broken, report it as a BUG FOUND.
- [ ] **Step 2:** Run `npm run e2e` against the live stack — must honestly pass (both roles load; creator delete propagates to helper; task round-trip; refresh persists).
- [ ] **Step 3:** `npm test` (web+server) + `npm run build` all green. Commit `test: update two-browser smoke to the scene-block creator UI`.

---

### Task 6: Deploy + verify + (human) re-check

- [ ] **Step 1:** `git push origin main` (deploys Vercel; server unchanged so Railway is a no-op rebuild). Verify the web bundle serves the new UI (e.g. bundle contains "Play this scene" / the new labels).
- [ ] **Step 2: HUMAN (Lan):** open the editor on production — confirm it now looks like the Probe 3 creator UX (inline scene list, detail picker, play-this-scene/play-from-here, purple, edit stamps) and that edits still sync to the helper + survive refresh.
- [ ] **Step 3:** Once Lan confirms the look matches the probe, `git tag phase-1c-ux` (or fold into the held `phase-1c` tag — Lan's call).

---

## After this plan

- Phase 3 brings the deferred AI-suggestion engine (AIAnalysisTriggerCard + three-channel routing + suggestion feed items) — port `probe3/Probe3SceneActions.jsx` + `AIAnalysisTriggerCard.jsx` + the suggestion branches of `probe3/ActivityFeed.jsx`, backed by a new analysis endpoint. Pre-Phase-3: the Gemini quality spike on real footage.
- Remaining Phase 2: friendly-error sweep; project_state pruning job (review before running on live data); broader visual polish.
