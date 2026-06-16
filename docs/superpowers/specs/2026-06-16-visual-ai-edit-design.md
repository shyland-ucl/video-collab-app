# Visual edits in "Ask AI to Edit"

**Date:** 2026-06-16
**Status:** Design — approved, pending implementation plan

## Problem

"Ask AI to Edit" can only propose 7 **structural** ops (delete, split, move
earlier/later, add caption, trim start/end). Its prompt explicitly redirects
colour, zoom, rotate, and audio requests to a clarification — so a creator who
asks "brighten this scene" or "rotate this sideways clip" gets a non-answer,
even though the editor (and the separate AI *suggestions* feature) already apply
exactly those fixes.

## Goal

Give "Ask AI to Edit" full parity with the editor's fixable actions: it can also
propose **brightness, contrast, saturation, zoom, rotate, mute, unmute** with an
AI-chosen, range-validated value — reusing the existing suggestions "fix"
machinery so behaviour and wording stay consistent. The confirm-first flow and
the deterministic, value-stating confirmation sentence are preserved. Structural
ops and the suggestions feature itself are unchanged.

## Approach (chosen)

**Value model:** the AI picks a *specific* value (brightness +30, zoom 150%,
rotate 90°…), validated against the existing ranges. This matches how
suggestions already work and is essential for rotate (orientation fixes are
discrete). Out-of-range or missing value → clarification (never guess/clamp
silently into a surprising edit).

**Reuse, don't rebuild:**
- Client apply: `fixTemplateToOpFn(fixTemplate, clipId)` (already maps
  `{action,value}` → the colour-map transform or mute op).
- Client confirm sentence: `describeFixTemplate(fixTemplate, clipName)` (already
  produces deterministic, value-stating BLV-safe sentences for all 6).
- Server validation: the value-range logic in `suggestions.js`
  (`FIX_VALUE_RANGES`, the numeric checks inside `cleanFixTemplate`).

Considered and rejected: (a) AI picks direction only with a fixed step — less
expressive and rotate needs a real value; (b) duplicating value handling in the
ai-edit path — needless divergence from the suggestions wording/validation.

## Scope

**In scope**
- Server: extend the ai-edit op allow-list + prompt + validation for the 6 ops.
- Client: route the 6 ops through `fixTemplateToOpFn` / `describeFixTemplate`.
- Extract the shared value-range validator so suggestions + ai-edit use one copy.

**Out of scope**
- Any visual op beyond the 6 already supported by the editor.
- Structural ai-edit ops (unchanged).
- The suggestions feature's behaviour (only the shared validator is extracted;
  its outputs must be identical).
- Letting the AI batch multiple ops (still exactly one op per request).

## Architecture & data flow

Endpoint and flow are unchanged (`POST /api/projects/:id/ai-edit`, confirm-first
on the client). The deltas:

**Server** (`server/src/services/aiEdit.js`, `server/src/prompts/ai_edit.txt`)
1. `AI_EDIT_OPS` gains `brightness, contrast, saturation, zoom, rotate, mute,
   unmute` (→ 13 total).
2. Prompt: replace the "redirect colour/audio/effects to a clarification" rule
   with guidance that these ARE supported and need a value; state the ranges
   (brightness/contrast/saturation −100…100, zoom 100…250, rotate −180…180;
   mute/unmute take no value). Keep "ask for clarification if ambiguous" and the
   one-op-per-response rule.
3. `validateProposal`: for the 5 numeric ops, require `params.value` finite and
   in range (via the shared validator); reject (→ clarification) otherwise. For
   `mute`/`unmute`, force `params: {}`. Output whitelist for numeric ops becomes
   `{ op, target_clip_id, params: { value }, summary }`.

**Client** (`web/src/components/editor/ConfirmAiEditDialog.jsx`)
- `proposalToOpFn`: for the 6 ops, build `fixTemplate = { action: op, value:
  params.value }` (mute/unmute → `value: action === 'mute'`) and return
  `fixTemplateToOpFn(fixTemplate, target_clip_id)`. Structural ops unchanged.
- `describeProposal`: for the 6 ops, return `describeFixTemplate({ action: op,
  value }, clipName)`. Structural ops keep their existing cases.
- Import both helpers from `web/src/lib/editor/suggestionRouting.js`.

## Components & interfaces

- **NEW `server/src/services/fixActions.js`** (shared, pure): export
  `AI_FIXABLE_ACTIONS`, `FIX_VALUE_RANGES`, and `cleanFixValue(action, value)` →
  returns the validated value (or `true/false` for mute/unmute), or `null` if
  out of range / wrong type. `suggestions.js` `cleanFixTemplate` is refactored to
  use `cleanFixValue` (its outputs MUST stay identical — existing suggestions
  tests are the guard). `aiEdit.js` `validateProposal` uses `cleanFixValue` for
  the visual ops. No label coupling (label is suggestion-only).
- **`aiEdit.js`**: extend `AI_EDIT_OPS`; branch `validateProposal` on visual vs
  structural ops.
- **`ai_edit.txt`**: reworded ops list + ranges + drop the colour/audio redirect.
- **`ConfirmAiEditDialog.jsx`**: visual branch in `proposalToOpFn` +
  `describeProposal`, importing the two `suggestionRouting` helpers.

## Confirmation & safety (unchanged guarantees)

- Confirm-first: nothing applies until the creator confirms.
- Deterministic, value-stating sentence via `describeFixTemplate` (e.g.
  "Increase the brightness on Scene 2? … Review the frame to confirm.") — never
  the model's free text alone. Same sentences suggestions already use.
- Range validation blocks extreme/garbage values server-side.
- Reject / network failure / undescribable proposal → no change (existing paths).
- Synergy: clip-based descriptions (just shipped) give the AI better signal to
  *spot* visual issues ("scene is underexposed → brighten").

## Testing

- **`fixActions` (new)**: `cleanFixValue` enforces each range; mute/unmute → bool;
  out-of-range/NaN → null.
- **`suggestions.test`**: unchanged + still green (proves the refactor preserved
  `cleanFixTemplate` behaviour).
- **`aiEdit.test`**: a `brightness` proposal with in-range value validates to
  `{op:'brightness', params:{value:N}, summary}`; out-of-range value →
  clarification; `mute` → `params:{}` valid; an unsupported op still →
  clarification.
- **`ConfirmAiEditDialog` / routing test**: `proposalToOpFn` for `brightness`
  yields a transform setting `colour[root].brightness = value`; for `mute` toggles
  mute; `describeProposal` for `zoom` returns the zoom sentence.
- **End-to-end (`SceneActions` AI path)**: "make scene 2 brighter" → brightness
  proposal → confirm → `applyAndSave` persists the colour.

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Extracting the shared validator breaks suggestions | `suggestions.test` must stay green; `cleanFixTemplate` keeps identical outputs |
| AI picks a poor value | Confirm-first + value-stating sentence + "review the frame" + range clamp |
| mute/unmute is audio, not "visual" | Included for parity (user chose all six); valueless, handled distinctly |
| Server/client op lists drift | Both derive the visual op set from `AI_FIXABLE_ACTIONS` (single source) |

## Rollout

Additive and confirm-first, so safe without a flag. The prompt change is the
only behavioural shift; if it ever misbehaves, reverting `ai_edit.txt` + the
allow-list entries restores structural-only behaviour.
