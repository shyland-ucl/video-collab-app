# Phase 3b — AI Suggestion UI + Routing Design

**Date:** 2026-06-13
**Status:** Approved (decisions below confirmed with Lan)
**Builds on:** the Phase 3 spike (`2026-06-13-phase3-ai-suggestions-design.md`) — the generation half (`POST /api/projects/:id/suggest`) ships already and its quality was judged good on real footage.

---

## What this adds

The probe's user-tested Phase 3 interaction, ported into this app: the creator taps **"Analyse with AI"**, the curated suggestions (≤3, one per scene) surface **inline per-scene**, and each carries three routing buttons — **I'll fix it / Ask helper to fix it / Ask AI to fix it** — that collapse into a live **resolution badge** (pending → applied/failed). The helper sees the same suggestions as a read-only list with live badges.

## The two decisions that shaped this (confirmed)

1. **"Ask AI to fix it" = confirm-first, then apply for real.** The probe's AI route is Wizard-of-Oz (a researcher applies it; the probe's `applyFixTemplate` is dead code). This app has a real apply path, so the AI route produces a proposal, `ConfirmAiEditDialog` speaks a deterministic sentence, and on confirm it applies through the existing `applyAndSave` — preserving the 1c invariant that no AI edit changes the video without a spoken confirmation.
2. **Persist to Supabase.** Suggestions + resolutions live in a new `suggestions` table (migration `0010`), survive reload, fan out over Realtime (helper sees them + live badge updates), and are queryable for study analysis.

---

## Architecture

Every channel reuses a seam that already exists — no new backend patterns beyond the persistence table.

```
supabase/migrations/
  0010_suggestions.sql            NEW — suggestions table + RLS + realtime publication

server/src/
  services/suggestionsData.js     EDIT — include each scene's segmentId (stable scene ref)
  services/suggestions.js         (unchanged generation/validation/curation)
  routes/suggest.js               EDIT — on generate, resolve relatedScene→segmentId and
                                          PERSIST curated suggestions (service-role insert),
                                          return the persisted rows (with db ids)

web/src/lib/editor/
  suggestionsApi.js               NEW — listSuggestions(projectId, videoId),
                                          requestSuggestions(projectId, videoId) [calls /suggest],
                                          setSuggestionResolution(id, {routedTo, outcomeStatus, taskId})
  projectChannel.js               EDIT — add a `suggestions` postgres_changes subscription

web/src/pages/EditorPage.jsx      EDIT — load suggestions, subscribe, announce; on a linked
                                          task status change, map it onto the suggestion outcome

web/src/components/editor/
  AIAnalysisTriggerCard.jsx       NEW — the Analyse trigger (3 states) + helper read-only list
  SuggestionItem.jsx              NEW — one per-scene card: text + 3 route buttons / resolution badge
  CreatorDevice.jsx               EDIT — mount the trigger above SceneBlockList; render a
                                          SuggestionItem per scene via the existing renderSceneActions seam
  HelperDevice.jsx                EDIT — render the read-only suggestion list with live badges
  suggestionRouting.js            NEW — pure mapping helpers (relatedScene→clip, task status→outcome,
                                          fix_template→opFn + deterministic confirm sentence)
```

### Data model — `suggestions` table (migration 0010)

One row per curated suggestion. The resolution is mutable columns on the same row (one suggestion ⇒ one resolution).

| column | type | notes |
|---|---|---|
| `id` | uuid PK (default gen_random_uuid) | |
| `project_id` | uuid NOT NULL → projects(id) on delete cascade | |
| `video_id` | uuid NOT NULL → videos(id) on delete cascade | which video was analysed |
| `model_suggestion_id` | text | the model's `sug_001` (audit only) |
| `category` | text CHECK in (issue, structural, creative) | |
| `text` | text NOT NULL | |
| `related_scene` | int NOT NULL | zero-based block index at generation |
| `segment_id` | uuid → segments(id) on delete set null | **stable** scene ref (resolved server-side) |
| `prototype_action` | text NOT NULL | |
| `fix_template` | jsonb | null for non-AI-fixable |
| `routed_to` | text CHECK in (self, helper, ai) | null until routed |
| `outcome_status` | text CHECK in (pending, applied, failed) | null until routed |
| `task_id` | uuid → tasks(id) on delete set null | set when routed to helper |
| `created_at` | timestamptz default now() | |
| `resolved_at` | timestamptz | set when first routed |
| `resolved_by` | uuid → auth.users(id) | |

**RLS** (mirrors tasks): `is_project_member(project_id)` for SELECT and UPDATE. **No member INSERT policy** — only the server (service-role, bypasses RLS) inserts on generation, so members can't forge suggestions. Add the table to the `supabase_realtime` publication.

**Why a new table, not `project_state`:** suggestions are not pure re-derivable edit ops, so they can't ride `saveWithRebase` (they'd be clobbered/duplicated on a version conflict) and would bloat every state snapshot. A dedicated table is clean, queryable, and realtime-able.

### Generation + persistence flow (`suggest.js`)

1. Member-check (unchanged). Load the video (loader now also returns each scene's `segmentId`).
2. `proposeSuggestions` → curated `{ suggestions }` (unchanged).
3. For each suggestion, resolve `related_scene` → `loaded.scenes[related_scene].segmentId`.
4. **Delete any prior suggestions for this `(project_id, video_id)`** then service-role INSERT the new curated set (re-analysing replaces the old set — keeps "one analysis per video" semantics and avoids dupes).
5. Return the persisted rows (with db ids) as `{ suggestions: [...] }`.

### The three routing channels (client)

`suggestionRouting.js` holds the pure mappings; the device wires them to existing handlers.

- **I'll fix it (`self`)** → `setSuggestionResolution(id, {routedTo:'self', outcomeStatus:'pending'})`, focus that scene's existing self-edit control, announce "Edit by myself opened for {scene}." (Probe parity — no auto-completion signal; stays `pending`.)
- **Ask helper (`helper`)** → `onCreateTask({ text: suggestion.text, segmentLabel: clip.name })` (existing tasks path + realtime), then `setSuggestionResolution(id, {routedTo:'helper', outcomeStatus:'pending', taskId: task.id})`. When that task's status later changes, EditorPage maps it onto the suggestion: `done→applied`, `cant_do→failed`, `needs_discussion→pending` — and updates the suggestion row (fixing the probe's response-vocabulary mismatch by using this app's task vocabulary).
- **Ask AI (`ai`)** → confirm-first:
  - **fix_template present** (brightness/contrast/saturation/zoom/rotate/mute/unmute) → build the op directly (`suggestionRouting.fixTemplateToOpFn`) + a deterministic confirm sentence → `ConfirmAiEditDialog`.
  - **no fix_template** (split/delete/trim/caption/reorder/sound) → `serverPost('/api/projects/:id/ai-edit', { request: suggestion.text, focused_clip_id: clip.id, clips })` → proposal → `describeProposal` → `ConfirmAiEditDialog`.
  - On **confirm** → `applyAndSave(opFn, doneSentence)` → `setSuggestionResolution(id, {routedTo:'ai', outcomeStatus:'applied'})`; on a save conflict → `outcomeStatus:'failed'`. On **cancel** → no resolution written (card returns to its three buttons).

### Stale-scene handling

`related_scene` is a block position at generation time; edits can shift it. We persist `segment_id` (stable) and on the client attach each suggestion to the clip whose `rootSegmentId(clip.id) === suggestion.segment_id`. If no such clip exists (scene deleted), the card is not rendered. So a suggestion never points at the wrong scene after a split/delete/reorder.

### Realtime + announcements

- `projectChannel` gains a `suggestions` postgres_changes subscription (`onSuggestionChange`).
- EditorPage: on analysis the creator loads suggestions; INSERTs fan out so the **helper** shows the read-only list. Resolution UPDATEs flip badges on both devices live.
- Announcements (existing `#sr-announcer`): trigger → ~3s beat + 880 Hz earcon + "AI analysis complete, N suggestions"; each route → a deterministic line; AI-applied/helper-outcome → the existing announce paths. Resolution badge has a terse aria-label (routing + outcome only) so the suggestion text isn't re-read.

---

## Accessibility (carried verbatim from the probe)

- Trigger button ≥48px, aria-label "Trigger AI analysis of this video"; in-progress is an `aria-live=polite` card with aria-hidden animation; ~3s simulated-thinking beat; 880 Hz/200ms completion earcon; on complete the creator's focus moves to the first suggested scene.
- Suggestion cards: category badge + "Scene N" chip `aria-hidden` so the text is read once; 3 full-width buttons ≥44px with visible focus rings; mandatory routing (no dismiss — matches the shipped probe).
- Resolution badge: `tabIndex=-1`, terse `aria-label` (`"{routedLabel}. {outcome}."`); ambient outcome updates are read-only and never re-steal focus (probe's `justRouted` pattern).

## Error handling

| Condition | Behaviour |
|---|---|
| `/suggest` returns `{ suggestions: [] }` | announce "No suggestions this time"; card area stays empty |
| `/suggest` HTTP error | announce assertively "Couldn't analyse the video — try again"; trigger re-enabled |
| Ask-AI proposal is a `clarification` / invalid | announce it; leave the card unrouted (no resolution) |
| Ask-AI `applyAndSave` conflict/failure | `outcome_status:'failed'`, announce the existing SAVE_FAILED text |
| helper-task creation fails | announce "The task could not be sent — try again"; no resolution written |
| suggestion's `segment_id` no longer maps to a clip | card not rendered (stale scene) |

---

## Testing

**Unit / component (the merge gate):**
- `suggestionRouting.test.js` (pure): relatedScene→clip via rootSegmentId (incl. split clips + deleted→null); task status→outcome map; fix_template→opFn + deterministic confirm sentence for each AI-fixable action.
- `suggestionsApi.test.js`: list/request/setResolution against a fake supabase + serverPost.
- `AIAnalysisTriggerCard.test.jsx`: 3 states; trigger fires onTrigger once; helper variant renders a read-only list; a11y attributes.
- `SuggestionItem.test.jsx`: renders text + 3 buttons; each button calls the right handler; after a resolution prop it shows the badge with the terse aria-label and hides the buttons; mandatory routing (no dismiss).
- server `suggest.test.js` (extend): persists the curated set (service-role insert spy), resolves segmentId, replaces a prior set, returns rows with ids; `suggestionsData.test.js`: scene objects include `segmentId`.

**Live (acceptance):**
- Extend the two-browser Playwright smoke (`npm run e2e`): creator taps Analyse → ≥1 suggestion card appears on a scene; route one to AI → confirm dialog → applied badge + the scene actually changes; route one to helper → helper sees the task, marks done → creator's badge flips to applied; reload → suggestions + resolutions persist.
- `scripts/diag-suggest.mjs` stays the generation gate.

---

## Out of scope (future)

- Re-analysis freshness/invalidation when edits make a suggestion stale (we replace the whole set on re-analyse; we don't auto-invalidate individual suggestions mid-session).
- Rate limiting on `/suggest` (still inherited-absent; flagged in the spike spec — add before heavy use).
- A "mark my self-fix done" completion signal (self routes stay `pending`, as in the probe).

## Constraints (non-negotiable, carried from the project)

- `scripts/diag-smtp.mjs` never staged/committed; probe repo read-only; `gemini-2.5-flash` via injected model; commit messages end `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; `npx supabase db push --yes` = LIVE (migration 0010 is additive — a new table + policies, no destructive change).
