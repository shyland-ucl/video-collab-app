# Phase 2a — Probe 3 Creator UX Alignment Design

**Date:** 2026-06-13
**Status:** Approved by Lan (this date). Corrects a port error: the Phase 1c editor was built from Probe 1/2a-era components; the real iterated UX is Probe 3.
**Parent:** Phase 2 (Product UX). Backend/realtime from Phase 1c is unchanged.
**Source of truth:** `video-collab-probe` (the user's real-user-iterated study UX). Match it strictly.

## Problem

The Phase 1c creator device was ported from `decoupled/DecoupledCreatorDevice.jsx` + `probe1/ExplorationMode.jsx` — a single-scene **modal** explorer. The current real-user UX (Probe 3, per git: "aligned creator UI", "Refactor Probe 3 AI suggestion routing", Day2/Day3/after-study) is a **`SceneBlockList`**: pinned video at top, an inline collapsible list of scenes below, each scene expanding to reveal its own action set. This is a front-end rework only; the realtime/data layer is correct and untouched.

## Scope (decided with Lan)

**In — structural/interaction UX (this spec):** rebuild the creator around the Probe 3 `SceneBlockList`; align helper styling. **Out — deferred to Phase 3:** the AI-suggestion engine (the "Analyse with AI" `AIAnalysisTriggerCard`, three-channel suggestion routing, resolution badges, `suggestion_task`/`ai_edit` feed items). The per-scene VQA and confirm-first "Ask AI to Edit" are Probe 2b features (already built) and stay.

## Target creator UX (match Probe 3's `Probe3Page` creator branch, minus the suggestion engine)

Layout (full-screen, max-w-lg centered, mobile-first):
- A pinned, visually-only video at top (`maxHeight: 32vh`, scenes scroll below it).
- A `SceneBlockList` of all timeline scenes (`state.clips`). Each `SceneBlock`:
  - Collapsed: scene name + time range; expandable by tap/keyboard.
  - Expanded shows, in order: a **`DetailLevelSelector`** (3 direct-pick buttons, level 1/2/3) → the description at that level → the per-scene actions.
  - **Auto-follow:** during continuous playback the list expands the next scene at its boundary and moves focus to its Play control (keep this — it is iterated study behavior). `disableAutoFollow` while doing single-scene playback.
  - **Edit stamps:** an amber "Edited" badge + a "what changed" line on recently-edited scenes (driven by an `editedScenes` map; reuse the ported `summarizeEditStateChange`/`buildEditChangeSceneStamp`).
- **Play controls per scene:** **"Play this scene"** (bounded — stops at the scene's end) AND **"Play from here"** (unbounded — plays on past the boundary; toggles pause while playing). Both drive the shared `usePlaybackEngine`.
- **Per-scene actions** (the existing functionality, relocated from the modal into the scene block): **Ask about this scene** (VQA → `/api/segments/:id/vqa`), **Edit by myself** (split/delete/move/caption/undo-redo via `applyAndSave`), **Ask AI to edit** (confirm-first dialog → `/api/projects/:id/ai-edit`), **Ask helper to edit** (→ `onCreateTask`).
- **Accent:** purple `#9B59B6` (Probe 3), replacing the old green.

## Target helper UX

The helper was ported from the current `DecoupledHelperDevice`, so it is structurally close. Changes: align accent/card styling to Probe 3's helper (orange/purple cards), keep the colour persistence + announcements already added, keep deferring suggestion-feed items. No structural rebuild.

## Components to port (from `video-collab-probe/src/`, strip study-only)

Read each real file end-to-end before porting:
- `components/shared/SceneBlockList.jsx` (the list: expand/collapse, auto-follow, swipe, focus, edit-stamp + kept-scene rendering, render-prop for actions)
- `components/shared/SceneBlock.jsx` (one scene block)
- `components/shared/DetailLevelSelector.jsx` (3-button picker; `utils/detailLevels.js` for `LEVELS`)
- its small deps as needed: `GlobalControlsBar.jsx`, `PlainScreenReaderAction.jsx`, `utils/descriptionAddenda.js`
- the Probe 2b per-scene actions (Ask AI / Edit by Myself / Ask AI to Edit / Ask Helper) — port the action UI structure, wired to this app's handlers (NOT the probe's WS/WoZ). Reference `Probe3Page.jsx` creator branch for how they compose.

## Adaptation contract (same discipline as the 1c port)

| Strip / replace | With |
|---|---|
| `EventLoggerContext` / `logEvent` / `eventTypes` / `Actors` | delete |
| `webrtcService` / WS sends / `window.__*` WoZ | the app's `applyAndSave`/`onCreateTask`/`channel`/`serverPost` |
| `condition` props/branches, researcher/awareness telemetry (`onAwarenessViewed`) | delete (Phase 3/study-only) |
| AI-suggestion props (`sceneIndicesWithSuggestions`, suggestion routing, `AIAnalysisTriggerCard`) | omit (Phase 3) |
| scene data shape (probe `segments`/`scenes`) | this app's `state.clips` + `descriptions[rootSegmentId(clip.id)]?.[level]` |
| probe import paths | this repo's paths |
Keep identical: SceneBlockList expand/auto-follow/focus/swipe behavior, DetailLevelSelector's unusual SR contract, edit stamps, the keyboard model, earcons/TTS/announce, modal focus-trap (`useRootInert`) for the action sub-panels, undo/redo local stacks (non-rebasable via `applyAndSave(..., { rebasable: false })`).

The realtime/data wiring (props from `EditorPage`: `state`, `version`, `sources`, `descriptions`, `tasks`, `applyAndSave`, `channel`, `remote`, `onCreateTask`, `onSetTaskStatus`, `syncDown`) does NOT change. The new creator UI consumes the same bundle the current one does.

## Error handling / a11y

- Unchanged from 1c: optimistic apply + rebase-safe opFns (id-based, pure); undo/redo non-rebasable; AI confirm sentence composed deterministically client-side (never Gemini's summary); VQA/AI failures spoken as recoverable.
- Accessibility is the product: preserve the probe's SR contracts verbatim (DetailLevelSelector focus behavior, SceneBlock focus-on-expand, announce() on level/play/edit, 44px+ targets, keyboard operability, auto-follow focus move).

## Testing

- Unit (vitest): SceneBlockList/SceneBlock/DetailLevelSelector behavior (expand/collapse, level pick changes description, auto-follow expands next at boundary, edit-stamp render, kept-scene dimming); CreatorDevice — scene actions wired (delete opFn by id; Ask Helper → onCreateTask with scene label; Ask AI happy/clarification; VQA announced; Play this scene vs Play from here drive the engine with/without boundary stop).
- The existing two-browser **Playwright smoke must be updated to the new DOM** (the creator now drives an inline scene list, not a modal) and must still honestly pass end-to-end against the live stack (delete propagates, task round-trip, refresh persists).
- Full `npm test` + `npm run build` green.

## Acceptance ("done means", deployed)

The creator opens the editor and sees the Probe 3 experience: pinned video, an inline list of scenes, each expandable to a 3-level detail picker + description + actions, with "Play this scene"/"Play from here", purple accent, and edit stamps — matching the current probe. All edits still sync live to the helper and survive refresh. The two-browser smoke passes against the updated UI. AI-suggestion routing is absent (Phase 3).

## Out of scope

AI-suggestion engine (Phase 3) · export/render (Phase 4) · any change to migrations, RLS, endpoints, or the realtime layer · helper structural rebuild.
