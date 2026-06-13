# Phase 3 — AI Suggestion Engine (Spike) Design

**Date:** 2026-06-13
**Status:** Approved (spike scope only — no UI ships until quality is judged)
**Author:** session with Lan

---

## Why this is a spike, not a feature

Phase 3 is the product's biggest bet: the AI proactively suggests edits instead
of only answering on request. The probe already proved the *interaction* design
(an "Analyse" trigger → three suggestions → route each to self / helper / AI).
What is **unproven in this app's data** is whether `gemini-2.5-flash`, fed *our*
processed-video artifacts (keyframes + the three-level descriptions + scene
timing), returns suggestions a blind/low-vision creator would find useful and
correct.

So this spike builds **only the generation half** end-to-end — endpoint, ported
prompt, parsing, validation, curation, and a diagnostic runner — and stops at a
hard quality gate. We run it against a real `ready` video in Lan's live project,
print the actual suggestions, and Lan judges them. **No suggestion UI ships
until that judgement passes.** If quality is thin we iterate the prompt or
escalate the model input (keyframes → full video) before committing to the
Phase 3b UI port.

This mirrors the lesson already paid for twice in this project: unit mocks hide
what only real data reveals. The diag runner against the live stack is the gate,
exactly like the two-browser Playwright smoke was for 1c.

---

## Scope

**In scope (this spike):**

- `POST /api/projects/:id/suggest` — member-checked, body `{ videoId }`, returns
  validated + curated suggestions for that video.
- Ported probe prompt `three_suggestions_generation.txt` → `server/src/prompts/suggestions.txt`.
- A suggestions service: load the video's ordered scenes + level-1/2/3
  descriptions + keyframes, build the prompt, call Gemini (injected model),
  parse, **validate each suggestion**, **curate** down to ≤3 distinct-scene
  suggestions, return them.
- `scripts/diag-suggest.mjs` — runs the real endpoint logic against a real
  `ready` video and prints suggestions for Lan to judge.
- Unit tests for the service + route with a fake model (no network), matching
  the existing `aiEdit.test.js` / `aiEditData.test.js` discipline.

**Explicitly OUT of scope (deferred to Phase 3b, separate spec):**

- Any UI: the `AIAnalysisTriggerCard`, the per-scene suggestion surfacing, the
  three-channel routing (self / helper / AI), the `suggestionResolutions`
  state, persistence of suggestions, realtime broadcast of them.
- Acting on a suggestion (applying a `fix_template`, sending to helper, etc.).
  The spike returns suggestions; it does not wire them to the editor.
- The larger `suggestion_bank_generation.txt` flow. We use the
  three-suggestion prompt only.

---

## Architecture

Follows the existing AI-edit slice exactly (same files, same shapes, same
injected-model testability), so it slots into the codebase with no new patterns.

```
server/src/
  prompts/
    suggestions.txt              NEW  — verbatim port of probe three_suggestions_generation.txt
  services/
    suggestions.js               NEW  — proposeSuggestions(model, scenes, descriptionsById, keyframes)
                                          + parse + validate + curate (pure, unit-tested)
    suggestionsData.js           NEW  — loadVideoForSuggestions(supabase, projectId, videoId):
                                          ordered scenes + per-level descriptions + keyframe bytes
  routes/
    suggest.js                   NEW  — POST /api/projects/:id/suggest (member-checked)
  app.js                         EDIT — mount makeSuggestRoutes(supabase)
scripts/
  diag-suggest.mjs               NEW  — live runner against a real ready video
```

### Data flow

1. **Route** (`suggest.js`) authenticates (`requireAuth`), confirms the project
   exists and the caller is a `project_members` row (404 / 403 — copied from
   `aiEdit.js`). Validates the body: `videoId` is a non-empty string.
2. **Data loader** (`suggestionsData.js`, `loadVideoForSuggestions`):
   - Confirm the video belongs to this project and is `status = 'ready'`
     (else `400 video_not_ready` / `404 video_not_found` — never leak another
     project's video).
   - Load `segments` for the video ordered by `idx`. Each scene carries
     `{ idx, start_seconds, end_seconds, label, keyframe_path }`.
   - Load `descriptions` for those segments (levels 1/2/3), keyed by segment id.
   - Download each scene's keyframe JPEG from the `videos` storage bucket
     (`keyframe_path`) and base64-encode it — the multimodal input.
   - Cap at a sane scene count (e.g. 40) to bound prompt + token size; if the
     video has more, sample/truncate and the diag run logs that it did.
3. **Service** (`suggestions.js`, `proposeSuggestions`):
   - Build the prompt: the ported template + a **scenes block** listing each
     scene by **zero-based index** (the probe contract), its timing, label, and
     level-1/2/3 descriptions. (Level-1 = short, used in the line; levels 2/3
     appended so the model has the detail the probe's "refined descriptions"
     gave it.)
   - Call `model.generateContent([ ...keyframeParts, { text: prompt } ])`. The
     keyframes are sent as `inlineData` image parts (same mechanism as
     `describeKeyframe`). Start with **keyframes + descriptions**; the design
     note records that if quality is thin the documented next lever is to send
     the full video file instead of keyframes.
   - Parse JSON (reuse the fenced-JSON cleaner pattern), one retry with a
     "valid JSON only" nudge (same as `describeKeyframe`).
   - **Validate** each suggestion (see below). Malformed ones are dropped, not
     fatal.
   - **Curate** with the probe's exact rule: priority `issue > structural >
     creative`, ≤3, no two share a scene (port of `curateSuggestions.js`).
   - Return `{ suggestions: [...] }`. On total model failure return
     `{ suggestions: [] }` (the spike never throws a 500 for a bad model reply;
     the diag run surfaces the emptiness).

### Validation rules (per suggestion)

A suggestion is **kept** only if all hold; otherwise it is dropped:

- `category` ∈ `issue | structural | creative`.
- `text` is a non-empty string, trimmed, capped (e.g. 300 chars).
- `relatedScene` is an integer (or array of integers) and **every** referenced
  index is in `[0, sceneCount)`. (Out-of-range = hallucinated scene → drop.)
- `prototype_action` ∈ the probe action set
  (`brightness | contrast | saturation | zoom | rotate | mute | unmute |
  trim_start | trim_end | split | delete | reorder | move_earlier | move_later |
  add_caption | add_sound | remove_sound`).
- If `fix_template` is present:
  - `fix_template.action` ∈ the **AI-fixable** subset
    (`brightness | contrast | saturation | zoom | rotate | mute | unmute`).
  - `fix_template.value` is in range for that action:
    brightness/contrast/saturation `-100..100`, zoom `100..250`,
    rotate `-180..180`, mute `=== true`, unmute `=== false`.
    Out-of-range value → drop the `fix_template` (keep the suggestion as a
    creator/helper action) rather than dropping the whole suggestion.
  - `fix_template.label` is a non-empty string, capped (e.g. 60 chars).

These bounds are deliberately the **same** numbers the editor's colour/zoom/
rotate/mute ops already accept, so a kept `fix_template` is guaranteed
applicable when Phase 3b wires it up. The action set is centralised as an
exported constant (mirrors `AI_EDIT_OPS`) so the prompt, the validator, and
the future apply-path cannot drift.

### Error handling

| Condition | Response |
|---|---|
| Not authenticated | 401 (via `requireAuth`) |
| Project missing | 404 `project_not_found` |
| Caller not a member | 403 `not_a_member` |
| `videoId` missing/blank | 400 `bad_request_body` |
| Video not in this project | 404 `video_not_found` |
| Video not `ready` | 400 `video_not_ready` |
| `GEMINI_API_KEY` unset | 500 `server_misconfigured` |
| Model errors / unparseable / all dropped | 200 `{ suggestions: [] }` |

The empty-array-on-model-failure choice is intentional for a spike: a creator
asking for suggestions should never get a hard error; an empty result is a
quiet "nothing to suggest", and the diag run is where we see *why* it was empty.

---

## Testing

**Unit (fake model, no network) — the merge gate:**

- `suggestions.test.js`:
  - Valid model reply → parsed, validated, curated to ≤3 distinct scenes,
    priority-ordered.
  - Out-of-range `relatedScene` dropped.
  - Bad `category` dropped.
  - `fix_template` with out-of-range value → suggestion kept, template stripped.
  - Unknown `fix_template.action` → template stripped.
  - Unparseable model text → retry, then `{ suggestions: [] }`.
  - Curation: 5 valid suggestions across 2 scenes → exactly 2 returned (distinct
    scenes), issue before creative.
- `suggestionsData.test.js`: ordered-by-idx scenes; descriptions keyed by level;
  foreign video rejected; non-`ready` video rejected. (Supabase fake in the
  style of `aiEditData.test.js`.)
- `suggest.test.js` (route): 401 unauth, 404 missing project, 403 non-member,
  400 bad body, 200 happy path with an injected fake `propose` + fake loader.

**Live (the quality gate — run once, judged by Lan):**

- `scripts/diag-suggest.mjs`: `node --env-file=server/.env scripts/diag-suggest.mjs <videoId>`
  (or auto-pick the most recent `ready` video in a given project). Runs the real
  loader + real Gemini, prints each suggestion: category, text, scene index +
  that scene's label/timing, `prototype_action`, and `fix_template` if any.
  Prints a one-line note if scenes were truncated or any suggestion was dropped
  in validation. This is what Lan reads to judge quality. **It is never run in
  CI and never gates the build** — it is a human-judgement instrument.

---

## The hard gate (end of spike)

After the unit tests pass and the diag run prints real suggestions:

> Lan reads the suggestions for a real video and judges: are these useful,
> correct, and grounded (no invented detail)? **If yes** → Phase 3b (UI port:
> trigger card + three-channel routing + per-scene surfacing) gets its own spec.
> **If no** → iterate the prompt and/or escalate the model input to full-video,
> re-run the diag, judge again. The UI is not built until this passes.

---

## Constraints carried from the project (non-negotiable)

- `scripts/diag-smtp.mjs` is never staged/committed.
- The probe repo is read-only — the prompt is *copied*, never edited in place.
- `gemini-2.5-flash` via the injected-model pattern so the service is unit-tested
  without network.
- Commit messages end `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- No new env vars (reuses `GEMINI_API_KEY` / `GEMINI_MODEL`).
- No live DB writes — the spike only reads segments/descriptions/keyframes.
